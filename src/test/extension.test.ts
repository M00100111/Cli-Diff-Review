import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AiReviewPartialError, CodeReviewAgentService, reviewChangeSignature, sortFindings, StoredAiReview, validateReviewFindings, validateReviewFindingsWithDiagnostics, validateReviewSuggestionsWithDiagnostics } from '../agent/codeReview';
import { AgentRunner, type AgentTraceEvent, validateAgentResponse } from '../agent/runtime';
import { createReadOnlyAgentTools, createWikiAgentTools } from '../agent/tools';
import { acceptHunkInBaseline, computeLineDiff } from '../diffEngine';
import { GitService } from '../gitService';
import { AnthropicClient, DeepSeekClient, OpenAiCompatibleClient } from '../llm/client';
import { LlmConfigStore } from '../llm/config';
import { parseStrictJsonObject } from '../llm/json';
import { buildReviewDashboardPayload, defaultLlmWikiDashboardState, ReviewDashboardProvider } from '../reviewDashboard';
import { isDotReviewPath, shouldSkipReviewPath } from '../reviewFileFilter';
import { ReviewTreeProvider } from '../reviewTree';
import { normalizeMonacoThemeColor } from '../reviewWebview';
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
import { normalizeWikiFilePath, validateWikiInitializationResponse, WikiInitializationService } from '../wiki/wikiInitializer';
import { WikiStateService } from '../wiki/state';

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

suite('Review webview compatibility', () => {
	test('normalizes VS Code and Cursor theme colors for Monaco', () => {
		assert.strictEqual(normalizeMonacoThemeColor('#abc', '#000000'), '#aabbcc');
		assert.strictEqual(normalizeMonacoThemeColor('#abcd', '#000000'), '#aabbccdd');
		assert.strictEqual(normalizeMonacoThemeColor('#AABBCCDD', '#000000', false), '#aabbcc');
		assert.strictEqual(normalizeMonacoThemeColor('rgb(228, 228, 228)', '#000000', false), '#e4e4e4');
		assert.strictEqual(normalizeMonacoThemeColor('rgba(228, 228, 228, 0.92)', '#000000', false), '#e4e4e4');
		assert.strictEqual(normalizeMonacoThemeColor('rgba(228, 228, 228, 0.92)', '#000000'), '#e4e4e4eb');
		assert.strictEqual(normalizeMonacoThemeColor('rgb(100%, 50%, 0%)', '#000000'), '#ff8000');
		assert.strictEqual(normalizeMonacoThemeColor('not-a-color', '#123456'), '#123456');
		assert.strictEqual(normalizeMonacoThemeColor('', 'not-a-color'), '#000000');
	});

	test('keeps Review Webview CSP and initialization failure handling compatible', () => {
		const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'reviewWebview.ts'), 'utf8');
		assert.ok(source.includes('font-src ${cspSource} data:;'));
		assert.ok(source.includes("require(['vs/editor/editor.main']"));
		assert.ok(source.includes('showInitializationError'));
		assert.ok(source.includes('Review editor failed to initialize: '));
		assert.ok(source.includes("private static readonly deletedDocumentScheme = 'cli-diff-review-deleted';"));
		assert.ok(source.includes('vscode.workspace.registerTextDocumentContentProvider(ReviewWebviewManager.deletedDocumentScheme'));
		assert.ok(source.includes('provideDeletedDocumentContent'));
		assert.ok(source.includes('const originalUri = this.originalUriForDocumentUri(document.uri);'));
		assert.ok(source.includes('const key = uriKey(originalUri);'));
		assert.ok(source.includes('const documentUri = this.documentUriForReview(uri);'));
		assert.ok(source.includes('vscode.openWith\', documentUri'));
		assert.ok(source.includes('const existingHost = this.hosts.get(key);'));
		assert.ok(source.includes('existingHost.panel.reveal(vscode.ViewColumn.Active);'));
		assert.ok(source.includes('return file && !file.currentExists ? this.deletedDocumentUriForOriginalUri(uri) : uri;'));
		assert.ok(source.includes("Buffer.from(uri.toString(), 'utf8').toString('base64url')"));
		assert.ok(source.includes("Buffer.from(encoded, 'base64url').toString('utf8')"));
		assert.ok(source.includes('uri: file.uri.toString()'));
		assert.ok(source.includes('document.uri.scheme === ReviewWebviewManager.deletedDocumentScheme ? file.newText : document.getText()'));
		assert.ok(source.includes('readOnly: document.uri.scheme === ReviewWebviewManager.deletedDocumentScheme'));
		assert.ok(source.includes('if (host.document.uri.scheme === ReviewWebviewManager.deletedDocumentScheme)'));
		assert.match(source, /host\.document\.uri\.scheme === ReviewWebviewManager\.deletedDocumentScheme[\s\S]*?await this\.postState\(host\);[\s\S]*?return;/);
		assert.ok(source.includes('editor.updateOptions({ readOnly: Boolean(state.readOnly) });'));
		assert.ok(source.includes('if (applyingState || state?.readOnly)'));
		assert.ok(source.includes('appliedAiSuggestions: file.appliedAiSuggestions'));
		assert.ok(source.includes("type: 'undoAiSuggestion'"));
		assert.ok(source.includes("state: appliedSuggestion ? 'suggested' : 'pending'"));
		assert.ok(source.includes("node.className = 'cli-hunk-zone ' + (entry.state === 'suggested'"));
		assert.ok(source.includes("const lineClass = entry.state === 'suggested' ? 'suggested'"));
		assert.ok(source.includes('.cli-line-suggested'));
		assert.ok(source.includes('.cli-margin-suggested'));
		assert.ok(source.includes('.cli-hunk-zone.suggested .cli-hunk-header::before'));
		assert.ok(source.includes('const reviewedKeys = new Set(state.acceptedHunks.concat(state.rejectedHunks).map(hunkIdentity));'));
		assert.ok(source.includes('return !reviewedKeys.has(hunkIdentity(hunk));'));
		assert.ok(source.includes('function hunkIdentity(hunk)'));
		assert.ok(source.includes("const oldLinesToShow = hunk.kind === 'delete' || hunk.kind === 'modify' ? splitLines(hunk.oldText) : [];"));
		assert.ok(source.includes("oldLines.className = 'cli-old-lines';"));
		assert.match(source, /\.cli-references-header\s*{[\s\S]*?min-width: 0;[\s\S]*?overflow: hidden;/);
		assert.match(source, /\.cli-references-title\s*{[\s\S]*?flex: 1 1 auto;[\s\S]*?min-width: 0;[\s\S]*?text-overflow: ellipsis;/);
		assert.match(source, /\.cli-references-count\s*{[\s\S]*?flex: 0 0 auto;/);
		assert.match(source, /\.cli-references-actions\s*{[\s\S]*?transform: translateX\(var\(--cli-action-shift, 0px\)\);/);
		assert.ok(source.includes('.cli-references-header button[data-reference-close]'));
		assert.ok(source.includes("actions.className = 'cli-references-actions';"));
		assert.ok(source.includes('actions.appendChild(count);'));
		assert.ok(source.includes('actions.appendChild(close);'));
		assert.match(source, /editor\.layout\(\);\s+updateActionOffset\(\);/);
		const createEditorIndex = source.indexOf('createEditor();');
		const readyIndex = source.indexOf('ready = true;', createEditorIndex);
		assert.ok(createEditorIndex >= 0 && readyIndex > createEditorIndex);
	});
});

suite('Extension configuration', () => {
	test('declares bulk review commands in the manifest', () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
			activationEvents?: string[];
			contributes?: {
				commands?: Array<{ command: string; title?: string; icon?: string }>;
				menus?: { 'view/title'?: Array<{ command: string; when?: string; group?: string }> };
			};
		};
		const commands = manifest.contributes?.commands ?? [];
		const viewTitle = manifest.contributes?.menus?.['view/title'] ?? [];

		for (const [command, icon] of [
			['cli-diff.acceptAll', '$(check)'],
			['cli-diff.rejectAll', '$(close)'],
			['cli-diff.undoAll', '$(discard)'],
		] as const) {
			assert.ok(manifest.activationEvents?.includes(`onCommand:${command}`));
			assert.strictEqual(commands.find((item) => item.command === command)?.icon, icon);
			const menu = viewTitle.find((item) => item.command === command);
			assert.ok(menu);
			assert.strictEqual(menu.when, 'view == cli-diff.review');
		}
		assert.strictEqual(viewTitle.find((item) => item.command === 'cli-diff.acceptAll')?.group, 'navigation@1');
		assert.strictEqual(viewTitle.find((item) => item.command === 'cli-diff.rejectAll')?.group, 'navigation@2');
		assert.strictEqual(viewTitle.find((item) => item.command === 'cli-diff.undoAll')?.group, 'navigation@3');
		assert.strictEqual(viewTitle.find((item) => item.command === 'cli-diff.refresh')?.group, 'navigation@4');
	});

	test('declares AI review language setting defaults', () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
			contributes?: { configuration?: { properties?: Record<string, unknown> } };
		};
		const setting = manifest.contributes?.configuration?.properties?.['cliDiff.aiReviewLanguage'] as {
			default?: unknown;
			enum?: unknown[];
		} | undefined;

		assert.ok(setting);
		assert.strictEqual(setting.default, 'zh-CN');
		assert.deepStrictEqual(setting.enum, ['zh-CN', 'en']);
	});

	test('declares AI review max rounds setting defaults', () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
			contributes?: { configuration?: { properties?: Record<string, unknown> } };
		};
		const setting = manifest.contributes?.configuration?.properties?.['cliDiff.aiReviewMaxRounds'] as {
			default?: unknown;
			minimum?: unknown;
			maximum?: unknown;
			description?: unknown;
		} | undefined;

		assert.ok(setting);
		assert.strictEqual(setting.default, 64);
		assert.strictEqual(setting.minimum, 0);
		assert.strictEqual(Object.prototype.hasOwnProperty.call(setting, 'maximum'), false);
		assert.match(String(setting.description), /0 means unlimited/);
	});
});

