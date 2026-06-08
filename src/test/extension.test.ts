import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { acceptHunkInBaseline, computeLineDiff } from '../diffEngine';
import { GitService } from '../gitService';
import { AnthropicClient, OpenAiCompatibleClient } from '../llm/client';
import { LlmConfigStore } from '../llm/config';
import { parseStrictJsonObject } from '../llm/json';
import { buildReviewDashboardPayload, ReviewDashboardProvider } from '../reviewDashboard';
import { isDotReviewPath, shouldSkipReviewPath } from '../reviewFileFilter';
import { ReviewTreeProvider } from '../reviewTree';
import {
	applyManualGitBaselineToPair,
	captureLineBlockContext,
	isStaleRevision,
	lineBlockWithContextMatchesUniquely,
	mapLineAfterFileEdits,
	mapLineAfterLineEdits,
	manualGitBaselineFromReviewedFile,
	SerialOperationQueue,
	shouldDeleteRejectedCurrentFileOnRefresh,
	shouldMergeReviewedFileOnRefresh,
	skippedCurrentFile,
} from '../reviewState';
import { replaceLineBlock, splitLines } from '../text';
import { FilePair, ReviewedHunk, ReviewFileState, ReviewHunk, ReviewSession } from '../types';
import { normalizeWikiFilePath, validateWikiInitializationResponse } from '../wiki/wikiInitializer';

suite('Diff engine', () => {
	test('detects added lines', () => {
		const hunks = computeLineDiff('file:///demo.ts', 'const a = 1;\n', 'const a = 1;\nconst b = 2;\n');

		assert.strictEqual(hunks.length, 1);
		assert.strictEqual(hunks[0].kind, 'add');
		assert.strictEqual(hunks[0].oldStart, 1);
		assert.strictEqual(hunks[0].oldLines, 0);
		assert.strictEqual(hunks[0].newStart, 1);
		assert.strictEqual(hunks[0].newLines, 1);
		assert.strictEqual(hunks[0].newText, 'const b = 2;\n');
	});

	test('detects deleted lines', () => {
		const hunks = computeLineDiff('file:///demo.ts', 'a\nb\nc\n', 'a\nc\n');

		assert.strictEqual(hunks.length, 1);
		assert.strictEqual(hunks[0].kind, 'delete');
		assert.strictEqual(hunks[0].oldStart, 1);
		assert.strictEqual(hunks[0].oldLines, 1);
		assert.strictEqual(hunks[0].newStart, 1);
		assert.strictEqual(hunks[0].newLines, 0);
		assert.strictEqual(hunks[0].oldText, 'b\n');
	});

	test('detects modified blocks', () => {
		const hunks = computeLineDiff('file:///demo.ts', 'a\nold\nc\n', 'a\nnew\nc\n');

		assert.strictEqual(hunks.length, 1);
		assert.strictEqual(hunks[0].kind, 'modify');
		assert.strictEqual(hunks[0].oldText, 'old\n');
		assert.strictEqual(hunks[0].newText, 'new\n');
	});

	test('preserves CRLF line endings in accepted hunks', () => {
		const oldText = 'a\r\nold\r\nc\r\n';
		const newText = 'a\r\nnew\r\nc\r\n';
		const [hunk] = computeLineDiff('file:///demo.ts', oldText, newText);

		assert.strictEqual(acceptHunkInBaseline(oldText, hunk), newText);
	});

	test('accepting every hunk makes the baseline match the current text', () => {
		let baseline = 'one\nold\nthree\n';
		const current = 'zero\none\nnew\nthree\nfour\n';

		while (baseline !== current) {
			const [hunk] = computeLineDiff('file:///demo.ts', baseline, current);
			baseline = acceptHunkInBaseline(baseline, hunk);
		}

		assert.strictEqual(baseline, current);
		assert.deepStrictEqual(computeLineDiff('file:///demo.ts', baseline, current), []);
	});

	test('undoing an accepted hunk uses the baseline coordinate', () => {
		const baseline = 'a\nb\nc\n';
		const current = 'a\nx\nb\nC\n';
		const target = shiftedModifyHunk(baseline, current);
		const accepted = reviewedHunk(target, 'accept', target.newStart, target.newLines, target.oldStart, target.newStart);
		const acceptedBaseline = acceptHunkInBaseline(baseline, target);

		const restoredWithDisplayStart = replaceLineBlock(acceptedBaseline, accepted.displayStart, accepted.newLines, accepted.oldText);
		const restoredWithBaselineStart = replaceLineBlock(acceptedBaseline, accepted.baselineStart, accepted.newLines, accepted.oldText);

		assert.notStrictEqual(restoredWithDisplayStart, baseline);
		assert.strictEqual(restoredWithBaselineStart, baseline);
	});

	test('keeps shifted hunk content stable across accept undo reject undo accept', () => {
		const originalBaseline = 'a\nb\nc\n';
		const originalCurrent = 'a\nx\nb\nC\n';
		let baseline = originalBaseline;
		let current = originalCurrent;

		let target = shiftedModifyHunk(baseline, current);
		let accepted = reviewedHunk(target, 'accept', target.newStart, target.newLines, target.oldStart, target.newStart);
		baseline = acceptHunkInBaseline(baseline, target);
		baseline = replaceLineBlock(baseline, accepted.baselineStart, accepted.newLines, accepted.oldText);

		assert.strictEqual(baseline, originalBaseline);

		target = shiftedModifyHunk(baseline, current);
		const rejected = reviewedHunk(target, 'reject', target.newStart, target.oldLines, target.oldStart, target.newStart);
		current = replaceLineBlock(current, target.newStart, target.newLines, target.oldText);
		current = replaceLineBlock(current, rejected.currentStart, rejected.displayLines, rejected.newText);

		assert.strictEqual(current, originalCurrent);

		target = shiftedModifyHunk(baseline, current);
		accepted = reviewedHunk(target, 'accept', target.newStart, target.newLines, target.oldStart, target.newStart);
		baseline = acceptHunkInBaseline(baseline, target);

		assert.strictEqual(accepted.baselineStart, 2);
		assert.strictEqual(accepted.displayStart, 3);
		assert.strictEqual(baseline, 'a\nb\nC\n');
		assert.strictEqual(current, originalCurrent);
	});

	test('anchors a delete hunk before the following current line', () => {
		const baseline = [
			'func main() {\n',
			'\thelloWorld()\n',
			'\tgreet("Go")\n',
			'\tgreetWithConfig(GreetingConfig{Name: "Agent", Age: 1})\n',
			'}\n',
		].join('');
		const current = [
			'func main() {\n',
			'\thelloWorld()\n',
			'}\n',
		].join('');

		const hunk = computeLineDiff('file:///main.go', baseline, current).find((item) => item.kind === 'delete');

		assert.ok(hunk);
		assert.strictEqual(hunk.newStart, 2);
		assert.strictEqual(hunk.zoneAfterLineNumber, 2);
		assert.deepStrictEqual(hunk.newContextBefore, ['func main() {\n', '\thelloWorld()\n']);
		assert.deepStrictEqual(hunk.newContextAfter, ['}\n']);
	});
});

