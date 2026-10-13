import { matchingLines } from '../agent/review/search';
import { Script } from 'vm';
import { ReviewDashboardProvider, defaultLlmWikiDashboardState } from '../reviewDashboard';
import { ReviewCheckpointStore } from '../agent/review/checkpoints';
import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { AgentRunner, AgentRunCheckpoint, AgentPauseError } from '../agent/runtime';
import { CodeReviewAgentService, AiReviewPartialError, StoredAiReview } from '../agent/codeReview';
import { LiveReviewIndex, page, hash } from '../agent/review/live';
import { BudgetClient, compactContext } from '../agent/review/context';
import { childResultSchema, rolePrompt, toolSchemas, validate } from '../agent/review/schema';
import { LlmApiError, LlmClient, LlmJsonRequest, LlmMessage } from '../llm/client';
import { computeLineDiff } from '../diffEngine';
import { ReviewFileState, ReviewSession } from '../types';
const config = { provider: 'deepseek' as const, baseUrl: 'https://example.test', model: 'test', apiKey: 'secret', contextWindowTokens: 128000, compressionThresholdPercent: 40, maxOutputTokens: 12000 };
const final = (result: unknown) => ({ content: JSON.stringify({ type: 'final', result }), toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 } });
const call = (name: string, args: unknown, id = 'call') => ({ content: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }], usage: { inputTokens: 10, outputTokens: 10 } });
const lastTool = (request: LlmJsonRequest) => JSON.parse(request.messages!.filter((message) => message.role === 'tool').at(-1)!.content).result;
async function fixture() {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-agent-'));
 const uri = vscode.Uri.file(path.join(dir, 'hello.ts'));
 const oldText = 'console.log("hello");\n', newText = 'console.log("world");\n';
 await fs.writeFile(uri.fsPath, newText);
 const file: ReviewFileState = { uri, relativePath: 'hello.ts', oldText, newText, hunks: computeLineDiff(uri.toString(), oldText, newText), acceptedHunks: [], rejectedHunks: [], appliedAiSuggestions: [], originalText: oldText, originalExists: true, baselineExists: true, currentExists: true, revision: 0 };
 const session: ReviewSession = { id: 'test', mode: 'git', rootUri: vscode.Uri.file(dir), createdAt: Date.now(), files: new Map([[uri.toString(), file]]) };
 const root = { uri: session.rootUri, name: 'test', index: 0 };
 return { dir, file, session, root, dispose: () => fs.rm(dir, { recursive: true, force: true }) };
}
suite('Main review architecture', () => {
 test('exposes exactly 14 strict tools and gives Review its own full result schema', () => {
  assert.strictEqual(Object.keys(toolSchemas).length, 14);
  for (const schema of Object.values(toolSchemas)) { assert.deepStrictEqual(schema.required, Object.keys(schema.properties!)); assert.strictEqual(schema.additionalProperties, false); }
  assert.ok(rolePrompt('Review', 'zh-CN').includes(JSON.stringify(childResultSchema('Review'))));
  assert.throws(() => validate(toolSchemas.Read, { path: 'x', offset: 0, limit: 10, cursor: null }));
 });
 test('binds cursors to query and content and preserves long lines across pages', () => {
  const text = 'a'.repeat(25000), a = page(text, 'query', null), b = page(text, 'query', a.nextCursor), c = page(text, 'query', b.nextCursor);
  assert.strictEqual(a.text + b.text + c.text, text); assert.strictEqual(c.nextCursor, null);
  assert.throws(() => page(text + 'changed', 'query', a.nextCursor));
  assert.throws(() => page(text, 'another-query', a.nextCursor));
 });
 test('rejects changed evidence and escaping paths while allowing dot configuration', async () => {
  const f = await fixture();
  try {
   const index = new LiveReviewIndex(f.dir, f.session, { revision: 0, versions: {}, evidence: {} }); await index.scan();
   const result = await index.readTool('Read', { path: 'hello.ts', offset: 1, limit: 1, cursor: null }) as { evidenceRef: string };
   await index.verifyEvidence({ evidenceRef: result.evidenceRef, side: 'new', startLine: 1, endLine: 1 });
   await fs.writeFile(f.file.uri.fsPath, 'changed\n');
   await assert.rejects(index.verifyEvidence({ evidenceRef: result.evidenceRef, side: 'new', startLine: 1, endLine: 1 }), /changed/);
   await assert.rejects(index.safePath('../outside'), /inside/);
   await fs.writeFile(path.join(f.dir, '.editorconfig'), 'root=true');
   assert.strictEqual(await index.read('.editorconfig'), 'root=true');
  } finally { await f.dispose(); }
 });
 test('checkpoints a tool response before effects and resumes only unfinished calls', async () => {
  let checkpoint: AgentRunCheckpoint | undefined, first = 0, second = 0, requests = 0;
  const client: LlmClient = { completeJson: async () => '', complete: async () => { requests++; return requests === 1 ? { content: '', toolCalls: [call('one', {}, 'a').toolCalls[0], call('two', {}, 'b').toolCalls[0]] } : final({ done: true }); } };
  const options = { config, client, systemPrompt: 'test', userPrompt: 'test', tools: [{ name: 'one', description: '', parameters: { type: 'object', properties: {} }, execute: async () => { assert.ok(checkpoint?.pending); first++; return {}; } }, { name: 'two', description: '', parameters: { type: 'object', properties: {} }, execute: async () => { second++; if (second === 1) { throw new AgentPauseError('pause'); } return {}; } }], onCheckpoint: (value: AgentRunCheckpoint) => { checkpoint = JSON.parse(JSON.stringify(value)); } };
  await assert.rejects(new AgentRunner().run(options), /pause/);
  assert.strictEqual(checkpoint!.pending!.results.length, 1);
  await new AgentRunner().run({ ...options, resumeFrom: checkpoint });
  assert.strictEqual(first, 1); assert.strictEqual(second, 2); assert.strictEqual(requests, 2);
 });
 test('shares budget reservations across concurrent calls and keeps cumulative usage', async () => {
  const usage = { input: 0, output: 0, estimated: 0, reserved: 0 };
  let release!: () => void;
  const client = new BudgetClient({ completeJson: async () => '', complete: async () => { await new Promise<void>((resolve) => { release = resolve; }); return final({}); } }, usage, 200, async () => {});
  const first = client.complete({ model: 'test', messages: [], maxTokens: 150 });
  await Promise.resolve(); await Promise.resolve();
  await assert.rejects(client.complete({ model: 'test', messages: [], maxTokens: 150 }), /预算/);
  release(); await first;
  assert.strictEqual(usage.reserved, 0); assert.strictEqual(usage.input + usage.output, 20);
 });
 test('disabled compression does not pause estimated context overflow', async () => {
  const messages: LlmMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }, { role: 'user', content: 'x'.repeat(10000) }];
  const result = await compactContext({ messages, tools: [], round: 1, config: { ...config, contextWindowTokens: 4096 }, client: { completeJson: async () => { throw new Error('must not call'); } }, enabled: false, state: { lastRound: 0, lastSize: 0, count: 0 }, authoritative: {}, trace: () => {} });
  assert.strictEqual(result, false); assert.strictEqual(messages.length, 3);
 });
 test('compression validates refs atomically and retains original history on failure', async () => {
  const messages: LlmMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }, { role: 'user', content: 'x'.repeat(9000) + ' untrusted source says chunk:invented' }];
  const original = JSON.stringify(messages);
  const result = await compactContext({ messages, tools: [], round: 1, config: { ...config, contextWindowTokens: 16000 }, client: { completeJson: async () => '{"summary":"fake","refs":["chunk:invented"]}' }, enabled: true, state: { lastRound: 0, lastSize: 0, count: 0 }, authoritative: {}, trace: () => {} });
  assert.strictEqual(result, false); assert.strictEqual(JSON.stringify(messages), original);
 });
 test('compression retains task and authoritative state with a smaller history', async () => {
  const messages: LlmMessage[] = [{ role: 'system', content: 'system' }, { role: 'user', content: 'original task' }, { role: 'user', content: 'x'.repeat(9000) }];
  const result = await compactContext({ messages, tools: [], round: 1, config: { ...config, contextWindowTokens: 16000 }, client: { completeJson: async () => '{"summary":"Check remaining error handling","refs":[]}' }, enabled: true, state: { lastRound: 0, lastSize: 0, count: 0 }, authoritative: { findingIds: ['f1'] }, trace: () => {} });
  assert.ok(result); assert.strictEqual(messages[1].content, 'original task'); assert.ok(messages[2].content.includes('f1'));
 });
 test('does not classify unknown 400 errors as context overflow', () => {
  assert.strictEqual(new LlmApiError(400, '{"error":{"code":"bad_request"}}').contextExceeded, false);
  assert.strictEqual(new LlmApiError(400, '{"error":{"code":"context_length_exceeded"}}').contextExceeded, true);
  assert.strictEqual(new LlmApiError(401, 'bad key').retryable, false);
 });
 test('reviews a small change progressively and requires a saved completion receipt', async () => {
  const f = await fixture(); let round = 0, ref = '';
  try {
   const client: LlmClient = { completeJson: async () => '', complete: async (request) => {
    round++;
    assert.ok(request.tools?.some((tool) => tool.name === 'Read'));
    if (round === 1) { assert.ok(!request.messages![1].content.includes('console.log')); return call('list_changes', { path: null, cursor: null, limit: 50 }); }
    if (round === 2) { ref = JSON.parse(lastTool(request).text)[0].chunkRef; return call('read_change', { chunkRef: ref, contextLines: 0, cursor: null }); }
    if (round === 3) { return call('finish_review', { requestKey: 'finish', summary: '未发现潜在问题', directlyReviewedRanges: [{ chunkRef: ref, wholeChunk: true, side: null, startLine: null, endLine: null }], acceptedReviewResultRefs: [], unresolved: [] }); }
    const receipt = lastTool(request); return final({ reviewId: receipt.reviewId, completionRef: receipt.completionRef });
   } };
   const review = await new CodeReviewAgentService().review({ ...f, config, client, language: 'zh-CN' });
   assert.strictEqual(review.status, 'complete'); assert.strictEqual(review.summary, '未发现潜在问题'); assert.strictEqual(review.findings.length, 0); assert.strictEqual(review.agentState?.version, 2);
   assert.ok(!JSON.stringify(review).includes('sourceSnapshot'));
  } finally { await f.dispose(); }
 });
 test('actual API failure preserves a checkpoint and Continue keeps the same review ID', async () => {
  const f = await fixture(); let partial: StoredAiReview | undefined;
  try {
   await assert.rejects(new CodeReviewAgentService().review({ ...f, config, language: 'zh-CN', client: { completeJson: async () => { throw new LlmApiError(400, '{"error":{"code":"context_length_exceeded"}}'); } } }), (error: unknown) => { assert.ok(error instanceof AiReviewPartialError); partial = error.review; return true; });
   const id = partial!.agentState!.id;
   assert.ok(partial!.agentState!.tasks.main.checkpoint);
   let step = 0;
   const client: LlmClient = { completeJson: async () => '', complete: async (request) => { step++; if (step === 1) { return call('finish_review', { requestKey: 'partial-finish', summary: '需要继续调查', directlyReviewedRanges: [], acceptedReviewResultRefs: [], unresolved: [{ chunkRef: null, reason: 'Unreviewed' }] }); } const receipt = lastTool(request); return final({ reviewId: receipt.reviewId, completionRef: receipt.completionRef }); } };
   const continued = await new CodeReviewAgentService().review({ ...f, config, client, language: 'zh-CN', existingReview: partial });
   assert.strictEqual(continued.agentState!.id, id); assert.strictEqual(continued.status, 'partial'); assert.ok(continued.agentState!.usage.input > partial!.agentState!.usage.input);
  } finally { await f.dispose(); }
 });
 test('delegates Review on demand with only read/message tools and accepts its coverage', async () => {
  const f = await fixture(); let mainRound = 0, childRound = 0, chunkRef = '', childId = '', resultRef = '';
  try {
   const client: LlmClient = { completeJson: async () => '', complete: async (request) => {
    const task = JSON.parse(request.messages![1].content);
    if (task.agentId !== 'main') {
     childRound++;
     assert.deepStrictEqual(request.tools!.map((tool) => tool.name).sort(), ['Glob', 'Grep', 'Read', 'list_changes', 'read_change', 'send_agent_message'].sort());
     assert.ok(request.messages![0].content.includes('reviewedRanges'));
     if (childRound === 1) { return call('read_change', { chunkRef, contextLines: 0, cursor: null }); }
     return final({ summary: 'Reviewed hello', findings: [], reviewedRanges: [{ chunkRef, wholeChunk: true, side: null, startLine: null, endLine: null }], unresolved: [] });
    }
    mainRound++;
    if (mainRound === 1) { return call('list_changes', { path: null, cursor: null, limit: 50 }); }
    if (mainRound === 2) { chunkRef = JSON.parse(lastTool(request).text)[0].chunkRef; return call('spawn_agent', { role: 'Review', objective: 'Review hello', scope: { paths: ['hello.ts'], chunkRefs: [chunkRef] }, contextRefs: [], requestKey: 'child' }); }
    if (mainRound === 3) { childId = lastTool(request).agentId; return call('wait_agents', { agentIds: [childId], afterEventId: 0, timeoutMs: 10000 }); }
    if (mainRound === 4) { resultRef = lastTool(request).events.find((event: { kind: string }) => event.kind === '任务完成').message.resultRefs[0]; return call('read_agent_result', { resultRef, cursor: null }); }
    if (mainRound === 5) { return call('finish_review', { requestKey: 'done', summary: '未发现潜在问题', directlyReviewedRanges: [], acceptedReviewResultRefs: [resultRef], unresolved: [] }); }
    const receipt = lastTool(request); return final({ reviewId: receipt.reviewId, completionRef: receipt.completionRef });
   } };
   const review = await new CodeReviewAgentService().review({ ...f, config, client, language: 'zh-CN' });
   assert.strictEqual(review.status, 'complete'); assert.strictEqual(Object.keys(review.agentState!.tasks).length, 2); assert.strictEqual(childRound, 2);
  } finally { await f.dispose(); }
 });
 test('pauses before sixth change batch and merges paused edits on Continue without consuming quota', async () => {
  const f = await fixture(); let requests = 0, partial: StoredAiReview | undefined;
  const edit = async (value: string) => { f.file.newText = value; f.file.hunks = computeLineDiff(f.file.uri.toString(), f.file.oldText, value); await fs.writeFile(f.file.uri.fsPath, value); };
  try {
   const client: LlmClient = { completeJson: async () => '', complete: async () => { requests++; await edit(`change ${requests}\n`); return call('get_review_status', { cursor: null }, `call-${requests}`); } };
   await assert.rejects(new CodeReviewAgentService().review({ ...f, config, client, language: 'zh-CN' }), (error: unknown) => { assert.ok(error instanceof AiReviewPartialError); partial = error.review; assert.match(error.message, /第 6 批/); return true; });
   assert.strictEqual(requests, 6); assert.strictEqual(partial!.agentState!.notifications, 5);
   await edit('changed while paused\n'); let continuedRequests = 0;
   const resumed: LlmClient = { completeJson: async () => '', complete: async (request) => {
    continuedRequests++;
    if (continuedRequests === 1) {
     assert.ok(JSON.stringify(request.messages).includes('recovery_changes'));
     return call('finish_review', { requestKey: 'finish-partial', summary: 'Pending investigation', directlyReviewedRanges: [], acceptedReviewResultRefs: [], unresolved: [{ chunkRef: null, reason: 'Pending' }] });
    }
    const receipt = lastTool(request); return final({ reviewId: receipt.reviewId, completionRef: receipt.completionRef });
   } };
   const review = await new CodeReviewAgentService().review({ ...f, config, client: resumed, language: 'zh-CN', existingReview: partial });
   assert.strictEqual(review.agentState!.notifications, 0);
   assert.strictEqual(review.agentState!.id, partial!.agentState!.id);
   assert.strictEqual(review.agentState!.live.versions['hello.ts'], hash(f.file.oldText + '\0' + f.file.newText + '\0'));
  } finally { await f.dispose(); }
 });
 test('requires observed complete chunks before a whole-chunk coverage claim', async () => {
  const f = await fixture(); let round = 0;
  try {
   const client: LlmClient = { completeJson: async () => '', complete: async (request) => {
    round++;
    if (round === 1) { return call('list_changes', { path: null, cursor: null, limit: 50 }); }
    if (round === 2) { const chunkRef = JSON.parse(lastTool(request).text)[0].chunkRef; return call('finish_review', { requestKey: 'unread', summary: 'claim', directlyReviewedRanges: [{ chunkRef, wholeChunk: true, side: null, startLine: null, endLine: null }], acceptedReviewResultRefs: [], unresolved: [] }); }
    const tool = JSON.parse(request.messages!.filter((message) => message.role === 'tool').at(-1)!.content);
    assert.strictEqual(tool.ok, false); assert.match(tool.error, /fully read/);
    throw new LlmApiError(401, 'test stopped');
   } };
   await assert.rejects(new CodeReviewAgentService().review({ ...f, config, client, language: 'zh-CN' }), AiReviewPartialError);
  } finally { await f.dispose(); }
 });

 test('generates syntactically valid dashboard JavaScript with lazy logs', () => {
  const provider = new ReviewDashboardProvider(() => ({ files: [], llmWiki: defaultLlmWikiDashboardState() } as never));
  const html = (provider as unknown as { renderShell(webview: unknown): string }).renderShell({ cspSource: 'test', asWebviewUri: (uri: vscode.Uri) => uri });
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length);
  for (const script of scripts) { new Script(script[1]); }
  assert.ok(html.includes('readRunLogDetail')); assert.ok(html.includes('renderAgentTree'));
 });
 test('starts review without a configured context window', async () => {
  const f = await fixture();
  let called = false;
  try {
   await assert.rejects(new CodeReviewAgentService().review({ ...f, config: { ...config, contextWindowTokens: undefined }, language: 'zh-CN', client: {
    completeJson: async () => { called = true; throw new LlmApiError(401, 'test stop'); },
   } }), AiReviewPartialError);
   assert.strictEqual(called, true);
  } finally { await f.dispose(); }
 });
 test('renders pending files and optional model fields in a real webview', async function () {
  this.timeout(30000);
  const provider = new ReviewDashboardProvider(() => ({ files: [], llmWiki: defaultLlmWikiDashboardState() } as never));
  const panel = vscode.window.createWebviewPanel('reviewRegression', 'Review rendering regression', vscode.ViewColumn.One, { enableScripts: true });
  const html = (provider as unknown as { renderShell(webview: vscode.Webview): string }).renderShell(panel.webview);
  const nonce = html.match(/<script nonce="([^"]+)"/)![1];
  let listener: vscode.Disposable | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
   const completed = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Dashboard webview test timed out')), 25000);
    listener = panel.webview.onDidReceiveMessage(message => {
     if (message.type === 'regressionResult') { if (message.error) { reject(new Error(message.error)); } else { resolve(); } }
    });
   });
   panel.webview.html = html.replace('</body>', `<script nonce="${nonce}">
    try {
     const check = (ok, message) => { if (!ok) throw new Error(message); };
     const files = Array.from({length: 5}, (_, i) => ({ uri: 'file:///test/' + i + '.ts', relativePath: i + '.ts', fileExtension: 'ts', revision: 1, pendingCount: 1, chunks: [], statusKind: 'modified', statusLabel: 'Modified', description: '1 pending' }));
     for (const configured of [false, true]) {
      for (const aggregateProjectView of [true, false]) {
       const wiki = { ...emptyWikiState(), configured, model: 'test', workspaceAvailable: true, aggregateProjectView, pendingSourceCount: 5,
        projectAgents: [{ projectId: 'test', projectName: 'test', lifecycle: 'idle', pendingCount: 5 }] };
       render({files, llmWiki: wiki});
       check(document.querySelectorAll('#list .file-row').length === 5, 'Pending file rows missing');
       check(document.querySelector('#list .file-row').getBoundingClientRect().height > 0, 'Pending file rows hidden');
       if (aggregateProjectView) check(getComputedStyle(wikiLogo).display === 'none', 'Logo visible over project agents');
       check(getComputedStyle(document.querySelector('[data-menu-action="regenerateAiReview"]')).display === 'none', 'Unavailable menu action visible');
      }
     }
     check(!document.querySelector('[data-menu-action="compactAiReview"]'), 'Unexpected compression action');
     openNewConfig();
     for (const id of ['llmContextWindow', 'llmCompressionThreshold', 'llmMaxOutput']) {
      const input = document.getElementById(id);
      check(input.type === 'text' && !input.required, 'Model field must be optional plain text: ' + id);
      input.value = '';
      check(input.checkValidity() && optionalNumber(id) === undefined, 'Empty field must remain unset: ' + id);
     }
     vscode.postMessage({type: 'regressionResult'});
    } catch (error) { vscode.postMessage({type: 'regressionResult', error: error.stack || String(error)}); }
   </script></body>`);
   await completed;
  } finally { clearTimeout(timer); listener?.dispose(); panel.dispose(); }
 });
 test('persists histories outside workspace metadata and rejects corrupt checkpoints', async () => {
  const f = await fixture();
  try {
   let partial: StoredAiReview | undefined;
   await assert.rejects(new CodeReviewAgentService().review({ ...f, config, language: 'zh-CN', client: { completeJson: async () => { throw new LlmApiError(401, 'auth'); } } }), (error: unknown) => { assert.ok(error instanceof AiReviewPartialError); partial = error.review; return true; });
   const directory = vscode.Uri.file(path.join(f.dir, 'checkpoints'));
   const store = new ReviewCheckpointStore(directory);
   const ref = await store.save(partial!.agentState!);
   assert.deepStrictEqual(await store.load(ref), JSON.parse(JSON.stringify(partial!.agentState)));
   await fs.writeFile(path.join(directory.fsPath, ref + '.json'), '{}');
   await assert.rejects(store.load(ref), /Corrupt/);
  } finally { await f.dispose(); }
 });

 test('searches beyond the former read prefix and bounds pathological regular expressions', async () => {
  const f = await fixture();
  try {
   await fs.writeFile(f.file.uri.fsPath, 'prefix\n'.repeat(10000) + 'needle\n');
   const index = new LiveReviewIndex(f.dir, f.session, { revision: 0, versions: {}, evidence: {} });
   const result = await index.readTool('Grep', { pattern: 'needle', mode: 'literal', path: 'hello.ts', glob: null, caseSensitive: true, contextLines: 0, cursor: null }) as { text: string };
   assert.strictEqual(JSON.parse(result.text)[0].line, 10001);
   await assert.rejects(matchingLines('a'.repeat(100000) + '!', '(a+)+$', true, undefined, 100), /timed out/);
  } finally { await f.dispose(); }
 });
 test('saves a finding and an exact within-chunk suggestion without changing source', async () => {
  const f = await fixture(); let round = 0, ref = '', findingId = '';
  try {
   const client: LlmClient = { completeJson: async () => '', complete: async (request) => {
    round++;
    if (round === 1) { return call('list_changes', { path: null, cursor: null, limit: 50 }); }
    if (round === 2) { ref = JSON.parse(lastTool(request).text)[0].chunkRef; return call('read_change', { chunkRef: ref, contextLines: 0, cursor: null }); }
    if (round === 3) { const evidenceRef = JSON.parse(lastTool(request).text).new.evidenceRef; return call('submit_findings', { requestKey: 'finding', findings: [{ primaryChunkRef: ref, relatedChunkRefs: [], evidence: [{ evidenceRef, side: 'new', startLine: 1, endLine: 1 }], severity: 'warning', title: 'Test defect', explanation: 'Test evidence', recommendation: 'Test fix' }] }); }
    if (round === 4) { findingId = lastTool(request).findings[0].findingId; return call('submit_suggestions', { requestKey: 'suggestion', suggestions: [{ findingId, chunkRef: ref, edits: [{ startLine: 1, endLineExclusive: 2, expectedText: f.file.newText, replacementText: 'console.log("fixed");\n' }], rationale: 'Fix test defect' }] }); }
    if (round === 5) { assert.ok(lastTool(request).suggestionIds.length); return call('finish_review', { requestKey: 'finish', summary: 'One defect', directlyReviewedRanges: [{ chunkRef: ref, wholeChunk: true, side: null, startLine: null, endLine: null }], acceptedReviewResultRefs: [], unresolved: [] }); }
    const receipt = lastTool(request); return final({ reviewId: receipt.reviewId, completionRef: receipt.completionRef });
   } };
   const review = await new CodeReviewAgentService().review({ ...f, config, client, language: 'zh-CN' });
   assert.strictEqual(review.findings[0].id, findingId); assert.strictEqual(review.suggestions[0].replacementText, 'console.log("fixed");\n');
   assert.strictEqual(await fs.readFile(f.file.uri.fsPath, 'utf8'), f.file.newText);
  } finally { await f.dispose(); }
 });

 test('accepts line-range coverage read through Read without loading the whole diff', async () => {
  const f = await fixture(); let round = 0, ref = '';
  try {
   f.file.oldText = ''; f.file.hunks = computeLineDiff(f.file.uri.toString(), '', f.file.newText);
   const client: LlmClient = { completeJson: async () => '', complete: async (request) => {
    round++;
    if (round === 1) { return call('list_changes', { path: null, cursor: null, limit: 50 }); }
    if (round === 2) { ref = JSON.parse(lastTool(request).text)[0].chunkRef; return call('Read', { path: 'hello.ts', offset: 1, limit: 1, cursor: null }); }
    if (round === 3) { return call('finish_review', { requestKey: 'ranges', summary: 'Reviewed new-side line range', directlyReviewedRanges: [{ chunkRef: ref, wholeChunk: false, side: 'new', startLine: 1, endLine: 1 }], acceptedReviewResultRefs: [], unresolved: [] }); }
    const receipt = lastTool(request); return final({ reviewId: receipt.reviewId, completionRef: receipt.completionRef });
   } };
   const review = await new CodeReviewAgentService().review({ ...f, config, client, language: 'zh-CN' });
   assert.strictEqual(review.status, 'complete');
   assert.strictEqual(review.agentState!.tasks.main.readChunks.length, 0);
  } finally { await f.dispose(); }
 });
 test('deduplicates spawn retries and resumes a completed child with the same identity', async () => {
  const f = await fixture(); let mainRound = 0, childCalls = 0, childId = '';
  try {
   const args = { role: 'Explore', objective: 'Inspect project background', scope: { paths: [], chunkRefs: [] }, contextRefs: [], requestKey: 'spawn-once' };
   const client: LlmClient = { completeJson: async () => '', complete: async (request) => {
    const task = JSON.parse(request.messages![1].content);
    if (task.agentId !== 'main') {
     childCalls++;
     if (childCalls === 2) { assert.ok(request.messages!.some((message) => message.content.includes('followup question'))); }
     return final({ summary: 'Background checked', evidence: [], nextActions: [], unresolved: [] });
    }
    mainRound++;
    if (mainRound === 1) { return call('spawn_agent', args); }
    if (mainRound === 2) { childId = lastTool(request).agentId; return call('spawn_agent', { requestKey: args.requestKey, contextRefs: [], scope: args.scope, objective: args.objective, role: args.role }); }
    if (mainRound === 3) { assert.strictEqual(lastTool(request).agentId, childId); return call('wait_agents', { agentIds: [childId], afterEventId: 0, timeoutMs: 10000 }); }
    if (mainRound === 4) { return call('send_agent_message', { agentId: childId, kind: 'continue', message: 'followup question', contextRefs: [], requestKey: 'continue-child' }); }
    if (mainRound === 5) { return call('wait_agents', { agentIds: [childId], afterEventId: 0, timeoutMs: 10000 }); }
    if (mainRound === 6) { return call('finish_review', { requestKey: 'done', summary: 'Background explored, review incomplete', directlyReviewedRanges: [], acceptedReviewResultRefs: [], unresolved: [{ chunkRef: null, reason: 'Not reviewed' }] }); }
    const receipt = lastTool(request); return final({ reviewId: receipt.reviewId, completionRef: receipt.completionRef });
   } };
   const review = await new CodeReviewAgentService().review({ ...f, config, client, language: 'zh-CN' });
   assert.strictEqual(Object.keys(review.agentState!.tasks).length, 2);
   assert.strictEqual(childCalls, 2); assert.strictEqual(review.agentState!.tasks[childId].segments, 2);
  } finally { await f.dispose(); }
 });

});