suite('Review controller bulk actions', () => {
	test('wires bulk review commands through confirmation and file-level cores', () => {
		const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'reviewController.ts'), 'utf8');

		assert.ok(source.includes("this.registerCommand('cli-diff.acceptAll', () => this.acceptAll())"));
		assert.ok(source.includes("this.registerCommand('cli-diff.rejectAll', () => this.rejectAll())"));
		assert.ok(source.includes("this.registerCommand('cli-diff.undoAll', () => this.undoAll())"));
		assert.ok(source.includes("await this.applyBulkFileOperation('accept')"));
		assert.ok(source.includes("await this.applyBulkFileOperation('reject')"));
		assert.ok(source.includes("await this.applyBulkFileOperation('undo')"));
		assert.ok(source.includes('No pending Cli Diff Review changes.'));
		assert.ok(source.includes('No reviewed Cli Diff Review changes.'));
		assert.ok(source.includes('Save or revert target files before accepting, rejecting, or undoing all Cli Diff Review changes.'));
		assert.ok(source.includes('vscode.window.showWarningMessage'));
		assert.ok(source.includes('{ modal: true }'));
		assert.strictEqual(source.includes("const cancelLabel = 'Cancel';"), false);
		assert.strictEqual(source.includes('confirmationLabel,\n\t\t\tcancelLabel,'), false);
		assert.ok(source.includes('Accept all ${chunkCount} pending changes across ${fileCount} files?'));
		assert.ok(source.includes('Reject all ${chunkCount} pending changes across ${fileCount} files? This will modify working files.'));
		assert.ok(source.includes('Undo all ${chunkCount} reviewed changes across ${fileCount} files? This will restore them to pending.'));
		assert.ok(source.includes('await this.acceptFileCore(target.file)'));
		assert.ok(source.includes('await this.rejectFileCore(target.file)'));
		assert.ok(source.includes('await this.undoFileCore(target.file)'));
		assert.ok(source.includes('this.removePendingHunk(target.file, target.hunk)'));
		assert.ok(source.includes('file.hunks = [];'));
		assert.ok(source.includes('refreshedFile.hunks = [];'));
		assert.ok(source.includes('private isSameReviewHunk(left: ReviewHunk, right: ReviewHunk): boolean'));
		assert.ok(source.includes("chunkCount: action === 'undo' ? file.acceptedHunks.length + file.rejectedHunks.length : file.hunks.length"));
		assert.ok(source.includes('sort((left, right) => left.file.relativePath.localeCompare(right.file.relativePath))'));
	});

	test('wires AI review partial retry and max round configuration through the controller', () => {
		const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'reviewController.ts'), 'utf8');

		assert.ok(source.includes("event.affectsConfiguration('cliDiff.aiReviewMaxRounds')"));
		assert.ok(source.includes("vscode.workspace.getConfiguration('cliDiff').get<number>('aiReviewMaxRounds', 64)"));
		assert.ok(source.includes("return 'unlimited';"));
		assert.ok(source.includes('const existingReview = storedReview?.status === \'partial\' ? storedReview : undefined;'));
		assert.ok(source.includes('existingReview,'));
		assert.ok(source.includes('maxRounds,'));
		assert.ok(source.includes('onFileComplete: async (review) =>'));
		assert.ok(source.includes('await this.aiReviewStore.save(session, review);'));
		assert.ok(source.includes('error instanceof AiReviewPartialError'));
		assert.ok(source.includes('await this.aiReviewStore.save(session, error.review);'));
		assert.ok(source.includes("maxRounds: maxRounds === 'unlimited' ? 'unlimited' : maxRounds"));
		assert.ok(source.includes("this.registerCommand('cli-diff.applyAiSuggestion'"));
		assert.ok(source.includes("this.registerCommand('cli-diff.undoAiSuggestion'"));
		assert.ok(source.includes('private async applyAiSuggestionCore'));
		assert.ok(source.includes('private async undoAiSuggestionCore'));
		assert.ok(source.includes('await this.saveAiReviewWithCurrentSignature(storedReview);'));
		assert.ok(source.includes('this.replacePendingHunkWithAppliedSuggestion'));
	});
});