suite('Review state', () => {
	test('skips dot files and dot folders in review file discovery', () => {
		assert.strictEqual(isDotReviewPath('.env'), true);
		assert.strictEqual(isDotReviewPath('.github/workflows/release.yml'), true);
		assert.strictEqual(isDotReviewPath('src/.cache/output.txt'), true);
		assert.strictEqual(shouldSkipReviewPath('src/app.ts'), false);
		assert.strictEqual(shouldSkipReviewPath('src/file.name.ts'), false);
	});

	test('treats mismatched expected revisions as stale', () => {
		assert.strictEqual(isStaleRevision(3), false);
		assert.strictEqual(isStaleRevision(3, 3), false);
		assert.strictEqual(isStaleRevision(3, 2), true);
	});

	test('serializes operations for the same file key', async () => {
		const queue = new SerialOperationQueue<string>();
		const order: string[] = [];
		let releaseFirst: () => void = () => undefined;

		const first = queue.enqueue('file:///demo.ts', async () => {
			order.push('first:start');
			await new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			order.push('first:end');
		});
		const second = queue.enqueue('file:///demo.ts', async () => {
			order.push('second');
		});

		await Promise.resolve();
		await Promise.resolve();
		assert.deepStrictEqual(order, ['first:start']);

		releaseFirst();
		await Promise.all([first, second]);
		assert.deepStrictEqual(order, ['first:start', 'first:end', 'second']);
	});

	test('allows refresh to delete a rejected empty new current file', () => {
		assert.strictEqual(shouldDeleteRejectedCurrentFileOnRefresh(false, '', 0, 1), true);
		assert.strictEqual(shouldDeleteRejectedCurrentFileOnRefresh(true, '', 0, 1), false);
		assert.strictEqual(shouldDeleteRejectedCurrentFileOnRefresh(false, 'kept\n', 0, 1), false);
		assert.strictEqual(shouldDeleteRejectedCurrentFileOnRefresh(false, '', 1, 1), false);
		assert.strictEqual(shouldDeleteRejectedCurrentFileOnRefresh(false, '', 0, 0), false);
	});

	test('merges only reviewed snapshot files without pending hunks on refresh', () => {
		assert.strictEqual(shouldMergeReviewedFileOnRefresh(0, 1, 0), true);
		assert.strictEqual(shouldMergeReviewedFileOnRefresh(0, 0, 1), true);
		assert.strictEqual(shouldMergeReviewedFileOnRefresh(0, 1, 1), true);
		assert.strictEqual(shouldMergeReviewedFileOnRefresh(1, 1, 0), false);
		assert.strictEqual(shouldMergeReviewedFileOnRefresh(1, 0, 1), false);
		assert.strictEqual(shouldMergeReviewedFileOnRefresh(0, 0, 0), false);
		assert.strictEqual(shouldMergeReviewedFileOnRefresh(0, 1, 0, 'File exceeds cliDiff.maxFileBytes.'), false);
	});

	test('keeps manually merged Git baselines across repeated refresh pairs', () => {
		const uri = vscode.Uri.file('D:/repo/tracked.txt');
		const acceptedHunk = computeLineDiff(uri.toString(), 'base\n', 'base\naccepted\n')[0];
		const reviewedFile = reviewFileState(uri, 'tracked.txt', {
			oldText: 'base\naccepted\n',
			newText: 'base\naccepted\n',
			acceptedHunks: [reviewedHunkFrom(acceptedHunk, 'accept')],
		});
		const baseline = manualGitBaselineFromReviewedFile(reviewedFile);
		assert.ok(baseline);

		const indexPair: FilePair = {
			uri,
			relativePath: 'tracked.txt',
			oldText: 'base\n',
			newText: 'base\naccepted\n',
			baselineExists: true,
			currentExists: true,
		};
		const firstRefresh = applyManualGitBaselineToPair(indexPair, baseline);
		const secondRefresh = applyManualGitBaselineToPair(indexPair, baseline);
		const editedRefresh = applyManualGitBaselineToPair({
			...indexPair,
			newText: 'base\naccepted\nlater\n',
		}, baseline);

		assert.deepStrictEqual(computeLineDiff(uri.toString(), firstRefresh.oldText, firstRefresh.newText), []);
		assert.deepStrictEqual(computeLineDiff(uri.toString(), secondRefresh.oldText, secondRefresh.newText), []);
		const editedHunks = computeLineDiff(uri.toString(), editedRefresh.oldText, editedRefresh.newText);
		assert.strictEqual(editedHunks.length, 1);
		assert.strictEqual(editedHunks[0].newText, 'later\n');
	});

	test('does not apply manual Git baselines to skipped pairs', () => {
		const uri = vscode.Uri.file('D:/repo/tracked.txt');
		const baseline = { oldText: 'base\naccepted\n', baselineExists: true };
		const pair: FilePair = {
			uri,
			relativePath: 'tracked.txt',
			oldText: 'base\n',
			newText: 'base\naccepted\n',
			baselineExists: true,
			currentExists: true,
		};

		assert.strictEqual(applyManualGitBaselineToPair({ ...pair, skippedReason: 'too large' }, baseline).oldText, 'base\n');
		assert.strictEqual(applyManualGitBaselineToPair({ ...pair, currentExists: false }, baseline).oldText, 'base\naccepted\n');
	});

	test('captures accepted deletion as a manual Git baseline', () => {
		const uri = vscode.Uri.file('D:/repo/tracked.txt');
		const deleteHunk = computeLineDiff(uri.toString(), 'base\n', '')[0];
		const acceptedDeletion = reviewFileState(uri, 'tracked.txt', {
			oldText: '',
			newText: '',
			baselineExists: false,
			currentExists: false,
			acceptedHunks: [reviewedHunkFrom(deleteHunk, 'accept')],
		});
		const rejectedNewFile = reviewFileState(uri, 'tracked.txt', {
			oldText: '',
			newText: '',
			baselineExists: false,
			currentExists: false,
			rejectedHunks: [reviewedHunkFrom(computeLineDiff(uri.toString(), '', 'new\n')[0], 'reject')],
		});

		const baseline = manualGitBaselineFromReviewedFile(acceptedDeletion);
		assert.deepStrictEqual(baseline, { oldText: '', baselineExists: false });
		const refreshedDeletion = applyManualGitBaselineToPair({
			uri,
			relativePath: 'tracked.txt',
			oldText: 'base\n',
			newText: '',
			baselineExists: true,
			currentExists: false,
		}, baseline);
		assert.deepStrictEqual(computeLineDiff(uri.toString(), refreshedDeletion.oldText, refreshedDeletion.newText), []);
		assert.strictEqual(manualGitBaselineFromReviewedFile(rejectedNewFile), undefined);
	});

	test('maps reviewed baseline starts through manual edits before the hunk', () => {
		const acceptedBaseline = 'a\nmanual\nb\nC\n';
		const mappedBaselineStart = mapLineAfterLineEdits(2, [{ oldStart: 1, oldLines: 0, newLines: 1 }]);
		const restored = replaceLineBlock(acceptedBaseline, mappedBaselineStart, 1, 'c\n');

		assert.strictEqual(mappedBaselineStart, 3);
		assert.strictEqual(restored, 'a\nmanual\nb\nc\n');
	});

	test('keeps skipped current snapshot files marked as existing', () => {
		const current = skippedCurrentFile('File exceeds cliDiff.maxFileBytes.');

		assert.strictEqual(current.exists, true);
		assert.strictEqual(current.text, '');
		assert.strictEqual(current.skippedReason, 'File exceeds cliDiff.maxFileBytes.');
	});

	test('shows skipped files in the review tree', () => {
		const file: ReviewFileState = {
			uri: vscode.Uri.file('D:/repo/src/reviewController.ts'),
			relativePath: 'src/reviewController.ts',
			oldText: '',
			newText: '',
			hunks: [],
			acceptedHunks: [],
			rejectedHunks: [],
			originalText: '',
			originalExists: true,
			baselineExists: true,
			currentExists: true,
			revision: 0,
			skippedReason: 'File diff exceeds cliDiff.maxDiffCells.',
		};
		const session: ReviewSession = {
			id: 'git-test',
			mode: 'git',
			rootUri: vscode.Uri.file('D:/repo'),
			createdAt: 1,
			files: new Map([[file.uri.toString(), file]]),
		};
		const provider = new ReviewTreeProvider(() => session);
		const [child] = provider.getChildren();
		const item = provider.getTreeItem(child);

		assert.strictEqual(child, file);
		assert.strictEqual(item.description, 'skipped');
		assert.strictEqual(item.contextValue, 'cliDiffFileSkipped');
	});

	test('builds dashboard payload with current review and action states', () => {
		const pendingUri = vscode.Uri.file('D:/repo/src/pending.ts');
		const reviewedUri = vscode.Uri.file('D:/repo/src/reviewed.ts');
		const skippedUri = vscode.Uri.file('D:/repo/src/skipped.ts');
		const pendingHunk = computeLineDiff(pendingUri.toString(), 'a\n', 'b\n')[0];
		const reviewedHunk = computeLineDiff(reviewedUri.toString(), 'one\n', 'two\n')[0];
		const session: ReviewSession = {
			id: 'dashboard-test',
			mode: 'git',
			rootUri: vscode.Uri.file('D:/repo'),
			createdAt: 1,
			files: new Map([
				[pendingUri.toString(), reviewFileState(pendingUri, 'src/pending.ts', { hunks: [pendingHunk] })],
				[reviewedUri.toString(), reviewFileState(reviewedUri, 'src/reviewed.ts', {
					acceptedHunks: [reviewedHunkFrom(reviewedHunk, 'accept')],
				})],
				[skippedUri.toString(), reviewFileState(skippedUri, 'src/skipped.ts', {
					skippedReason: 'File diff exceeds cliDiff.maxDiffCells.',
				})],
			]),
		};

		const empty = buildReviewDashboardPayload(undefined, undefined, () => false);
		const payload = buildReviewDashboardPayload(session, pendingUri, (uri) => uri.toString() === pendingUri.toString());
		const pending = payload.files.find((file) => file.relativePath === 'src/pending.ts');
		const reviewed = payload.files.find((file) => file.relativePath === 'src/reviewed.ts');
		const skipped = payload.files.find((file) => file.relativePath === 'src/skipped.ts');

		assert.deepStrictEqual(empty.files, []);
		assert.strictEqual(payload.currentReviewLabel, 'pending.ts');
		assert.strictEqual(payload.files.length, 3);
		assert.strictEqual(pending?.active, true);
		assert.strictEqual(pending?.dirty, true);
		assert.strictEqual(pending?.acceptDisabled, true);
		assert.strictEqual(reviewed?.undoDisabled, false);
		assert.strictEqual(skipped?.acceptDisabled, true);
		assert.strictEqual(skipped?.rejectDisabled, true);
		assert.strictEqual(skipped?.undoDisabled, true);
		assert.notStrictEqual(empty.changeSignature, payload.changeSignature);

		session.files.set(pendingUri.toString(), reviewFileState(pendingUri, 'src/pending.ts'));
		const changed = buildReviewDashboardPayload(session, pendingUri, () => false);
		assert.notStrictEqual(changed.changeSignature, payload.changeSignature);
	});

	test('posts dashboard state after file-level commands', async () => {
		const uri = vscode.Uri.file('D:/repo/src/pending.ts');
		const posted: unknown[] = [];
		let messageHandler: ((message: unknown) => void) | undefined;
		const provider = new ReviewDashboardProvider(
			() => ({ currentReviewLabel: 'pending.ts', changeSignature: String(posted.length), files: [] }),
			async <T,>() => undefined as T,
		);
		const view = {
			webview: {
				options: {},
				html: '',
				onDidReceiveMessage: (handler: (message: unknown) => void) => {
					messageHandler = handler;
					return { dispose: () => undefined };
				},
				postMessage: (message: unknown) => {
					posted.push(message);
					return Promise.resolve(true);
				},
			},
			title: '',
		} as unknown as vscode.WebviewView;
		provider.resolveWebviewView(view);

		assert.ok(messageHandler);
		assert.strictEqual(view.title, 'pending.ts');
		const before = posted.length;
		messageHandler({ type: 'acceptFile', uri: uri.toString() });
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.ok(posted.length > before);
		provider.dispose();
	});

	test('maps reviewed contexts through file-level accept and reject edits', () => {
		const acceptBaseline = 'keep\naccepted\nend\n';
		const acceptFinalBaseline = 'insert\nkeep\naccepted\nend\n';
		const acceptMappedStart = mapLineAfterFileEdits(1, [{ oldStart: 0, oldLines: 0, newLines: 1 }]);
		const acceptContext = captureLineBlockContext(acceptFinalBaseline, acceptMappedStart, 1);

		assert.strictEqual(acceptMappedStart, 2);
		assert.strictEqual(lineBlockWithContextMatchesUniquely(acceptFinalBaseline, acceptMappedStart, 1, 'accepted\n', acceptContext), true);
		assert.strictEqual(lineBlockWithContextMatchesUniquely(acceptFinalBaseline, 1, 1, 'accepted\n', acceptContext), false);
		assert.strictEqual(acceptBaseline.includes('accepted\n'), true);

		const rejectCurrent = 'remove\nkeep\nrejected\nend\n';
		const rejectFinalCurrent = 'keep\nrejected\nend\n';
		const rejectMappedStart = mapLineAfterFileEdits(2, [{ oldStart: 0, oldLines: 1, newLines: 0 }]);
		const rejectContext = captureLineBlockContext(rejectFinalCurrent, rejectMappedStart, 1);

		assert.strictEqual(rejectMappedStart, 1);
		assert.strictEqual(lineBlockWithContextMatchesUniquely(rejectFinalCurrent, rejectMappedStart, 1, 'rejected\n', rejectContext), true);
		assert.strictEqual(lineBlockWithContextMatchesUniquely(rejectFinalCurrent, 2, 1, 'rejected\n', rejectContext), false);
		assert.strictEqual(rejectCurrent.includes('rejected\n'), true);
	});

	test('requires delete insertion context to match uniquely', () => {
		const text = 'a\n}\na\n}\n';
		const context = captureLineBlockContext('a\n}\n', 1, 0);

		assert.strictEqual(lineBlockWithContextMatchesUniquely(text, 1, 0, '', context), false);
		assert.strictEqual(lineBlockWithContextMatchesUniquely('a\n}\n', 1, 0, '', context), true);
		assert.strictEqual(lineBlockWithContextMatchesUniquely('a\n}\n', 2, 0, '', context), false);
	});

	test('keeps file-level accept undo coordinates in final baseline space', () => {
		const baseline = 'a\nb\nkeep1\nc\nkeep2\nd\n';
		const current = 'x\na\nB\nkeep1\nkeep2\nd\nz\n';
		const hunks = computeLineDiff('file:///demo.ts', baseline, current);
		const accepted = hunks.map((hunk) => reviewedHunk(hunk, 'accept', hunk.newStart, hunk.newLines, hunk.newStart, hunk.newStart));

		const restored = accepted
			.sort((left, right) => right.baselineStart - left.baselineStart)
			.reduce((text, hunk) => replaceLineBlock(text, hunk.baselineStart, hunk.newLines, hunk.oldText), current);

		assert.strictEqual(restored, baseline);
	});

	test('keeps file-level reject undo coordinates in final current space', () => {
		const baseline = 'a\nb\nkeep1\nc\nkeep2\nd\n';
		const current = 'x\na\nB\nkeep1\nkeep2\nd\nz\n';
		const hunks = computeLineDiff('file:///demo.ts', baseline, current);
		const rejectedCurrent = [...hunks]
			.sort((left, right) => right.newStart - left.newStart)
			.reduce((text, hunk) => replaceLineBlock(text, hunk.newStart, hunk.newLines, hunk.oldText), current);
		const rejected = hunks.map((hunk) => reviewedHunk(hunk, 'reject', hunk.oldStart, hunk.oldLines, hunk.oldStart, hunk.oldStart));
		const restored = rejected
			.sort((left, right) => right.currentStart - left.currentStart)
			.reduce((text, hunk) => replaceLineBlock(text, hunk.currentStart, hunk.displayLines, hunk.newText), rejectedCurrent);

		assert.strictEqual(rejectedCurrent, baseline);
		assert.strictEqual(restored, current);
	});
});

