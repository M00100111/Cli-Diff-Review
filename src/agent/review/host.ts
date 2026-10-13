import { randomUUID } from 'crypto';
import type { CodeReviewAgentOptions, StoredAiReview, AiReviewFinding, AiReviewChunkSuggestion } from '../codeReview';
import { AgentPauseError, AgentRunCheckpoint, AgentRunner, AgentTool } from '../runtime';
import { LlmApiError } from '../../llm/client';
import { splitLines } from '../../text';
import { reviewChangeSignature } from '../codeReview';
import { BudgetClient, compactContext, CompressionState, UsageLedger } from './context';
import { canonicalJson, hash, LiveReviewIndex, LiveState, page } from './live';
import { childResultSchema, readToolNames, ReviewRole, rolePrompt, toolSchemas, ToolName, validate } from './schema';

interface Task {
 id: string; role: ReviewRole; objective: string; parentId?: string; scope: { paths: string[]; chunkRefs: string[] }; contextRefs: string[]; contextRecords: unknown[];
 status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';
 checkpoint?: AgentRunCheckpoint; error?: string; inbox: Array<{ id: number; message: unknown }>; resultRefs: string[]; segments: number;
 compression: CompressionState;
 readChunks: string[]; readEvidence: string[]; readPages: Record<string, string | null>;
}
interface Coverage { chunkRef: string; wholeChunk: boolean; side: 'old' | 'new' | null; startLine: number | null; endLine: number | null }
interface Candidate { primaryChunkRef: string; relatedChunkRefs: string[]; evidence: Array<{ evidenceRef: string; side: 'old' | 'new'; startLine: number; endLine: number }>; severity: AiReviewFinding['severity']; title: string; explanation: string; recommendation: string }
interface Suggestion { findingId: string; chunkRef: string; edits: Array<{ startLine: number; endLineExclusive: number; expectedText: string; replacementText: string }>; rationale: string }
interface Report { agentId: string; role: ReviewRole; result: Record<string, unknown> }
export interface ReviewHostState {
 version: 2; id: string; modelKey: string; live: LiveState; deliveredVersions: Record<string, string>; notifications: number;
 tasks: Record<string, Task>; results: Record<string, Report>; events: Array<{ id: number; agentId: string; kind: string; message: unknown }>;
 mutations: Record<string, { digest: string; result: unknown }>; usage: UsageLedger; completionRef?: string; completionRevision?: number;
 coverage: Coverage[]; summary?: string;
}
export class ReviewHost {
 private readonly index: LiveReviewIndex;
 private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
 private scanQueue: Promise<unknown> = Promise.resolve();
 private saveQueue: Promise<void> = Promise.resolve();
 private stopping = false;
 private readonly mainController = new AbortController();
 private readonly client: BudgetClient;
 public readonly state: ReviewHostState;
 public constructor(private readonly options: CodeReviewAgentOptions, private readonly review: StoredAiReview) {
  const modelKey = hash(JSON.stringify([options.config.provider, options.config.model]));
  if (review.agentState && review.agentState.modelKey !== modelKey) { throw new Error('Model/provider changed; start a new review.'); }
  this.state = review.agentState ?? { version: 2, id: randomUUID(), modelKey, live: { revision: 0, versions: {}, evidence: {} }, deliveredVersions: {}, notifications: 0, tasks: {}, results: {}, events: [], mutations: {}, usage: { input: 0, output: 0, estimated: 0, reserved: 0 }, coverage: [] };
  review.agentState = this.state;
  // A process crash can leave a reservation without a response. Charge it conservatively once.
  if (this.state.usage.reserved) { this.state.usage.estimated += this.state.usage.reserved; this.state.usage.input += this.state.usage.reserved; this.state.usage.reserved = 0; }
  this.index = new LiveReviewIndex(options.root.uri.fsPath, options.session, this.state.live, options.refreshSession);
  this.client = new BudgetClient(options.client, this.state.usage, options.totalBudgetTokens ?? 1000000, () => this.save());
 }
 private save(): Promise<void> {
  const snapshot = JSON.parse(JSON.stringify(this.review)) as StoredAiReview;
  this.saveQueue = this.saveQueue.then(() => this.options.onCheckpoint?.(snapshot));
  return this.saveQueue;
 }
 private event(task: Task, kind: string, message: unknown): void {
  this.state.events.push({ id: this.state.events.length + 1, agentId: task.id, kind, message });
  this.options.onTrace?.({ kind: 'tool_results_context', title: kind, summary: typeof message === 'string' ? message : JSON.stringify(message).slice(0, 600), status: 'info', details: [{ label: kind, format: 'json', content: JSON.stringify(message) }] }, this.traceContext(task));
 }
 private traceContext(task: Task) { return { stage: task.role.toLowerCase() as 'main' | 'explore' | 'review' | 'plan', agentId: task.id, parentAgentId: task.parentId, role: task.role, segment: task.segments }; }
 private newTask(role: ReviewRole, objective: string, scope: Task['scope'], contextRefs: string[], parentId?: string): Task {
  const task: Task = { id: parentId ? randomUUID() : 'main', role, objective, scope, contextRefs, contextRecords: this.resolveRefs(contextRefs), parentId, status: 'queued', inbox: [], resultRefs: [], segments: 0, compression: { lastRound: 0, lastSize: 0, count: 0 }, readChunks: [], readEvidence: [], readPages: {} };
  this.state.tasks[task.id] = task;
  return task;
 }
 private async scan(): Promise<void> {
  const next = this.scanQueue.then(() => this.index.scan());
  this.scanQueue = next.catch(() => undefined);
  await next;
 }
 private async notifyChanges(recovery = false): Promise<void> {
  await this.scan();
  const changed = [...new Set([...Object.keys(this.state.deliveredVersions), ...Object.keys(this.state.live.versions)])].filter((path) => this.state.deliveredVersions[path] !== this.state.live.versions[path]);
  if (!changed.length) { return; }
  if (!recovery && this.state.notifications >= (this.options.changeNotificationLimit ?? 5)) {
   throw new AgentPauseError(`检测到第 ${(this.options.changeNotificationLimit ?? 5) + 1} 批待发送变更；已暂停。修改完成后继续审阅会补充暂停期间的变更。`);
  }
  if (!recovery) { this.state.notifications++; }
  const message = { type: recovery ? 'recovery_changes' : 'live_changes', revision: this.state.live.revision, paths: changed, instruction: 'These saved files or Git baselines changed. Invalidate affected evidence and reread as needed; do not restart the whole review.' };
  for (const task of Object.values(this.state.tasks)) { task.inbox.push({ id: this.state.events.length + 1, message }); }
  this.state.deliveredVersions = { ...this.state.live.versions };
  this.event(this.state.tasks.main, '代码变更通知', message);
  await this.save();
 }
 public async run(): Promise<StoredAiReview> {
  const continuing = Boolean(this.state.tasks.main);
  const main = this.state.tasks.main ?? this.newTask('Main', 'Review the current plugin-detected changes. Start with list_changes, read only what is needed, then publish supported findings and a completion summary.', { paths: [], chunkRefs: [] }, []);
  await this.scan();
  if (continuing) {
   main.inbox.push({ id: this.state.events.length + 1, message: { type: 'continue_review', reason: this.review.error ?? 'User requested continuation', unresolved: this.review.unresolved ?? [], instruction: 'Continue the existing review from saved progress. Resolve remaining scope and obtain a new finish_review receipt with a fresh requestKey.' } });
   this.state.completionRef = undefined; this.state.completionRevision = undefined;
   this.state.notifications = 0;
   await this.notifyChanges(true);
   for (const task of Object.values(this.state.tasks)) {
    if (['running', 'paused'].includes(task.status)) { task.status = 'queued'; }
   }
  } else { this.state.deliveredVersions = { ...this.state.live.versions }; }
  main.status = 'queued'; this.review.status = 'partial'; this.review.error = undefined;
  const abort = () => { this.stopping = true; this.mainController.abort(); for (const running of this.active.values()) { running.controller.abort(); } };
  this.options.signal?.addEventListener('abort', abort, { once: true });
  try {
   if (this.options.signal?.aborted) { throw new AgentPauseError('Review interrupted'); }
   this.pump();
   await this.runTask(main, this.mainController.signal);
   if ((main.status as string) !== 'completed') { throw new AgentPauseError(main.error ?? 'Review paused'); }
   if (!this.state.completionRef) { throw new Error('Main agent did not finish_review'); }
   return this.review;
  } finally {
   this.stopping = true;
   for (const running of this.active.values()) { running.controller.abort(); }
   await Promise.allSettled([...this.active.values()].map((running) => running.promise));
   this.options.signal?.removeEventListener('abort', abort);
   await this.save();
  }
 }
 private pump(): void {
  if (this.stopping) { return; }
  for (const task of Object.values(this.state.tasks)) {
   if (this.active.size >= (Math.max(1, Math.floor(this.options.childConcurrency ?? 5)))) { break; }
   if (!task.parentId || task.status !== 'queued' || this.active.has(task.id)) { continue; }
   const controller = new AbortController();
   const promise = Promise.resolve().then(() => this.runTask(task, controller.signal)).finally(() => { this.active.delete(task.id); this.pump(); });
   this.active.set(task.id, { controller, promise });
  }
 }
 private async runTask(task: Task, signal?: AbortSignal): Promise<void> {
  task.status = 'running'; task.segments++;
  const tools = this.tools(task);
  const userPrompt = JSON.stringify({ reviewId: this.state.id, agentId: task.id, parentAgentId: task.parentId ?? null, objective: task.objective, scope: task.scope, contextRefs: task.contextRefs, contextRecords: task.contextRecords, note: 'Use tools for current code, do not assume the whole diff is in this message.' });
  try {
   const result = await new AgentRunner().run({
    config: this.options.config, client: this.client, systemPrompt: rolePrompt(task.role, this.options.language), userPrompt, tools, signal,
    maxRounds: this.options.maxRounds ?? 32, segmentRounds: true, maxRunMs: 24 * 60 * 60 * 1000, maxContextChars: Infinity, maxToolResultChars: Infinity, maxRoundToolResultChars: 64000,
    maxOutputTokens: this.options.config.maxOutputTokens ?? 12000, resumeFrom: task.checkpoint,
    onTrace: (event) => this.options.onTrace?.(event, this.traceContext(task)),
    onProgress: (progress) => this.options.onProgress?.(`${task.role}: ${progress.message}`),
    onCheckpoint: async (checkpoint) => { task.checkpoint = checkpoint; await this.save(); },
    beforeRound: async (messages, round, roundSignal) => {
     if (this.stopping) { throw new AgentPauseError('Review paused'); }
     await this.notifyChanges();
     await compactContext({ messages, tools, round, config: this.options.config, client: this.client, enabled: this.options.autoCompress ?? false, state: task.compression, knownRefs: [...this.index.chunks.keys(), ...Object.keys(this.state.live.evidence), ...Object.keys(this.state.results), ...Object.values(this.state.tasks).flatMap((item) => [...item.readChunks, ...item.scope.chunkRefs])], authoritative: this.status(), signal: roundSignal, trace: (success, detail) => this.event(task, success ? '上下文压缩完成' : '上下文压缩未应用', detail) });
     if (task.inbox.length) { messages.push({ role: 'user', content: JSON.stringify({ notifications: task.inbox }) }); task.inbox = []; }
    },
    validateFinal: async (value) => {
     if (task.role === 'Main') {
      await this.scan();
      if (Object.keys(value).length !== 2 || value.reviewId !== this.state.id || value.completionRef !== this.state.completionRef || !value.completionRef || this.state.completionRevision !== this.state.live.revision) { throw new Error('Missing or stale finish_review receipt'); }
     } else { validate(childResultSchema(task.role), value); }
    },
   });
   task.status = 'completed'; task.error = undefined;
   if (task.parentId) {
    const resultRef = `result:${randomUUID()}`;
    this.state.results[resultRef] = { agentId: task.id, role: task.role, result: result.result };
    task.resultRefs.push(resultRef);
    this.state.tasks[task.parentId].inbox.push({ id: this.state.events.length + 1, message: { agentId: task.id, status: task.status, resultRef, summary: String(result.result.summary).slice(0, 2000) } });
   }
   this.event(task, '任务完成', { resultRefs: task.resultRefs });
  } catch (error) {
   if ((task.status as string) !== 'cancelled') { task.status = signal?.aborted || error instanceof AgentPauseError || (error instanceof LlmApiError && error.contextExceeded) ? 'paused' : 'failed'; }
   const message = error instanceof Error ? error.message : String(error);
   task.error = this.options.config.apiKey ? message.split(this.options.config.apiKey).join('[REDACTED]') : message;
   if (error instanceof AgentPauseError) { this.stopping = true; this.mainController.abort(); for (const active of this.active.values()) { active.controller.abort(); } }
   this.event(task, '任务暂停或失败', task.error);
   if (task.parentId) { this.state.tasks[task.parentId].inbox.push({ id: this.state.events.length, message: { agentId: task.id, status: task.status, error: task.error } }); }
  }
  await this.save();
 }
 private observed(task: Task, range: Coverage): boolean {
  if (task.readChunks.includes(range.chunkRef)) { return true; }
  if (range.wholeChunk || !range.side || range.startLine === null || range.endLine === null) { return false; }
  const chunk = this.index.chunk(range.chunkRef);
  const version = hash(range.side === 'new' ? chunk.file.newText : chunk.file.oldText);
  const evidence = task.readEvidence.map((ref) => this.state.live.evidence[ref]).filter((item) => item && item.path === chunk.path && item.side === range.side && item.version === version).sort((a, b) => a.startLine - b.startLine);
  let end = range.startLine - 1;
  for (const item of evidence) {
   if (item.startLine > end + 1) { break; }
   if (item.endLine >= range.startLine) { end = Math.max(end, item.endLine); }
  }
  return end >= range.endLine;
 }
 private resolveRefs(refs: string[]): unknown[] {
  return refs.map((ref) => {
   const chunk = this.index.chunks.get(ref);
   if (chunk) { return { ref, path: chunk.path, oldStart: chunk.hunk.oldStart + 1, newStart: chunk.hunk.newStart + 1 }; }
   const evidence = this.state.live.evidence[ref];
   if (evidence) { return { ref, ...evidence }; }
   const result = this.state.results[ref];
   if (result) { return { ref, agentId: result.agentId, role: result.role, summary: String(result.result.summary).slice(0, 2000) }; }
   throw new Error('Unknown contextRef; pass references returned by tools');
  });
 }
 private status(): unknown {
  return { reviewId: this.state.id, revision: this.state.live.revision, notifications: this.state.notifications, usage: this.state.usage, tasks: Object.values(this.state.tasks).map(({ id, role, status, error, resultRefs }) => ({ id, role, status, error, resultRefs })), findings: this.review.findings.map((finding) => ({ id: finding.id, chunkRef: finding.chunkRef })), coverage: this.state.coverage };
 }
 private tools(task: Task): AgentTool[] {
  const names = task.role === 'Main' ? Object.keys(toolSchemas) as ToolName[] : [...readToolNames, 'send_agent_message' as const];
  return names.map((name) => ({ name, description: descriptions[name], parameters: toolSchemas[name], execute: async (args, signal) => {
   validate(toolSchemas[name], args);
   if (readToolNames.includes(name)) {
    await this.scan();
    const result = await this.index.readTool(name, args, signal) as { nextCursor: string | null; evidenceRef?: string };
    if (name === 'read_change') {
     const key = String(args.chunkRef) + ':' + args.contextLines;
     if (args.cursor === null || task.readPages[key] === args.cursor) {
      task.readPages[key] = result.nextCursor;
      if (result.nextCursor === null && !task.readChunks.includes(String(args.chunkRef))) { task.readChunks.push(String(args.chunkRef)); }
     }
    }
    if (name === 'Read') {
     const key = JSON.stringify({ ...args, cursor: null });
     if (args.cursor === null || task.readPages[key] === args.cursor) {
      task.readPages[key] = result.nextCursor;
      if (result.nextCursor === null && result.evidenceRef && !task.readEvidence.includes(result.evidenceRef)) { task.readEvidence.push(result.evidenceRef); }
     }
    }
    await this.save();
    return result;
   }
   const mutate = ['spawn_agent', 'send_agent_message', 'submit_findings', 'submit_suggestions', 'finish_review'].includes(name);
   const key = `${task.id}:${name}:${args.requestKey}`;
   const digest = hash(canonicalJson(args));
   const previous = this.state.mutations[key];
   if (mutate && previous) { if (previous.digest !== digest) { throw new Error('requestKey reused with different arguments'); } return previous.result; }
   const result = await this.execute(task, name, args, signal);
   if (mutate) { this.state.mutations[key] = { digest, result }; }
   await this.save();
   this.pump();
   return result;
  } }));
 }
 private async execute(task: Task, name: ToolName, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  if (name === 'spawn_agent') {
   for (const ref of (args.scope as Task['scope']).chunkRefs) { this.index.chunk(ref); }
   const child = this.newTask(args.role as ReviewRole, String(args.objective), args.scope as Task['scope'], args.contextRefs as string[], task.id);
   this.event(child, '子任务创建', { objective: child.objective });
   return { agentId: child.id, status: child.status };
  }
  if (name === 'send_agent_message') {
   const recipient = this.state.tasks[String(args.agentId)];
   if (!recipient || (task.parentId ? recipient.id !== task.parentId : recipient.parentId !== task.id)) { throw new Error('Messages must be between Main and its child'); }
   recipient.inbox.push({ id: this.state.events.length + 1, message: { from: task.id, kind: args.kind, text: args.message, contextRefs: args.contextRefs, contextRecords: this.resolveRefs(args.contextRefs as string[]) } });
   if (['completed', 'failed', 'paused'].includes(recipient.status) && !this.stopping) { recipient.status = 'queued'; }
   this.event(task, 'Agent 消息', { to: recipient.id, kind: args.kind });
   return { delivered: true, agentId: recipient.id };
  }
  if (name === 'cancel_agent') {
   const target = this.state.tasks[String(args.agentId)];
   if (!target || target.parentId !== task.id) { throw new Error('Unknown child agent'); }
   this.active.get(target.id)?.controller.abort(); target.status = 'cancelled'; target.error = String(args.reason);
   return { agentId: target.id, status: target.status };
  }
  if (name === 'wait_agents') {
   const ids = args.agentIds as string[];
   if (ids.some((id) => this.state.tasks[id]?.parentId !== task.id)) { throw new Error('Unknown child agent'); }
   const end = Date.now() + Number(args.timeoutMs);
   while (Date.now() < end && !signal?.aborted && !this.stopping && !this.state.events.some((event) => event.id > Number(args.afterEventId) && ids.includes(event.agentId) && this.state.tasks[event.agentId].status !== 'running' && this.state.tasks[event.agentId].status !== 'queued')) { await new Promise((resolve) => setTimeout(resolve, 100)); }
   return { events: this.state.events.filter((event) => event.id > Number(args.afterEventId) && ids.includes(event.agentId)).slice(-50), afterEventId: this.state.events.length };
  }
  if (name === 'read_agent_result') {
   const result = this.state.results[String(args.resultRef)]; if (!result) { throw new Error('Unknown resultRef'); }
   return page(JSON.stringify(result), { resultRef: args.resultRef }, args.cursor);
  }
  if (name === 'get_review_status') { return page(JSON.stringify(this.status()), name, args.cursor); }
  await this.scan();
  if (name === 'submit_findings') {
   const findings: AiReviewFinding[] = [];
   for (const candidate of args.findings as Candidate[]) {
    const chunk = this.index.chunk(candidate.primaryChunkRef); await this.index.assertCurrent(chunk);
    candidate.relatedChunkRefs.forEach((ref) => this.index.chunk(ref));
    if (!candidate.evidence.length) { throw new Error('Finding requires source evidence'); }
    for (const evidence of candidate.evidence) { await this.index.verifyEvidence(evidence); }
    findings.push({ id: randomUUID(), uri: chunk.file.uri.toString(), relativePath: chunk.path, hunkId: chunk.hunk.reviewItemId ?? chunk.hunk.sourceHunkId ?? chunk.hunk.id, chunkRef: chunk.chunkRef, line: chunk.hunk.newStart, severity: candidate.severity, title: candidate.title, explanation: candidate.explanation, recommendation: candidate.recommendation, evidenceRefs: candidate.evidence, evidence: candidate.evidence.map((evidence) => `${this.state.live.evidence[evidence.evidenceRef].path}:${evidence.startLine}-${evidence.endLine} (${evidence.side})`), relatedHunkIds: candidate.relatedChunkRefs.map((ref) => { const hunk = this.index.chunk(ref).hunk; return hunk.reviewItemId ?? hunk.sourceHunkId ?? hunk.id; }), relatedPaths: candidate.relatedChunkRefs.map((ref) => this.index.chunk(ref).path), generationOrder: this.review.findings.length + findings.length });
   }
   for (const finding of findings) {
    this.review.findings = this.review.findings.filter((old) => old.chunkRef !== finding.chunkRef || old.title !== finding.title);
    this.review.findings.push(finding);
   }
   return { findings: findings.map(({ id, chunkRef }) => ({ findingId: id, chunkRef })) };
  }
  if (name === 'submit_suggestions') {
   const suggestions: AiReviewChunkSuggestion[] = [];
   for (const candidate of args.suggestions as Suggestion[]) {
    const chunk = this.index.chunk(candidate.chunkRef); await this.index.assertCurrent(chunk);
    if (!this.review.findings.some((finding) => finding.id === candidate.findingId && finding.chunkRef === candidate.chunkRef)) { throw new Error('Suggestion must link a saved finding in the same current chunk'); }
    const lines = splitLines(chunk.hunk.newText);
    const edits = [...candidate.edits].sort((a, b) => a.startLine - b.startLine);
    let previousEnd = -1;
    for (const edit of edits) {
     const start = edit.startLine - (chunk.hunk.newStart + 1), end = edit.endLineExclusive - (chunk.hunk.newStart + 1);
     if (start < 0 || end < start || end > chunk.hunk.newLines || start < previousEnd || lines.slice(start, end).join('') !== edit.expectedText) { throw new Error('Edit is overlapping, outside chunk, or expectedText no longer matches'); }
     previousEnd = end;
    }
    for (const edit of edits.reverse()) { lines.splice(edit.startLine - chunk.hunk.newStart - 1, edit.endLineExclusive - edit.startLine, ...splitLines(edit.replacementText)); }
    suggestions.push({ id: randomUUID(), uri: chunk.file.uri.toString(), relativePath: chunk.path, hunkId: chunk.hunk.reviewItemId ?? chunk.hunk.sourceHunkId ?? chunk.hunk.id, chunkRef: chunk.chunkRef, expectedFileHash: hash(chunk.file.newText), line: chunk.hunk.newStart, replacementText: lines.join(''), rationale: candidate.rationale, generationOrder: this.review.suggestions.length + suggestions.length });
   }
   this.review.suggestions.push(...suggestions); return { suggestionIds: suggestions.map((item) => item.id) };
  }
  if (name === 'finish_review') {
   if (!String(args.summary).trim()) { throw new Error('Completion summary required, even with no findings'); }
   if (Object.values(this.state.tasks).some((other) => other.parentId && ['queued', 'running'].includes(other.status))) { throw new Error('Wait for or cancel outstanding child tasks'); }
   if (canonicalJson(this.state.deliveredVersions) !== canonicalJson(this.state.live.versions)) { throw new Error('Undelivered code changes; continue reviewing after the next notification'); }
   const acceptedUnresolved: Array<{ chunkRef: string | null; reason: string }> = [];
   const coverage = [...args.directlyReviewedRanges as Coverage[]];
   if (coverage.some((range) => !this.observed(task, range))) { throw new Error('Direct review coverage requires a fully read current chunk'); }
   for (const ref of args.acceptedReviewResultRefs as string[]) {
    const report = this.state.results[ref];
    if (!report || report.role !== 'Review') { throw new Error('Only Review results grant coverage'); }
    acceptedUnresolved.push(...report.result.unresolved as Array<{ chunkRef: string | null; reason: string }>);
    const child = this.state.tasks[report.agentId];
    for (const range of report.result.reviewedRanges as Coverage[]) {
     if (!this.observed(child, range)) { throw new Error('Child coverage requires a fully read current chunk'); }
     coverage.push(range);
    }
   }
   for (const range of coverage) {
    const chunk = this.index.chunk(range.chunkRef);
    if (!range.wholeChunk && (!range.side || range.startLine === null || range.endLine === null || range.endLine < range.startLine || range.startLine < chunk.hunk[`${range.side}Start`] + 1 || range.endLine > chunk.hunk[`${range.side}Start`] + chunk.hunk[`${range.side}Lines`])) { throw new Error('Invalid coverage range'); }
   }
   const unresolved = [...args.unresolved as Array<{ chunkRef: string | null; reason: string }>, ...acceptedUnresolved];
   for (const other of Object.values(this.state.tasks)) {
    if (other.parentId && ['failed', 'paused', 'cancelled'].includes(other.status)) { unresolved.push({ chunkRef: null, reason: `${other.role} ${other.id}: ${other.error ?? other.status}` }); }
   }
   for (const chunk of this.index.chunks.values()) {
    if (!chunkCovered(chunk.hunk, coverage.filter((range) => range.chunkRef === chunk.chunkRef))) { unresolved.push({ chunkRef: chunk.chunkRef, reason: 'Whole-chunk review coverage not established' }); }
   }
   const currentFindings: AiReviewFinding[] = [];
   for (const finding of this.review.findings) {
    if (!finding.chunkRef || !this.index.chunks.has(finding.chunkRef)) { continue; }
    try { for (const value of finding.evidenceRefs ?? []) { await this.index.verifyEvidence(value); } currentFindings.push(finding); }
    catch { unresolved.push({ chunkRef: finding.chunkRef, reason: `Finding evidence became stale: ${finding.id}` }); }
   }
   this.review.findings = currentFindings;
   this.review.suggestions = this.review.suggestions.filter((suggestion) => suggestion.chunkRef && this.index.chunks.has(suggestion.chunkRef));
   this.review.signature = reviewChangeSignature(this.index.session);
   this.state.coverage = coverage; this.state.summary = String(args.summary);
   this.state.completionRef = randomUUID(); this.state.completionRevision = this.state.live.revision;
   this.review.summary = this.state.summary; this.review.unresolved = unresolved;
   this.review.status = unresolved.length ? 'partial' : 'complete';
   this.review.completedFiles = [...new Set([...this.index.chunks.values()].filter((chunk) => !unresolved.some((item) => !item.chunkRef || this.index.chunks.get(item.chunkRef)?.path === chunk.path)).map((chunk) => chunk.file.uri.toString()))];
   return { reviewId: this.state.id, completionRef: this.state.completionRef, status: this.review.status, unresolvedCount: unresolved.length, unresolved: unresolved.slice(0, 10) };
  }
  throw new Error(`Unavailable tool ${name}`);
 }
}
const descriptions: Record<ToolName, string> = {
 list_changes: 'List current plugin-detected chunks and their versioned references, without source bodies. Paginated.',
 read_change: 'Read a current chunk old/new code and context with evidence references. Cursor pages may split JSON text; concatenate pages.',
 Glob: 'Find project files by glob, including source, tests, configuration and Wiki. Paginated.',
 Grep: 'Search complete text files for literal or regex matches with numbered context and evidence references. Paginated.',
 Read: 'Read saved project source/test/config/Wiki lines with versioned evidence. offset is 1-based. Paginated.',
 spawn_agent: 'Create a queued child and return immediately. Only Main may spawn.',
 send_agent_message: 'Send a durable message between Main and child. Completed/failed tasks can continue with their original history.',
 wait_agents: 'Optionally wait for child status events, without occupying a child execution slot.',
 read_agent_result: 'Read a persisted child report by resultRef, with pagination.',
 cancel_agent: 'Cancel a child; cancelled tasks do not automatically resume.',
 submit_findings: 'Validate and save supported findings with current chunk and evidence references. Returns finding IDs.',
 submit_suggestions: 'Save proposed within-chunk edits linked to a finding; never changes project code.',
 get_review_status: 'Read authoritative task, budget, coverage and publication state; paginated.',
 finish_review: 'Validate and persist review summary and coverage. Returns a completion receipt, including partial coverage.',
};

function chunkCovered(hunk: { oldStart: number; oldLines: number; newStart: number; newLines: number }, ranges: Coverage[]): boolean {
 if (ranges.some((range) => range.wholeChunk)) { return true; }
 return (['old', 'new'] as const).every((side) => {
  let coveredUntil = hunk[`${side}Start`];
  const end = coveredUntil + hunk[`${side}Lines`];
  for (const range of ranges.filter((range) => range.side === side).sort((a, b) => a.startLine! - b.startLine!)) {
   if (range.startLine! > coveredUntil + 1) { break; }
   coveredUntil = Math.max(coveredUntil, range.endLine!);
  }
  return coveredUntil >= end;
 });
}