suite('Review state', () => {
	test('skips dot files and dot folders in review file discovery', () => {
		assert.strictEqual(isDotReviewPath('.env'), true);
		assert.strictEqual(isDotReviewPath('.github/workflows/release.yml'), true);
		assert.strictEqual(isDotReviewPath('src/.cache/output.txt'), true);
		assert.strictEqual(shouldSkipReviewPath('src/app.ts'), false);
		assert.strictEqual(shouldSkipReviewPath('src/file.name.ts'), false);
		assert.strictEqual(shouldSkipReviewPath('.wiki/overview.md', true), false);
		assert.strictEqual(shouldSkipReviewPath('.wiki/overview.md', false), true);
		assert.strictEqual(shouldSkipReviewPath('.wiki/.state.json', true), true);
		assert.strictEqual(shouldSkipReviewPath('.wiki/private.json', true), true);
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

	test('keeps partially accepted Git baselines across manual refresh pairs', () => {
		const uri = vscode.Uri.file('D:/repo/tracked.txt');
		const indexText = 'a\nold-one\nb\nold-two\nc\n';
		const currentText = 'a\nnew-one\nb\nnew-two\nc\n';
		const hunks = computeLineDiff(uri.toString(), indexText, currentText);
		assert.strictEqual(hunks.length, 2);
		const acceptedBaseline = acceptHunkInBaseline(indexText, hunks[0]);
		const reviewedFile = reviewFileState(uri, 'tracked.txt', {
			oldText: acceptedBaseline,
			newText: currentText,
			hunks: [hunks[1]],
			acceptedHunks: [reviewedHunkFrom(hunks[0], 'accept')],
		});
		const baseline = manualGitBaselineFromReviewedFile(reviewedFile);
		assert.deepStrictEqual(baseline, { oldText: acceptedBaseline, baselineExists: true });

		const refreshed = applyManualGitBaselineToPair({
			uri,
			relativePath: 'tracked.txt',
			oldText: indexText,
			newText: currentText,
			baselineExists: true,
			currentExists: true,
		}, baseline);
		const refreshedHunks = computeLineDiff(uri.toString(), refreshed.oldText, refreshed.newText);
		assert.strictEqual(refreshedHunks.length, 1);
		assert.strictEqual(refreshedHunks[0].oldText, 'old-two\n');
		assert.strictEqual(refreshedHunks[0].newText, 'new-two\n');
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
			appliedAiSuggestions: [],
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
		assert.strictEqual(pending?.chunks.length, 1);
		assert.strictEqual(pending?.chunks[0].hunkId, pendingHunk.id);
		assert.strictEqual(Object.prototype.hasOwnProperty.call(pending?.chunks[0] ?? {}, 'preview'), false);
		assert.strictEqual(reviewed?.undoDisabled, false);
		assert.strictEqual(skipped?.acceptDisabled, true);
		assert.strictEqual(skipped?.rejectDisabled, true);
		assert.strictEqual(skipped?.undoDisabled, true);
		assert.notStrictEqual(empty.changeSignature, payload.changeSignature);

		session.files.set(pendingUri.toString(), reviewFileState(pendingUri, 'src/pending.ts'));
		const changed = buildReviewDashboardPayload(session, pendingUri, () => false);
		assert.notStrictEqual(changed.changeSignature, payload.changeSignature);

		session.files.set(pendingUri.toString(), reviewFileState(pendingUri, 'src/pending.ts', { hunks: [pendingHunk] }));
		const findingPayload = buildReviewDashboardPayload(session, pendingUri, () => false, {
			...defaultLlmWikiDashboardState(),
			reviewFindings: [{
				id: 'finding-1',
				uri: pendingUri.toString(),
				relativePath: 'src/pending.ts',
				hunkId: pendingHunk.id,
				line: pendingHunk.newStart,
				severity: 'warning',
				title: 'Mapped finding',
				explanation: 'Risk',
				recommendation: 'Fix',
				evidence: [],
				generationOrder: 0,
			}],
		});
		assert.strictEqual(findingPayload.files.find((file) => file.relativePath === 'src/pending.ts')?.chunks[0].findings[0].title, 'Mapped finding');
		session.files.set(pendingUri.toString(), reviewFileState(pendingUri, 'src/pending.ts', {
			hunks: [pendingHunk],
			appliedAiSuggestions: [{
				suggestionId: 'suggestion-1',
				hunkId: pendingHunk.id,
				originalHunk: pendingHunk,
				replacementText: 'suggested\n',
				appliedHunk: { ...pendingHunk, newText: 'suggested\n' },
				appliedAt: 1,
			}],
		}));
		const suggestionPayload = buildReviewDashboardPayload(session, pendingUri, () => false, {
			...defaultLlmWikiDashboardState(),
			reviewSuggestions: [{
				id: 'suggestion-1',
				uri: pendingUri.toString(),
				relativePath: 'src/pending.ts',
				hunkId: pendingHunk.id,
				line: pendingHunk.newStart,
				replacementText: 'suggested\n',
				rationale: 'Prefer this code.',
				generationOrder: 0,
			}],
			aiReviewFileResults: [{
				uri: pendingUri.toString(),
				relativePath: 'src/pending.ts',
				status: 'success',
				rawFindingCount: 0,
				acceptedFindingCount: 0,
				droppedFindingCount: 0,
				rawSuggestionCount: 1,
				acceptedSuggestionCount: 1,
				droppedSuggestionCount: 0,
				summary: 'Model returned 0 findings. Accepted 1 of 1 suggestions.',
			}],
		});
		const suggestionFile = suggestionPayload.files.find((file) => file.relativePath === 'src/pending.ts');
		assert.strictEqual(suggestionFile?.chunks[0].suggestions[0].replacementText, 'suggested\n');
		assert.strictEqual(suggestionFile?.chunks[0].appliedSuggestion?.suggestionId, 'suggestion-1');
		assert.strictEqual(suggestionFile?.aiReviewResult?.summary, 'Model returned 0 findings. Accepted 1 of 1 suggestions.');
		session.files.set(pendingUri.toString(), reviewFileState(pendingUri, 'src/pending.ts', { hunks: [pendingHunk] }));
		const reviewedFindingPayload = buildReviewDashboardPayload(session, reviewedUri, () => false, {
			...defaultLlmWikiDashboardState(),
			reviewFindings: [{
				id: 'finding-reviewed',
				uri: reviewedUri.toString(),
				relativePath: 'src/reviewed.ts',
				hunkId: reviewedHunk.id,
				line: reviewedHunk.newStart,
				severity: 'warning',
				title: 'Reviewed finding',
				explanation: 'Risk',
				recommendation: 'Fix',
				evidence: [],
				generationOrder: 0,
			}],
		});
		const reviewedFindingChunk = reviewedFindingPayload.files.find((file) => file.relativePath === 'src/reviewed.ts')?.chunks[0];
		assert.strictEqual(reviewedFindingChunk?.reviewStatus, 'reviewed');
		assert.strictEqual(reviewedFindingChunk?.findings[0].title, 'Reviewed finding');
	});

	test('posts dashboard state after file-level commands', async () => {
		const uri = vscode.Uri.file('D:/repo/src/pending.ts');
		const posted: unknown[] = [];
		const commands: Array<{ command: string; args: unknown[] }> = [];
		let messageHandler: ((message: unknown) => void) | undefined;
		const provider = new ReviewDashboardProvider(
			() => ({ currentReviewLabel: 'pending.ts', changeSignature: String(posted.length), files: [] }),
			async <T,>(command: string, ...args: unknown[]) => {
				commands.push({ command, args });
				return undefined as T;
			},
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
		assert.ok(view.webview.html.includes('<option value="deepseek">DeepSeek</option>'));
		assert.ok(view.webview.html.includes('Strict Tools (Beta)'));
		assert.ok(view.webview.html.includes('id="closeConfig"'));
		assert.ok(view.webview.html.includes('id="homeButton"'));
		assert.ok(view.webview.html.includes('home.svg'));
		assert.ok(view.webview.html.includes('id="settingsButton"'));
		assert.ok(view.webview.html.includes('id="settingsMenu"'));
		assert.ok(view.webview.html.includes('id="acceptAll"'));
		assert.ok(view.webview.html.includes('id="rejectAll"'));
		assert.ok(view.webview.html.includes('id="undoAll"'));
		assert.ok(view.webview.html.includes('id="wikiRunList"'));
		assert.ok(view.webview.html.includes('id="reviewFileDetail"'));
		assert.ok(view.webview.html.includes('function renderRunLog'));
		assert.ok(view.webview.html.includes('function groupRunLog'));
		assert.ok(view.webview.html.includes('function groupRunLogByFile'));
		assert.ok(view.webview.html.includes('function renderRunLogFile'));
		assert.ok(view.webview.html.includes('function renderRunLogRound'));
		assert.ok(view.webview.html.includes('function renderReviewFileDetail'));
		assert.ok(view.webview.html.includes('function aiReviewActionLabel'));
		assert.ok(view.webview.html.includes("return 'Generate AI review'"));
		assert.ok(view.webview.html.includes("return 'Retry AI review'"));
		assert.ok(view.webview.html.includes("return 'Continue AI review'"));
		assert.ok(view.webview.html.includes("return 'Regenerate AI review'"));
		assert.ok(view.webview.html.includes("wiki.aiReviewStatus === 'partial'"));
		assert.ok(view.webview.html.includes("typeof item.round === 'number'"));
		assert.ok(view.webview.html.includes('item.fileUri || item.relativePath'));
		assert.ok(view.webview.html.includes('wiki-run-detail'));
		assert.ok(view.webview.html.includes('wiki-run-round'));
		assert.ok(view.webview.html.includes('wiki-run-file'));
		assert.ok(view.webview.html.includes('review-file-detail'));
		assert.ok(view.webview.html.includes('review-chunk'));
		assert.ok(view.webview.html.includes('acceptAllButton.addEventListener'));
		assert.ok(view.webview.html.includes('rejectAllButton.addEventListener'));
		assert.ok(view.webview.html.includes('undoAllButton.addEventListener'));
		assert.ok(view.webview.html.includes("vscode.postMessage({ type: 'acceptAll' })"));
		assert.ok(view.webview.html.includes("vscode.postMessage({ type: 'rejectAll' })"));
		assert.ok(view.webview.html.includes("vscode.postMessage({ type: 'undoAll' })"));
		assert.ok(view.webview.html.includes('function updateBulkActionButtons'));
		assert.ok(view.webview.html.includes('acceptAllButton.disabled = pendingCount === 0'));
		assert.ok(view.webview.html.includes('rejectAllButton.disabled = pendingCount === 0'));
		assert.ok(view.webview.html.includes('undoAllButton.disabled = reviewedCount === 0'));
		assert.ok(view.webview.html.includes('openChunk'));
		assert.ok(view.webview.html.includes('.review-chunk.add'));
		assert.ok(view.webview.html.includes('.review-chunk.delete'));
		assert.ok(view.webview.html.includes('.review-chunk.modify'));
		assert.ok(view.webview.html.includes('.review-chunk.has-findings'));
		assert.ok(view.webview.html.includes('.review-chunk.has-suggestion'));
		assert.ok(view.webview.html.includes('function renderReviewChunkSuggestion'));
		assert.ok(view.webview.html.includes('review-suggestion-action'));
		assert.ok(view.webview.html.includes("type: applied ? 'undoAiSuggestion' : 'applyAiSuggestion'"));
		assert.ok(view.webview.html.includes('review-file-result'));
		assert.ok(view.webview.html.includes("details.setAttribute('open', '')"));
		assert.ok(view.webview.html.includes("chunk.reviewStatus === 'reviewed'"));
		assert.strictEqual(view.webview.html.includes('review-chunk-preview'), false);
		const dashboardSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'reviewDashboard.ts'), 'utf8');
		assert.strictEqual(dashboardSource.includes('dashboardChunkPreview'), false);
		assert.match(view.webview.html, /\.wiki-run-title\s*{[\s\S]*?font-size: 12px;/);
		assert.match(view.webview.html, /\.wiki-run-meta\s*{[\s\S]*?font-size: 10px;/);
		assert.match(view.webview.html, /\.wiki-run-detail pre\s*{[\s\S]*?font-size: 11px;/);
		assert.match(view.webview.html, /\.review-finding-title\s*{[\s\S]*?font-size: 12px;/);
		assert.match(view.webview.html, /\.review-finding-text\s*{[\s\S]*?font-size: 11px;/);
		assert.ok(view.webview.html.includes('height: 100vh;'));
		assert.ok(view.webview.html.includes('overflow: hidden;'));
		assert.ok(view.webview.html.includes('.wiki-panel.has-run-log'));
		assert.ok(view.webview.html.includes('.wiki-panel.has-review-detail'));
		assert.ok(view.webview.html.includes('.wiki-main.has-run-log'));
		assert.ok(view.webview.html.includes('.wiki-main.has-review-detail'));
		assert.ok(view.webview.html.includes('.wiki-main.has-run-log .wiki-run-list'));
		assert.ok(view.webview.html.includes("wikiPanel?.classList.toggle('has-run-log', hasRunLog)"));
		assert.ok(view.webview.html.includes("wikiPanel?.classList.toggle('has-review-detail', hasReviewDetail)"));
		assert.ok(view.webview.html.includes("wikiMain.classList.toggle('has-run-log', hasRunLog)"));
		assert.ok(view.webview.html.includes("wikiMain.classList.toggle('has-review-detail', hasReviewDetail)"));
		assert.ok(view.webview.html.includes('data-menu-action="initializeWiki"'));
		assert.ok(view.webview.html.includes('data-menu-action="updateWiki"'));
		assert.ok(view.webview.html.includes('data-menu-action="generateAiReview"'));
		assert.ok(view.webview.html.includes('data-menu-action="openWikiIndex"'));
		assert.ok(view.webview.html.includes('data-menu-action="openExtensionSettings"'));
		assert.ok(view.webview.html.includes('Wiki is up to date'));
		assert.ok(view.webview.html.includes('No pending source changes'));
		assert.ok(view.webview.html.includes('Agent is running'));
		assert.ok(view.webview.html.includes("llmApiKey.value = '********'"));
		assert.ok(view.webview.html.includes("apiKey: apiKeyPlaceholderActive ? '' : llmApiKey.value"));
		const modelIndex = view.webview.html.indexOf('id="modelPill"');
		const wikiPanelIndex = view.webview.html.indexOf('class="wiki-panel"');
		const reviewTreeIndex = view.webview.html.indexOf('class="review-tree"');
		assert.ok(modelIndex >= 0);
		assert.ok(modelIndex < wikiPanelIndex);
		assert.ok(modelIndex < reviewTreeIndex);
		const before = posted.length;
		messageHandler({ type: 'acceptFile', uri: uri.toString() });
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.ok(posted.length > before);
		messageHandler({
			type: 'saveLlmConfig',
			provider: 'deepseek',
			baseUrl: 'https://api.deepseek.com',
			model: 'deepseek-test',
			apiKey: 'secret',
			jsonOutputEnabled: true,
			thinkingMode: 'max',
			strictTools: true,
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		const save = commands.find((call) => call.command === 'cli-diff.saveLlmWikiConfig');
		assert.deepStrictEqual(save?.args[0], {
			provider: 'deepseek',
			baseUrl: 'https://api.deepseek.com',
			model: 'deepseek-test',
			apiKey: 'secret',
			jsonOutputEnabled: true,
			thinkingMode: 'max',
			strictTools: true,
		});
		messageHandler({ type: 'openWikiIndex' });
		messageHandler({ type: 'openExtensionSettings' });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(commands.some((call) => call.command === 'cli-diff.openWikiIndex' && call.args.length === 0));
		assert.ok(commands.some((call) => call.command === 'workbench.action.openSettings'
			&& call.args[0] === '@ext:local.cli-diff-review'));
		messageHandler({ type: 'acceptAll' });
		messageHandler({ type: 'rejectAll' });
		messageHandler({ type: 'undoAll' });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(commands.some((call) => call.command === 'cli-diff.acceptAll'));
		assert.ok(commands.some((call) => call.command === 'cli-diff.rejectAll'));
		assert.ok(commands.some((call) => call.command === 'cli-diff.undoAll'));
		messageHandler({ type: 'openChunk', uri: uri.toString(), hunkId: 'hunk-1' });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(commands.some((call) => call.command === 'cli-diff.openAiReviewFinding'
			&& call.args[0] === uri.toString()
			&& call.args[1] === 'hunk-1'));
		messageHandler({ type: 'applyAiSuggestion', uri: uri.toString(), hunkId: 'hunk-1', suggestionId: 'suggestion-1' });
		messageHandler({ type: 'undoAiSuggestion', uri: uri.toString(), hunkId: 'hunk-1', suggestionId: 'suggestion-1' });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(commands.some((call) => call.command === 'cli-diff.applyAiSuggestion'
			&& call.args[0] === uri.toString()
			&& call.args[1] === 'hunk-1'
			&& call.args[2] === 'suggestion-1'));
		assert.ok(commands.some((call) => call.command === 'cli-diff.undoAiSuggestion'
			&& call.args[0] === uri.toString()
			&& call.args[1] === 'hunk-1'
			&& call.args[2] === 'suggestion-1'));
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

		assert.strictEqual(valid.files.length, 9);
		assert.strictEqual(normalizeWikiFilePath('modules/review-dashboard.md'), 'modules/review-dashboard.md');
		assert.throws(() => normalizeWikiFilePath('../outside.md'));
		assert.throws(() => normalizeWikiFilePath('/absolute.md'));
		assert.throws(() => normalizeWikiFilePath('C:/repo/wiki.md'));
		assert.throws(() => normalizeWikiFilePath('notes.txt'));
		assert.throws(() => validateWikiInitializationResponse({ ...validWikiResponse(), files: [] }));
		const missingInterface = validWikiResponse();
		assert.throws(() => validateWikiInitializationResponse({
			...missingInterface,
			files: missingInterface.files.filter((file) => file.path !== 'interfaces.md'),
		}));
	});

	test('passes Agent trace events through Wiki initialization', async () => {
		const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-extension-'));
		const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-wiki-init-'));
		try {
			writeRepoFile(extensionRoot, 'llm-code-wiki/llm-code-wiki.md', '# Generic Wiki\n');
			writeRepoFile(repositoryRoot, 'src/app.ts', 'export const value = 1;\n');
			const wiki = validWikiResponse();
			const responses = [
				JSON.stringify({
					type: 'tool_calls',
					calls: wiki.files.map((file, index) => ({
						id: `write-${index}`,
						name: 'write_wiki_file',
						arguments: file,
					})),
				}),
				'{"type":"final","result":{"summary":"Generated wiki.","warnings":[]}}',
			];
			const trace: AgentTraceEvent[] = [];
			const service = new WikiInitializationService(vscode.Uri.file(extensionRoot));
			const result = await service.initialize({
				root: workspaceFolder(repositoryRoot),
				config: { provider: 'openai', baseUrl: 'https://example.test', model: 'wiki-test', apiKey: 'secret' },
				client: { completeJson: async () => responses.shift() ?? '' },
				onTrace: (event) => trace.push(event),
			});

			assert.strictEqual(result.summary, 'Generated wiki.');
			assert.ok(trace.some((event) => event.kind === 'llm_request'));
			assert.ok(trace.some((event) => event.kind === 'tool_result' && event.summary.includes('write_wiki_file')));
			assert.ok(trace.some((event) => event.kind === 'run_complete'));
		} finally {
			fs.rmSync(extensionRoot, { recursive: true, force: true });
			fs.rmSync(repositoryRoot, { recursive: true, force: true });
		}
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
		const body = JSON.parse(String(calls[0].init?.body));
		assert.strictEqual(body.model, 'gpt-test');
		assert.deepStrictEqual(body.response_format, { type: 'json_object' });
	});

	test('allows OpenAI-compatible JSON Output to be disabled explicitly', async () => {
		let body: Record<string, unknown> = {};
		const client = new OpenAiCompatibleClient('https://api.example.test/v1', 'secret', async (_input, init) => {
			body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ choices: [{ message: { content: '{"version":1}' } }] }), { status: 200 });
		}, false);

		await client.completeJson({ model: 'custom', systemPrompt: 'json system', userPrompt: 'user' });

		assert.strictEqual(body.response_format, undefined);
	});

	test('sends DeepSeek JSON Output, thinking, and strict native tools', async () => {
		const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
		const client = new DeepSeekClient('https://api.deepseek.com', 'secret', 'high', true, async (input, init) => {
			calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
			return new Response(JSON.stringify({
				choices: [{
					message: {
						content: '',
						reasoning_content: 'Need the source file.',
						tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/app.ts"}' } }],
					},
				}],
			}), { status: 200 });
		});
		const completion = await client.complete({
			model: 'deepseek-test',
			messages: [{ role: 'user', content: 'Use json and inspect the file.' }],
			tools: [{
				name: 'read_file',
				description: 'Read a file.',
				parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
			}],
		});

		assert.strictEqual(calls[0].url, 'https://api.deepseek.com/beta/chat/completions');
		assert.deepStrictEqual(calls[0].body.response_format, { type: 'json_object' });
		assert.deepStrictEqual(calls[0].body.thinking, { type: 'enabled' });
		assert.strictEqual(calls[0].body.reasoning_effort, 'high');
		assert.strictEqual(calls[0].body.temperature, undefined);
		const tools = calls[0].body.tools as Array<{ function: { strict: boolean } }>;
		assert.strictEqual(tools[0].function.strict, true);
		assert.strictEqual(completion.reasoningContent, 'Need the source file.');
		assert.strictEqual(completion.toolCalls[0].name, 'read_file');
	});

	test('supports DeepSeek disabled thinking and non-strict tools', async () => {
		let url = '';
		let body: Record<string, unknown> = {};
		const client = new DeepSeekClient('https://api.deepseek.com', 'secret', 'disabled', false, async (input, init) => {
			url = String(input);
			body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ choices: [{ message: { content: '{"type":"final","result":{}}' } }] }), { status: 200 });
		});

		await client.completeJson({ model: 'deepseek-test', systemPrompt: 'json system', userPrompt: 'user', temperature: 0.2 });

		assert.strictEqual(url, 'https://api.deepseek.com/chat/completions');
		assert.deepStrictEqual(body.thinking, { type: 'disabled' });
		assert.strictEqual(body.temperature, 0.2);
		assert.strictEqual(body.reasoning_effort, undefined);
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
		assert.strictEqual(saved.jsonOutputEnabled, false);
		assert.strictEqual(saved.thinkingMode, 'disabled');
		assert.strictEqual(saved.strictTools, false);
		assert.strictEqual(globalState.values.has('cliDiff.llm.apiKey'), false);

		await store.save({
			provider: 'anthropic',
			baseUrl: 'https://api.anthropic.com',
			model: 'claude-updated',
			apiKey: '',
		});
		assert.strictEqual((await store.runtimeConfig())?.apiKey, 'secret-key');
	});

	test('stores DeepSeek capabilities and applies provider defaults', async () => {
		const globalState = new TestMemento();
		const secrets = new TestSecretStorage();
		const store = new LlmConfigStore({ globalState, secrets } as unknown as vscode.ExtensionContext);

		const saved = await store.save({
			provider: 'deepseek',
			baseUrl: '',
			model: 'deepseek-custom',
			apiKey: 'secret-key',
			jsonOutputEnabled: false,
			thinkingMode: 'max',
			strictTools: false,
		});

		assert.strictEqual(saved.baseUrl, 'https://api.deepseek.com');
		assert.strictEqual(saved.jsonOutputEnabled, true);
		assert.strictEqual(saved.thinkingMode, 'max');
		assert.strictEqual(saved.strictTools, false);
	});

	test('migrates legacy provider config to capability defaults', async () => {
		const openAiState = new TestMemento();
		openAiState.values.set('cliDiff.llm.provider', 'openai');
		const anthropicState = new TestMemento();
		anthropicState.values.set('cliDiff.llm.provider', 'anthropic');
		const secrets = new TestSecretStorage();

		const openAi = await new LlmConfigStore({ globalState: openAiState, secrets } as unknown as vscode.ExtensionContext).savedConfig();
		const anthropic = await new LlmConfigStore({ globalState: anthropicState, secrets } as unknown as vscode.ExtensionContext).savedConfig();

		assert.strictEqual(openAi.jsonOutputEnabled, true);
		assert.strictEqual(anthropic.jsonOutputEnabled, false);
		assert.strictEqual(openAi.thinkingMode, 'disabled');
		assert.strictEqual(anthropic.strictTools, false);
	});

	test('migrates legacy OpenAI-compatible official DeepSeek config', async () => {
		const globalState = new TestMemento();
		globalState.values.set('cliDiff.llm.provider', 'openai');
		globalState.values.set('cliDiff.llm.baseUrl', 'https://api.deepseek.com');
		globalState.values.set('cliDiff.llm.model', 'deepseek-v4-pro');
		const secrets = new TestSecretStorage();

		const saved = await new LlmConfigStore({ globalState, secrets } as unknown as vscode.ExtensionContext).savedConfig();

		assert.strictEqual(saved.provider, 'deepseek');
		assert.strictEqual(saved.baseUrl, 'https://api.deepseek.com');
		assert.strictEqual(saved.model, 'deepseek-v4-pro');
		assert.strictEqual(saved.jsonOutputEnabled, true);
		assert.strictEqual(saved.thinkingMode, 'high');
		assert.strictEqual(saved.strictTools, true);
		assert.strictEqual(globalState.values.get('cliDiff.llm.provider'), 'deepseek');
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
			pendingSourceCount: 0,
			wikiNeedsUpdate: false,
			findings: [],
			jsonOutputEnabled: true,
			thinkingMode: 'disabled' as const,
			strictTools: false,
			runLog: [{
				id: 'wiki-run-1',
				sequence: 1,
				timestamp: '2026-06-13T00:00:00.000Z',
				kind: 'llm_request' as const,
				title: 'LLM request',
				summary: 'Round 1 request',
				round: 1,
				status: 'running' as const,
				details: [{ label: 'Request', format: 'json' as const, content: '{"model":"gpt-test"}' }],
			}],
			reviewFindings: [],
			reviewSuggestions: [],
			aiReviewFileResults: [],
			aiReviewStatus: 'none' as const,
			aiReviewCompletedFileCount: 0,
			aiReviewTotalFileCount: 0,
		};
		const defaultPayload = buildReviewDashboardPayload(undefined, undefined, () => false);
		const payload = buildReviewDashboardPayload(undefined, undefined, () => false, wiki);

		assert.deepStrictEqual(defaultPayload.llmWiki?.runLog, []);
		assert.deepStrictEqual(defaultPayload.llmWiki?.reviewFindings, []);
		assert.deepStrictEqual(defaultPayload.llmWiki?.reviewSuggestions, []);
		assert.deepStrictEqual(defaultPayload.llmWiki?.aiReviewFileResults, []);
		assert.strictEqual(defaultPayload.llmWiki?.aiReviewStatus, 'none');
		assert.strictEqual(defaultPayload.llmWiki?.aiReviewCompletedFileCount, 0);
		assert.strictEqual(defaultPayload.llmWiki?.aiReviewTotalFileCount, 0);
		assert.ok(payload.llmWiki);
		assert.strictEqual(payload.llmWiki.configured, true);
		assert.strictEqual(payload.llmWiki.model, 'gpt-test');
		assert.strictEqual(payload.llmWiki.runLog[0].summary, 'Round 1 request');
		assert.deepStrictEqual(payload.files, []);
	});
});

suite('Agent runtime', () => {
	test('runs strict multi-round tool calls and returns final result', async () => {
		const responses = [
			'{"type":"tool_calls","calls":[{"id":"call-1","name":"echo","arguments":{"value":"hello"}}]}',
			'{"type":"final","result":{"summary":"done"}}',
		];
		const trace: AgentTraceEvent[] = [];
		const runner = new AgentRunner();
		const result = await runner.run({
			config: { provider: 'openai', baseUrl: 'https://example.test', model: 'test', apiKey: 'secret' },
			client: { completeJson: async () => responses.shift() ?? '' },
			systemPrompt: 'test',
			userPrompt: 'test',
			tools: [{
				name: 'echo',
				description: 'Echo.',
				parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
				execute: async (args) => args,
			}],
			onTrace: (event) => trace.push(event),
		});

		assert.strictEqual(result.result.summary, 'done');
		assert.strictEqual(result.rounds, 2);
		assert.strictEqual(result.toolCalls, 1);
		assert.deepStrictEqual(trace.map((event) => event.kind), [
			'run_start',
			'llm_request',
			'llm_response',
			'parse_success',
			'tool_call',
			'tool_result',
			'tool_results_context',
			'llm_request',
			'llm_response',
			'parse_success',
			'run_complete',
		]);
		assert.ok(trace.find((event) => event.kind === 'llm_request')?.details[0].content.includes('"messages"'));
		assert.ok(!JSON.stringify(trace).includes('secret'));
	});

	test('rejects invalid Agent actions and unavailable tools', async () => {
		assert.throws(() => validateAgentResponse({ type: 'tool_calls', calls: [] }));
		assert.throws(() => validateAgentResponse({ type: 'final', result: [] }));
		const runner = new AgentRunner();
		await assert.rejects(() => runner.run({
			config: { provider: 'openai', baseUrl: 'https://example.test', model: 'test', apiKey: 'secret' },
			client: { completeJson: async () => '{"type":"tool_calls","calls":[{"id":"x","name":"missing","arguments":{}}]}' },
			systemPrompt: 'test',
			userPrompt: 'test',
			tools: [],
		}), /unavailable tool/);
	});

	test('corrects invalid text JSON with parse diagnostics and raw response', async () => {
		const requests: unknown[] = [];
		const responses = ['Now I have enough context.', '{"type":"final","result":{"summary":"done"}}'];
		const trace: AgentTraceEvent[] = [];
		const runner = new AgentRunner();
		const result = await runner.run({
			config: { provider: 'openai', baseUrl: 'https://example.test', model: 'test', apiKey: 'secret' },
			client: {
				completeJson: async (request) => {
					requests.push(request);
					return responses.shift() ?? '';
				},
			},
			systemPrompt: 'test json',
			userPrompt: 'test',
			tools: [],
			onTrace: (event) => trace.push(event),
		});

		assert.strictEqual(result.result.summary, 'done');
		assert.strictEqual(requests.length, 2);
		const correctionRequest = JSON.stringify(requests[1]);
		assert.ok(correctionRequest.includes('Parser error:'));
		assert.ok(correctionRequest.includes('Previous raw response:'));
		assert.ok(correctionRequest.includes('Now I have enough context.'));
		assert.ok(trace.some((event) => event.kind === 'parse_error' && event.summary.includes('Unexpected token')));
		assert.ok(trace.some((event) => event.kind === 'parse_success' && event.summary === 'Parsed final result'));
	});

	test('retries malformed Agent JSON with two correction attempts', async () => {
		const requests: unknown[] = [];
		const responses = [
			'{"type":"final","result":{"summary":"broken"',
			'Still not JSON.',
			'{"type":"final","result":{"summary":"fixed"}}',
		];
		const trace: AgentTraceEvent[] = [];
		const runner = new AgentRunner();
		const result = await runner.run({
			config: { provider: 'openai', baseUrl: 'https://example.test', model: 'test', apiKey: 'secret' },
			client: {
				completeJson: async (request) => {
					requests.push(request);
					return responses.shift() ?? '';
				},
			},
			systemPrompt: 'test json',
			userPrompt: 'test',
			tools: [],
			onTrace: (event) => trace.push(event),
		});

		assert.strictEqual(result.result.summary, 'fixed');
		assert.strictEqual(requests.length, 3);
		assert.ok(JSON.stringify(requests[1]).includes('Parser error:'));
		assert.ok(JSON.stringify(requests[1]).includes('Previous raw response:'));
		assert.ok(JSON.stringify(requests[1]).includes('broken'));
		assert.ok(JSON.stringify(requests[2]).includes('Still not JSON.'));
		assert.strictEqual(trace.filter((event) => event.kind === 'parse_error').length, 2);
		assert.ok(trace.some((event) => event.kind === 'parse_success' && event.summary === 'Parsed final result'));
	});

	test('uses DeepSeek native tools and returns reasoning content on the next round', async () => {
		const requests: Array<{ messages?: Array<{ role: string; reasoningContent?: string; toolCallId?: string }> }> = [];
		const trace: AgentTraceEvent[] = [];
		const completions = [
			{
				content: '',
				reasoningContent: 'I need to echo.',
				toolCalls: [{ id: 'call-1', name: 'echo', arguments: '{"value":"hello"}' }],
			},
			{ content: '{"type":"final","result":{"summary":"done"}}', toolCalls: [] },
		];
		const runner = new AgentRunner();
		const result = await runner.run({
			config: {
				provider: 'deepseek',
				baseUrl: 'https://api.deepseek.com',
				model: 'deepseek-test',
				apiKey: 'secret',
				jsonOutputEnabled: true,
				thinkingMode: 'high',
				strictTools: true,
			},
			client: {
				completeJson: async () => '',
				complete: async (request) => {
					requests.push(request);
					return completions.shift() ?? { content: '', toolCalls: [] };
				},
			},
			systemPrompt: 'test json',
			userPrompt: 'test',
			tools: [{
				name: 'echo',
				description: 'Echo.',
				parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
				execute: async (args) => args,
			}],
			onTrace: (event) => trace.push(event),
		});

		assert.strictEqual(result.result.summary, 'done');
		assert.strictEqual(requests.length, 2);
		assert.ok(requests[1].messages?.some((message) => message.role === 'assistant' && message.reasoningContent === 'I need to echo.'));
		assert.ok(requests[1].messages?.some((message) => message.role === 'tool' && message.toolCallId === 'call-1'));
		assert.ok(trace.some((event) => event.kind === 'llm_response' && event.summary.includes('native tool call')));
		assert.ok(trace.some((event) => event.kind === 'tool_results_context'));
		assert.ok(JSON.stringify(trace).includes('I need to echo.'));
		assert.ok(JSON.stringify(trace).includes('toolCallId'));
	});

	test('corrects empty or invalid DeepSeek native tool output once', async () => {
		const completions = [
			{ content: '', toolCalls: [] },
			{ content: '{"type":"final","result":{"summary":"fixed"}}', toolCalls: [] },
		];
		const runner = new AgentRunner();
		const result = await runner.run({
			config: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-test', apiKey: 'secret' },
			client: {
				completeJson: async () => '',
				complete: async () => completions.shift() ?? { content: '', toolCalls: [] },
			},
			systemPrompt: 'test json',
			userPrompt: 'test',
			tools: [],
		});
		assert.strictEqual(result.result.summary, 'fixed');
	});

	test('corrects invalid DeepSeek native tool arguments once', async () => {
		const completions = [
			{ content: '', toolCalls: [{ id: 'bad', name: 'echo', arguments: '{"value":1}' }] },
			{ content: '{"type":"final","result":{"summary":"fixed arguments"}}', toolCalls: [] },
		];
		const runner = new AgentRunner();
		const result = await runner.run({
			config: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-test', apiKey: 'secret' },
			client: {
				completeJson: async () => '',
				complete: async () => completions.shift() ?? { content: '', toolCalls: [] },
			},
			systemPrompt: 'test json',
			userPrompt: 'test',
			tools: [{
				name: 'echo',
				description: 'Echo.',
				parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
				execute: async (args) => args,
			}],
		});
		assert.strictEqual(result.result.summary, 'fixed arguments');
	});

	test('reports provider, model, and preview after correction retries fail', async () => {
		const runner = new AgentRunner();
		await assert.rejects(() => runner.run({
			config: { provider: 'openai', baseUrl: 'https://example.test', model: 'broken-model', apiKey: 'secret' },
			client: { completeJson: async () => 'Now I have no JSON.' },
			systemPrompt: 'test json',
			userPrompt: 'test',
			tools: [],
		}), /OpenAI-compatible model "broken-model".*two correction retries.*Now I have no JSON/);
	});

	test('enforces cancellation and runtime limits', async () => {
		const runner = new AgentRunner();
		const waitForAbort = async (_request: unknown, signal?: AbortSignal): Promise<string> => new Promise((_resolve, reject) => {
			signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
		});
		await assert.rejects(() => runner.run({
			config: { provider: 'openai', baseUrl: 'https://example.test', model: 'test', apiKey: 'secret' },
			client: { completeJson: waitForAbort },
			systemPrompt: 'test',
			userPrompt: 'test',
			tools: [],
			maxRunMs: 5,
		}), /runtime limit/);

		const abortController = new AbortController();
		abortController.abort();
		await assert.rejects(() => runner.run({
			config: { provider: 'openai', baseUrl: 'https://example.test', model: 'test', apiKey: 'secret' },
			client: { completeJson: async () => '{"type":"final","result":{}}' },
			systemPrompt: 'test',
			userPrompt: 'test',
			tools: [],
			signal: abortController.signal,
		}), /cancelled/i);
	});

	test('reports finite round limits and supports unlimited round mode', async () => {
		const tool = {
			name: 'echo',
			description: 'Echo.',
			parameters: { type: 'object', properties: {}, additionalProperties: false },
			execute: async () => ({}),
		};
		const limitedRunner = new AgentRunner();
		await assert.rejects(() => limitedRunner.run({
			config: { provider: 'openai', baseUrl: 'https://example.test', model: 'test', apiKey: 'secret' },
			client: { completeJson: async () => '{"type":"tool_calls","calls":[{"id":"call-1","name":"echo","arguments":{}}]}' },
			systemPrompt: 'test',
			userPrompt: 'test',
			tools: [tool],
			maxRounds: 1,
		}), /Agent exceeded its round limit \(1\)\./);

		const responses = [
			'{"type":"tool_calls","calls":[{"id":"call-1","name":"echo","arguments":{}}]}',
			'{"type":"final","result":{"summary":"done"}}',
		];
		const unlimitedResult = await new AgentRunner().run({
			config: { provider: 'openai', baseUrl: 'https://example.test', model: 'test', apiKey: 'secret' },
			client: { completeJson: async () => responses.shift() ?? '' },
			systemPrompt: 'test',
			userPrompt: 'test',
			tools: [tool],
			maxRounds: 'unlimited',
			maxRunMs: 1000,
		});

		assert.strictEqual(unlimitedResult.rounds, 2);
		assert.strictEqual(unlimitedResult.result.summary, 'done');
	});

	test('reads deleted review files from the review session snapshot', async () => {
		const uri = vscode.Uri.file('/repo/src/deleted.ts');
		const hunk = computeLineDiff(uri.toString(), 'export const removed = true;\n', '')[0];
		const session: ReviewSession = {
			id: 'deleted-read',
			mode: 'git',
			rootUri: vscode.Uri.file('/repo'),
			createdAt: 1,
			files: new Map([[uri.toString(), reviewFileState(uri, 'src/deleted.ts', {
				oldText: 'export const removed = true;\n',
				newText: '',
				hunks: [hunk],
				currentExists: false,
			})]]),
		};
		const tools = createReadOnlyAgentTools({ root: workspaceFolder('/repo'), reviewSession: session });
		const list = await tools.find((tool) => tool.name === 'list_workspace_files')?.execute({}, undefined) as { files: string[] };
		const read = await tools.find((tool) => tool.name === 'read_workspace_file')?.execute({ path: 'src/deleted.ts' }, undefined) as {
			content: string;
			currentExists: boolean;
			contentSource: string;
		};
		const search = await tools.find((tool) => tool.name === 'search_workspace')?.execute({ query: 'removed', limit: 10 }, undefined) as {
			matches: Array<{ path: string; text: string }>;
		};

		assert.ok(list.files.includes('src/deleted.ts'));
		assert.strictEqual(read.content, 'export const removed = true;\n');
		assert.strictEqual(read.currentExists, false);
		assert.strictEqual(read.contentSource, 'reviewOldText');
		assert.strictEqual(search.matches[0].path, 'src/deleted.ts');
		assert.ok(search.matches[0].text.includes('removed'));
	});

	test('protects Wiki template and state files from Agent writes', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-agent-'));
		try {
			const tools = createWikiAgentTools({ root: workspaceFolder(root), generatedFiles: new Set() });
			const write = tools.find((tool) => tool.name === 'write_wiki_file');
			assert.ok(write);
			await assert.rejects(() => write.execute({ path: 'llm-code-wiki.md', content: 'changed' }), /protected/);
			await assert.rejects(() => write.execute({ path: '../outside.md', content: 'changed' }), /Invalid relative path/);
			await write.execute({ path: 'overview.md', content: '# Overview\n' });
			assert.strictEqual(fs.readFileSync(path.join(root, '.wiki', 'overview.md'), 'utf8'), '# Overview\n');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

suite('Wiki state', () => {
	test('copies the generic specification and detects source fingerprint changes', async () => {
		const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-extension-'));
		const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-wiki-state-'));
		try {
			writeRepoFile(extensionRoot, 'llm-code-wiki/llm-code-wiki.md', '# Generic Wiki\n');
			writeRepoFile(repositoryRoot, 'src/app.ts', 'export const value = 1;\n');
			writeRepoFile(repositoryRoot, '.env', 'secret\n');
			const folder = workspaceFolder(repositoryRoot);
			const service = new WikiStateService(vscode.Uri.file(extensionRoot));
			const state = await service.ensureScaffold(folder, 'initializing');

			assert.strictEqual(fs.readFileSync(path.join(repositoryRoot, '.wiki', 'llm-code-wiki.md'), 'utf8'), '# Generic Wiki\n');
			const ready = await service.completeRun(folder, state, 'done', ['overview.md']);
			assert.strictEqual(ready.status, 'ready');
			assert.ok(ready.sourceFingerprints['src/app.ts']);
			assert.strictEqual(ready.sourceFingerprints['.env'], undefined);

			writeRepoFile(repositoryRoot, 'src/app.ts', 'export const value = 2;\n');
			writeRepoFile(repositoryRoot, 'src/new.ts', 'export const next = true;\n');
			const diff = await service.sourceDiff(folder, ready);
			assert.deepStrictEqual(diff.added, ['src/new.ts']);
			assert.deepStrictEqual(diff.modified, ['src/app.ts']);
		} finally {
			fs.rmSync(extensionRoot, { recursive: true, force: true });
			fs.rmSync(repositoryRoot, { recursive: true, force: true });
		}
	});
});

suite('AI review findings', () => {
	test('passes Agent trace events with file context through AI review', async () => {
		const firstUri = vscode.Uri.file('/repo/src/a.ts');
		const secondUri = vscode.Uri.file('/repo/src/b.ts');
		const firstHunk = computeLineDiff(firstUri.toString(), 'a\n', 'aa\n')[0];
		const secondHunk = computeLineDiff(secondUri.toString(), 'b\n', 'bb\n')[0];
		const session: ReviewSession = {
			id: 'ai-review-trace',
			mode: 'git',
			rootUri: vscode.Uri.file('/repo'),
			createdAt: 1,
			files: new Map([
				[firstUri.toString(), reviewFileState(firstUri, 'src/a.ts', { hunks: [firstHunk] })],
				[secondUri.toString(), reviewFileState(secondUri, 'src/b.ts', { hunks: [secondHunk] })],
			]),
		};
		const responses = [
			`{"type":"final","result":{"findings":[{"hunkId":"${firstHunk.id}","severity":"warning","title":"A","explanation":"Risk A","recommendation":"Fix A"}]}}`,
			`{"type":"final","result":{"findings":[{"hunkId":"${secondHunk.id}","severity":"info","title":"B","explanation":"Risk B","recommendation":"Fix B"}]}}`,
		];
		const trace: Array<{ event: AgentTraceEvent; relativePath: string; fileIndex: number; fileCount: number }> = [];
		const service = new CodeReviewAgentService();

		const result = await service.review({
			session,
			root: workspaceFolder('/repo'),
			config: { provider: 'openai', baseUrl: 'https://example.test', model: 'test', apiKey: 'secret' },
			client: { completeJson: async () => responses.shift() ?? '' },
			language: 'en',
			onTrace: (event, context) => trace.push({
				event,
				relativePath: context.relativePath,
				fileIndex: context.fileIndex,
				fileCount: context.fileCount,
			}),
		});

		assert.strictEqual(result.findings.length, 2);
		assert.ok(trace.some((item) => item.event.kind === 'llm_request' && item.relativePath === 'src/a.ts' && item.fileIndex === 1 && item.fileCount === 2));
		assert.ok(trace.some((item) => item.event.title === 'Review findings parsed' && item.relativePath === 'src/b.ts'));
	});

	test('keeps completed file findings after a later AI review file fails and resumes from partial review', async () => {
		const firstUri = vscode.Uri.file('/repo/src/a.ts');
		const secondUri = vscode.Uri.file('/repo/src/b.ts');
		const firstHunk = computeLineDiff(firstUri.toString(), 'a\n', 'aa\n')[0];
		const secondHunk = computeLineDiff(secondUri.toString(), 'b\n', 'bb\n')[0];
		const session: ReviewSession = {
			id: 'ai-review-partial',
			mode: 'git',
			rootUri: vscode.Uri.file('/repo'),
			createdAt: 1,
			files: new Map([
				[firstUri.toString(), reviewFileState(firstUri, 'src/a.ts', { hunks: [firstHunk] })],
				[secondUri.toString(), reviewFileState(secondUri, 'src/b.ts', { hunks: [secondHunk] })],
			]),
		};
		const completions: StoredAiReview[] = [];
		let partial: StoredAiReview | undefined;

		try {
			await new CodeReviewAgentService().review({
				session,
				root: workspaceFolder('/repo'),
				config: { provider: 'openai', baseUrl: 'https://example.test', model: 'test', apiKey: 'secret' },
				client: {
					completeJson: async (request) => {
						const userPrompt = request.messages?.find((message) => message.role === 'user')?.content ?? '';
						if (userPrompt.includes('src/a.ts')) {
							return `{"type":"final","result":{"findings":[{"hunkId":"${firstHunk.id}","severity":"warning","title":"A","explanation":"Risk A","recommendation":"Fix A"}]}}`;
						}
						return '{"type":"final","result":{"findings":"bad"}}';
					},
				},
				language: 'en',
				maxRounds: 64,
				onFileComplete: (review) => {
					completions.push(review);
				},
			});
			assert.fail('Expected partial AI review failure.');
		} catch (error) {
			assert.ok(error instanceof AiReviewPartialError);
			partial = error.review;
		}

		assert.ok(partial);
		assert.strictEqual(completions.length, 1);
		assert.strictEqual(completions[0].status, 'partial');
		assert.deepStrictEqual(completions[0].completedFiles, [firstUri.toString()]);
		assert.strictEqual(completions[0].findings[0].title, 'A');
		assert.strictEqual(partial.status, 'partial');
		assert.strictEqual(partial.failedFile, secondUri.toString());
		assert.strictEqual(partial.findings[0].title, 'A');

		const retryPrompts: string[] = [];
		const retried = await new CodeReviewAgentService().review({
			session,
			root: workspaceFolder('/repo'),
			config: { provider: 'openai', baseUrl: 'https://example.test', model: 'test', apiKey: 'secret' },
			client: {
				completeJson: async (request) => {
					retryPrompts.push(request.messages?.find((message) => message.role === 'user')?.content ?? '');
					return `{"type":"final","result":{"findings":[{"hunkId":"${secondHunk.id}","severity":"info","title":"B","explanation":"Risk B","recommendation":"Fix B"}]}}`;
				},
			},
			language: 'en',
			existingReview: partial,
			maxRounds: 'unlimited',
		});

		assert.deepStrictEqual(retryPrompts.map((prompt) => prompt.includes('src/b.ts')), [true]);
		assert.strictEqual(retryPrompts.some((prompt) => prompt.includes('src/a.ts')), false);
		assert.strictEqual(retried.status, 'complete');
		assert.deepStrictEqual(retried.completedFiles, [firstUri.toString(), secondUri.toString()]);
		assert.deepStrictEqual(retried.findings.map((finding) => finding.title), ['A', 'B']);
	});

	test('adds configured finding language instruction to AI review prompts', async () => {
		const uri = vscode.Uri.file('/repo/src/app.ts');
		const hunk = computeLineDiff(uri.toString(), 'old\n', 'new\n')[0];
		const file = reviewFileState(uri, 'src/app.ts', { hunks: [hunk] });
		const session: ReviewSession = {
			id: 'ai-review-language',
			mode: 'git',
			rootUri: vscode.Uri.file('/repo'),
			createdAt: 1,
			files: new Map([[uri.toString(), file]]),
		};
		const reviewWithLanguage = async (language: 'zh-CN' | 'en'): Promise<string> => {
			let systemPrompt = '';
			await new CodeReviewAgentService().review({
				session,
				root: workspaceFolder('/repo'),
				config: { provider: 'openai', baseUrl: 'https://example.test', model: 'test', apiKey: 'secret' },
				client: {
					completeJson: async (request) => {
						systemPrompt = request.messages?.find((message) => message.role === 'system')?.content ?? '';
						return '{"type":"final","result":{"findings":[]}}';
					},
				},
				language,
			});
			return systemPrompt;
		};

		const zhPrompt = await reviewWithLanguage('zh-CN');
		const enPrompt = await reviewWithLanguage('en');
		assert.ok(zhPrompt.includes('Simplified Chinese'));
		assert.ok(enPrompt.includes('English'));
		assert.ok(zhPrompt.includes('Do not translate hunkId values'));
		assert.ok(enPrompt.includes('Do not translate hunkId values'));
		assert.ok(zhPrompt.includes('Keep finding title, explanation, and recommendation concise'));
		assert.ok(enPrompt.includes('valid JSON string content'));
		assert.ok(enPrompt.includes('replacementText replaces the entire current newText'));
		assert.ok(enPrompt.includes('Do not create suggestions for delete hunks'));
	});

	test('stores AI code suggestions and file-level no-finding diagnostics', async () => {
		const uri = vscode.Uri.file('/repo/src/app.ts');
		const hunk = computeLineDiff(uri.toString(), 'old\n', 'new\n')[0];
		const session: ReviewSession = {
			id: 'ai-review-suggestion',
			mode: 'git',
			rootUri: vscode.Uri.file('/repo'),
			createdAt: 1,
			files: new Map([[uri.toString(), reviewFileState(uri, 'src/app.ts', { hunks: [hunk] })]]),
		};

		const result = await new CodeReviewAgentService().review({
			session,
			root: workspaceFolder('/repo'),
			config: { provider: 'openai', baseUrl: 'https://example.test', model: 'test', apiKey: 'secret' },
			client: {
				completeJson: async () => `{"type":"final","result":{"findings":[],"suggestions":[{"hunkId":"${hunk.id}","replacementText":"better\\n","rationale":"Tighter implementation."}]}}`,
			},
			language: 'en',
		});

		assert.strictEqual(result.findings.length, 0);
		assert.strictEqual(result.suggestions.length, 1);
		assert.strictEqual(result.suggestions[0].replacementText, 'better\n');
		assert.strictEqual(result.fileResults[0].acceptedFindingCount, 0);
		assert.strictEqual(result.fileResults[0].acceptedSuggestionCount, 1);
		assert.ok(result.fileResults[0].summary.includes('Model returned 0 findings.'));
	});

	test('drops AI code suggestions for delete chunks', () => {
		const uri = vscode.Uri.file('/repo/src/deleted.ts');
		const hunk = computeLineDiff(uri.toString(), 'old\n', '')[0];
		const file = reviewFileState(uri, 'src/deleted.ts', { hunks: [hunk] });
		const validation = validateReviewSuggestionsWithDiagnostics({
			findings: [],
			suggestions: [{ hunkId: hunk.id, replacementText: 'restore\n', rationale: 'Restore it.' }],
		}, file);

		assert.strictEqual(validation.suggestions.length, 0);
		assert.strictEqual(validation.diagnostics.rawCount, 1);
		assert.strictEqual(validation.diagnostics.dropped.length, 1);
		assert.ok(validation.diagnostics.dropped[0].reason.includes('Delete chunks'));
	});

	test('drops findings that do not bind to a current pending hunk', () => {
		const uri = vscode.Uri.file('/repo/src/app.ts');
		const hunk = computeLineDiff(uri.toString(), 'old\n', 'new\n')[0];
		const file = reviewFileState(uri, 'src/app.ts', { hunks: [hunk] });
		const findings = validateReviewFindings({
			findings: [
				{ hunkId: 'missing', severity: 'warning', title: 'x', explanation: 'x', recommendation: 'x', evidence: [] },
				{ hunkId: hunk.id, severity: 'warning', title: 'Bound', explanation: 'Risk', recommendation: 'Fix', evidence: ['src/app.ts:1'] },
			],
		}, file);

		assert.strictEqual(findings.length, 1);
		assert.strictEqual(findings[0].title, 'Bound');
	});

	test('reports finding validation diagnostics for empty and invalid responses', () => {
		const uri = vscode.Uri.file('/repo/src/app.ts');
		const hunk = computeLineDiff(uri.toString(), 'old\n', 'new\n')[0];
		const file = reviewFileState(uri, 'src/app.ts', { hunks: [hunk] });
		const empty = validateReviewFindingsWithDiagnostics({ findings: [] }, file);
		const filtered = validateReviewFindingsWithDiagnostics({
			findings: [
				{ hunkId: 'missing', severity: 'warning', title: 'x', explanation: 'x', recommendation: 'x' },
				{ hunkId: hunk.id, severity: 'bad', title: 'x', explanation: 'x', recommendation: 'x' },
				{ hunkId: hunk.id, severity: 'warning', title: 'Bound', explanation: 'Risk', recommendation: 'Fix' },
			],
		}, file);

		assert.strictEqual(empty.diagnostics.rawCount, 0);
		assert.strictEqual(empty.diagnostics.acceptedCount, 0);
		assert.strictEqual(filtered.findings.length, 1);
		assert.strictEqual(filtered.diagnostics.rawCount, 3);
		assert.strictEqual(filtered.diagnostics.dropped.length, 2);
		assert.ok(filtered.diagnostics.dropped.some((item) => item.reason.includes('hunkId')));
		assert.ok(filtered.diagnostics.dropped.some((item) => item.reason.includes('severity')));
	});

	test('sorts findings by chunk by default and severity when configured', () => {
		const uri = vscode.Uri.file('/repo/src/app.ts');
		const hunks = computeLineDiff(uri.toString(), 'a\nold\nc\nold2\n', 'a\nnew\nc\nnew2\n');
		const file = reviewFileState(uri, 'src/app.ts', { hunks });
		const findings = validateReviewFindings({
			findings: [
				{ hunkId: hunks[1].id, severity: 'critical', title: 'Later', explanation: 'x', recommendation: 'x' },
				{ hunkId: hunks[0].id, severity: 'info', title: 'Earlier', explanation: 'x', recommendation: 'x' },
			],
		}, file);

		assert.deepStrictEqual(sortFindings(findings, [file], 'chunk').map((item) => item.title), ['Earlier', 'Later']);
		assert.deepStrictEqual(sortFindings(findings, [file], 'severity').map((item) => item.title), ['Later', 'Earlier']);
	});

	test('changes review signature when pending chunks change and skips Wiki files', () => {
		const sourceUri = vscode.Uri.file('/repo/src/app.ts');
		const wikiUri = vscode.Uri.file('/repo/.wiki/overview.md');
		const source = reviewFileState(sourceUri, 'src/app.ts', { hunks: computeLineDiff(sourceUri.toString(), 'a\n', 'b\n') });
		const wiki = reviewFileState(wikiUri, '.wiki/overview.md', { hunks: computeLineDiff(wikiUri.toString(), 'a\n', 'b\n') });
		const session: ReviewSession = { id: 'x', mode: 'git', rootUri: vscode.Uri.file('/repo'), createdAt: 1, files: new Map([[sourceUri.toString(), source], [wikiUri.toString(), wiki]]) };
		const first = reviewChangeSignature(session);
		source.revision += 1;
		const afterSource = reviewChangeSignature(session);
		assert.notStrictEqual(afterSource, first);
		wiki.revision += 1;
		assert.strictEqual(reviewChangeSignature(session), afterSource);
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
			writeRepoFile(root, '.wiki/overview.md', '# Overview\n');
			writeRepoFile(root, '.wiki/.state.json', '{}\n');
			pairs = await service.createFilePairs(folder);
			byPath = filePairsByPath(pairs);
			assert.strictEqual(byPath.has('.env'), false);
			assert.strictEqual(byPath.has('.cache/output.txt'), false);
			assert.strictEqual(byPath.has('.gitignore'), false);
			assert.strictEqual(byPath.has('ignored.txt'), false);
			assert.strictEqual(byPath.has('.wiki/overview.md'), true);
			assert.strictEqual(byPath.has('.wiki/.state.json'), false);
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
		'interfaces.md',
		'workflows.md',
		'modules.md',
		'decisions.md',
		'open-questions.md',
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
		appliedAiSuggestions: [],
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