suite('LLM Code Wiki', () => {
	test('parses only strict JSON objects', () => {
		assert.deepStrictEqual(parseStrictJsonObject('{"files":[]}'), { files: [] });
		assert.throws(() => parseStrictJsonObject('```json\n{"files":[]}\n```'));
		assert.throws(() => parseStrictJsonObject('prefix {"files":[]}'));
		assert.throws(() => parseStrictJsonObject('"not object"'));
		assert.throws(() => parseStrictJsonObject('[{"files":[]}]'));
	});

	test('validates wiki response files and rejects unsafe paths', () => {
		const valid = validateWikiInitializationResponse(validWikiResponse());

		assert.strictEqual(valid.files.length, 10);
		assert.strictEqual(normalizeWikiFilePath('modules/review-dashboard.md'), 'modules/review-dashboard.md');
		assert.throws(() => normalizeWikiFilePath('../outside.md'));
		assert.throws(() => normalizeWikiFilePath('/absolute.md'));
		assert.throws(() => normalizeWikiFilePath('C:/repo/wiki.md'));
		assert.throws(() => normalizeWikiFilePath('notes.txt'));
		assert.throws(() => validateWikiInitializationResponse({ ...validWikiResponse(), files: [] }));
		const missingSchema = validWikiResponse();
		assert.throws(() => validateWikiInitializationResponse({
			...missingSchema,
			files: missingSchema.files.filter((file) => file.path !== 'schema.md'),
		}));
	});

	test('extracts OpenAI-compatible JSON content from chat completions', async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return new Response(JSON.stringify({
				choices: [{ message: { content: '{"version":1}' } }],
			}), { status: 200 });
		};
		const client = new OpenAiCompatibleClient('https://api.example.test/v1', 'secret', fetchImpl);
		const content = await client.completeJson({
			model: 'gpt-test',
			systemPrompt: 'system',
			userPrompt: 'user',
		});

		assert.strictEqual(content, '{"version":1}');
		assert.strictEqual(calls[0].url, 'https://api.example.test/v1/chat/completions');
		assert.strictEqual((calls[0].init?.headers as Record<string, string>).authorization, 'Bearer secret');
		assert.strictEqual(JSON.parse(String(calls[0].init?.body)).model, 'gpt-test');
	});

	test('extracts Anthropic JSON content from messages responses', async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return new Response(JSON.stringify({
				content: [{ type: 'text', text: '{"version":1}' }],
			}), { status: 200 });
		};
		const client = new AnthropicClient('https://api.anthropic.test', 'secret', fetchImpl);
		const content = await client.completeJson({
			model: 'claude-test',
			systemPrompt: 'system',
			userPrompt: 'user',
		});

		assert.strictEqual(content, '{"version":1}');
		assert.strictEqual(calls[0].url, 'https://api.anthropic.test/v1/messages');
		assert.strictEqual((calls[0].init?.headers as Record<string, string>)['x-api-key'], 'secret');
		assert.strictEqual(JSON.parse(String(calls[0].init?.body)).model, 'claude-test');
	});

	test('stores LLM config globally while keeping API key in secrets', async () => {
		const globalState = new TestMemento();
		const secrets = new TestSecretStorage();
		const store = new LlmConfigStore({ globalState, secrets } as unknown as vscode.ExtensionContext);

		await store.save({
			provider: 'anthropic',
			baseUrl: ' https://api.anthropic.com ',
			model: ' claude-test ',
			apiKey: ' secret-key ',
		});
		const saved = await store.savedConfig();
		const runtime = await store.runtimeConfig();

		assert.strictEqual(saved.provider, 'anthropic');
		assert.strictEqual(saved.baseUrl, 'https://api.anthropic.com');
		assert.strictEqual(saved.model, 'claude-test');
		assert.strictEqual(saved.configured, true);
		assert.strictEqual(runtime?.apiKey, 'secret-key');
		assert.strictEqual(globalState.values.has('cliDiff.llm.apiKey'), false);
	});

	test('includes wiki state in dashboard payload', () => {
		const wiki = {
			configured: true,
			provider: 'openai' as const,
			baseUrl: 'https://api.openai.com/v1',
			model: 'gpt-test',
			hasApiKey: true,
			status: 'idle' as const,
			wikiExists: false,
			workspaceAvailable: true,
		};
		const payload = buildReviewDashboardPayload(undefined, undefined, () => false, wiki);

		assert.ok(payload.llmWiki);
		assert.strictEqual(payload.llmWiki.configured, true);
		assert.strictEqual(payload.llmWiki.model, 'gpt-test');
		assert.deepStrictEqual(payload.files, []);
	});
});

suite('Git service', () => {
	test('uses the index as the Git review baseline', async function (this: Mocha.Context) {
		this.timeout(10000);
		const root = createTempGitRepo();
		try {
			writeRepoFile(root, 'tracked.txt', 'base\n');
			writeRepoFile(root, 'delete.txt', 'delete\n');
			git(root, 'add', 'tracked.txt', 'delete.txt');
			git(root, 'commit', '-m', 'initial');

			const service = new GitService();
			const folder = workspaceFolder(root);

			writeRepoFile(root, 'tracked.txt', 'base\nwork\n');
			let pairs = await service.createFilePairs(folder);
			let byPath = filePairsByPath(pairs);
			assert.strictEqual(byPath.get('tracked.txt')?.oldText, 'base\n');
			assert.strictEqual(byPath.get('tracked.txt')?.newText, 'base\nwork\n');

			git(root, 'add', 'tracked.txt');
			pairs = await service.createFilePairs(folder);
			byPath = filePairsByPath(pairs);
			assert.strictEqual(byPath.has('tracked.txt'), false);

			writeRepoFile(root, 'tracked.txt', 'base\nwork\nunstaged\n');
			pairs = await service.createFilePairs(folder);
			byPath = filePairsByPath(pairs);
			assert.strictEqual(byPath.get('tracked.txt')?.oldText, 'base\nwork\n');
			assert.strictEqual(byPath.get('tracked.txt')?.newText, 'base\nwork\nunstaged\n');

			writeRepoFile(root, 'loose.txt', 'loose\n');
			pairs = await service.createFilePairs(folder);
			byPath = filePairsByPath(pairs);
			assert.strictEqual(byPath.get('loose.txt')?.baselineExists, false);
			assert.strictEqual(byPath.get('loose.txt')?.currentExists, true);

			git(root, 'add', 'loose.txt');
			pairs = await service.createFilePairs(folder);
			byPath = filePairsByPath(pairs);
			assert.strictEqual(byPath.has('loose.txt'), false);

			fs.unlinkSync(path.join(root, 'delete.txt'));
			pairs = await service.createFilePairs(folder);
			byPath = filePairsByPath(pairs);
			assert.strictEqual(byPath.get('delete.txt')?.oldText, 'delete\n');
			assert.strictEqual(byPath.get('delete.txt')?.currentExists, false);

			git(root, 'add', 'delete.txt');
			pairs = await service.createFilePairs(folder);
			byPath = filePairsByPath(pairs);
			assert.strictEqual(byPath.has('delete.txt'), false);

			writeRepoFile(root, '.env', 'secret\n');
			writeRepoFile(root, '.cache/output.txt', 'cache\n');
			writeRepoFile(root, '.gitignore', 'ignored.txt\n');
			writeRepoFile(root, 'ignored.txt', 'ignored\n');
			pairs = await service.createFilePairs(folder);
			byPath = filePairsByPath(pairs);
			assert.strictEqual(byPath.has('.env'), false);
			assert.strictEqual(byPath.has('.cache/output.txt'), false);
			assert.strictEqual(byPath.has('.gitignore'), false);
			assert.strictEqual(byPath.has('ignored.txt'), false);
		} finally {
			removeTempRepo(root);
		}
	});

	test('changes the index signature only for index or HEAD changes', async function (this: Mocha.Context) {
		this.timeout(10000);
		const root = createTempGitRepo();
		try {
			writeRepoFile(root, 'tracked.txt', 'base\n');
			git(root, 'add', 'tracked.txt');
			git(root, 'commit', '-m', 'initial');

			const service = new GitService();
			const folder = workspaceFolder(root);
			const cleanSignature = await service.indexStateSignature(folder);

			writeRepoFile(root, 'tracked.txt', 'base\nwork\n');
			assert.strictEqual(await service.indexStateSignature(folder), cleanSignature);

			git(root, 'add', 'tracked.txt');
			const stagedSignature = await service.indexStateSignature(folder);
			assert.notStrictEqual(stagedSignature, cleanSignature);

			git(root, 'commit', '-m', 'second');
			assert.notStrictEqual(await service.indexStateSignature(folder), stagedSignature);
		} finally {
			removeTempRepo(root);
		}
	});
});

suite('Text helpers', () => {
	test('splits lines while preserving terminators', () => {
		assert.deepStrictEqual(splitLines('a\nb\r\nc'), ['a\n', 'b\r\n', 'c']);
	});

	test('replaces a line block', () => {
		assert.strictEqual(replaceLineBlock('a\nb\nc\n', 1, 1, 'B\n'), 'a\nB\nc\n');
	});
});

class TestMemento {
	public readonly values = new Map<string, unknown>();

	public get<T>(key: string, defaultValue?: T): T {
		return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
	}

	public async update(key: string, value: unknown): Promise<void> {
		if (value === undefined) {
			this.values.delete(key);
			return;
		}
		this.values.set(key, value);
	}
}

class TestSecretStorage {
	public readonly values = new Map<string, string>();
	public readonly onDidChange = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event;

	public async get(key: string): Promise<string | undefined> {
		return this.values.get(key);
	}

	public async store(key: string, value: string): Promise<void> {
		this.values.set(key, value);
	}

	public async delete(key: string): Promise<void> {
		this.values.delete(key);
	}
}

interface TestWikiResponse {
	version: 1;
	summary: string;
	files: Array<{ path: string; content: string }>;
	warnings: string[];
}

function validWikiResponse(): TestWikiResponse {
	const files = [
		'index.md',
		'overview.md',
		'architecture.md',
		'extension-surface.md',
		'workflows.md',
		'modules.md',
		'decisions.md',
		'open-questions.md',
		'schema.md',
		'log.md',
	].map((file) => ({ path: file, content: `# ${file}\n` }));
	return {
		version: 1,
		summary: 'Generated wiki.',
		files,
		warnings: [],
	};
}

function createTempGitRepo(): string {
	const base = fs.existsSync('C:\\tmp') ? 'C:\\tmp' : os.tmpdir();
	const root = fs.mkdtempSync(path.join(base, 'cli-diff-git-'));
	git(root, 'init');
	git(root, 'config', 'user.email', 'cli-diff@example.invalid');
	git(root, 'config', 'user.name', 'CLI Diff Test');
	git(root, 'config', 'core.autocrlf', 'false');
	return root;
}

function removeTempRepo(root: string): void {
	try {
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	} catch {
		// Windows can briefly keep Git metadata handles open after extension-host tests.
	}
}

function workspaceFolder(root: string): vscode.WorkspaceFolder {
	return {
		uri: vscode.Uri.file(root),
		name: path.basename(root),
		index: 0,
	};
}

function writeRepoFile(root: string, relativePath: string, text: string): void {
	const filePath = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, text);
}

function git(root: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function filePairsByPath<T extends { relativePath: string }>(pairs: T[]): Map<string, T> {
	return new Map(pairs.map((pair) => [pair.relativePath, pair]));
}

function reviewFileState(
	uri: vscode.Uri,
	relativePath: string,
	overrides: Partial<ReviewFileState> = {},
): ReviewFileState {
	return {
		uri,
		relativePath,
		oldText: '',
		newText: '',
		hunks: [],
		acceptedHunks: [],
		rejectedHunks: [],
		originalText: '',
		originalExists: true,
		baselineExists: true,
		currentExists: true,
		revision: 0,
		...overrides,
	};
}

function reviewedHunkFrom(hunk: ReviewHunk, reviewSource: 'accept' | 'reject'): ReviewedHunk {
	return reviewedHunk(
		hunk,
		reviewSource,
		hunk.newStart,
		reviewSource === 'reject' ? hunk.oldLines : hunk.newLines,
		hunk.oldStart,
		hunk.newStart,
	);
}

function shiftedModifyHunk(baseline: string, current: string): ReviewHunk {
	const hunk = computeLineDiff('file:///demo.ts', baseline, current).find((item) => item.kind === 'modify');
	assert.ok(hunk);
	assert.notStrictEqual(hunk.oldStart, hunk.newStart);
	return hunk;
}

function reviewedHunk(
	hunk: ReviewHunk,
	reviewSource: 'accept' | 'reject',
	displayStart: number,
	displayLines: number,
	baselineStart: number,
	currentStart: number,
): ReviewedHunk {
	return {
		...hunk,
		id: `${reviewSource}-${hunk.id}`,
		status: reviewSource === 'accept' ? 'accepted' : 'rejected',
		reviewSource,
		displayStart,
		displayLines,
		baselineStart,
		currentStart,
		baselineContextBefore: [],
		baselineContextAfter: [],
		currentContextBefore: [],
		currentContextAfter: [],
		zoneAfterLineNumber: displayStart,
		reviewedAt: 1,
	};
}
