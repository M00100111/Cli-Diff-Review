import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AiReviewPartialError, AiReviewStore, CodeReviewAgentService, reviewChangeSignature, sortFindings, StoredAiReview, validateReviewFindings, validateReviewFindingsWithDiagnostics, validateReviewSuggestionsWithDiagnostics } from '../agent/codeReview';
import { AgentRunner, type AgentRunCheckpoint, type AgentTraceEvent, validateAgentResponse } from '../agent/runtime';
import { createReadOnlyAgentTools, createWikiAgentTools } from '../agent/tools';
import { AgentRunStore, StoredProjectAgentRun } from '../agentRunStore';
import { acceptHunkInBaseline, computeLineDiff } from '../diffEngine';
import { GitService, parseCatFileBatch } from '../gitService';
import { combineGitHunkPatches, decodeGitPath, parseGitPatch } from '../gitPatch';
import { expectedRejectedFileHash, fileStateHash, GitReviewJournalStore } from '../gitReviewJournal';
import { AnthropicClient, DeepSeekClient, GlmClient, OpenAiCompatibleClient } from '../llm/client';
import { LlmConfigStore } from '../llm/config';
import { parseStrictJsonObject } from '../llm/json';
import { NativeReviewEditorManager } from '../nativeReviewEditor';
import { buildReviewDashboardPayload, defaultLlmWikiDashboardState, ReviewDashboardProvider } from '../reviewDashboard';
import { ReviewController } from '../reviewController';
import { isDotReviewPath, shouldSkipReviewPath } from '../reviewFileFilter';
import { ReviewTreeProvider } from '../reviewTree';
import { languageIdFromPath, normalizeMonacoThemeColor, ReviewWebviewManager } from '../reviewWebview';
import {
	captureLineBlockContext,
	firstReviewRevealPosition,
	gitReviewFileStateFingerprint,
	isStaleRevision,
	lineBlockWithContextMatches,
	lineBlockWithContextMatchesUniquely,
	mapLineAfterFileEdits,
	mapLineAfterLineEdits,
	reviewHunkIdentity,
	SerialOperationQueue,
} from '../reviewState';
import { replaceLineBlock, splitLines } from '../text';
import { FilePair, GitReviewHunk, ReviewedHunk, ReviewFileState, ReviewHunk, ReviewProject, ReviewSession, visibleReviewFiles } from '../types';
import { agentsGuidanceEndMarker, agentsGuidanceStartMarker, mergeManagedAgentsGuidance, removeManagedAgentsGuidanceBlock } from '../wiki/agentsGuidance';
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

	test('identifies reviewed hunks by content instead of generated id', () => {
		const hunk = computeLineDiff('file:///demo.ts', 'old\n', 'new\n')[0];
		const reviewed = reviewedHunkFrom(hunk, 'accept');
		const shifted = { ...hunk, newStart: hunk.newStart + 1 };

		assert.notStrictEqual(reviewed.id, hunk.id);
		assert.strictEqual(reviewHunkIdentity(reviewed), reviewHunkIdentity(hunk));
		assert.notStrictEqual(reviewHunkIdentity(shifted), reviewHunkIdentity(hunk));
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
	test('uses the dedicated Vue language for Vue single-file components', () => {
		assert.strictEqual(languageIdFromPath('src/App.vue'), 'vue');
		assert.strictEqual(languageIdFromPath('src/App.VUE'), 'vue');
	});

	test('emits syntactically valid Review Webview JavaScript with Vue tokenizers', () => {
		const manager = Object.create(ReviewWebviewManager.prototype) as ReviewWebviewManager;
		Object.assign(manager as unknown as Record<string, unknown>, {
			context: { extensionUri: vscode.Uri.file('/extension') },
		});
		const webview = {
			cspSource: 'vscode-webview:',
			asWebviewUri: (uri: vscode.Uri) => uri,
		} as vscode.Webview;
		const html = (manager as unknown as { renderShell(webview: vscode.Webview): string }).renderShell(webview);
		const inlineScript = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];

		assert.ok(inlineScript);
		assert.doesNotThrow(() => new Function(inlineScript));
		assert.ok(inlineScript.includes("nextEmbedded: 'typescript'"));
		assert.ok(inlineScript.includes("nextEmbedded: 'javascript'"));
		assert.ok(inlineScript.includes("nextEmbedded: 'scss'"));
		assert.ok(inlineScript.includes("const editorClipboardContext = 'editorTextFocus && !findInputFocussed && !replaceInputFocussed';"));
		assert.match(inlineScript, /KeyCode\.KeyV,[\s\S]*?pasteSelection\(\); \}, editorClipboardContext\);/);
	});

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
		assert.ok(source.includes('function registerVueLanguage()'));
		assert.ok(source.includes("monaco.languages.register({\n\t\t\t\tid: 'vue'"));
		assert.ok(source.includes("nextEmbedded: 'typescript'"));
		assert.ok(source.includes("nextEmbedded: 'javascript'"));
		assert.ok(source.includes("nextEmbedded: 'scss'"));
		assert.ok(source.includes('showInitializationError'));
		assert.ok(source.includes('Review editor failed to initialize: '));
		assert.strictEqual(source.includes("actions.appendChild(createButton(labels.undo, 'undoSuggestion', entry));"), false);
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
		assert.ok(source.includes('const usesReviewStateText = document.uri.scheme === ReviewWebviewManager.deletedDocumentScheme || !file.currentExists;'));
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

	test('drops stale open-document text when a rejected added file no longer exists', () => {
		const uri = vscode.Uri.file('/repo/package.json');
		const file = reviewFileState(uri, 'package.json', {
			oldText: '',
			newText: '',
			currentExists: false,
		});
		const staleOpenDocument = {
			uri,
			isDirty: false,
			getText: () => '{\n  "stale": true\n}\n',
		} as vscode.TextDocument;
		const manager = Object.create(ReviewWebviewManager.prototype) as {
			serialize(file: ReviewFileState, document: vscode.TextDocument): {
				newText: string;
				dirty: boolean;
				readOnly: boolean;
			};
		};

		const payload = manager.serialize(file, staleOpenDocument);

		assert.strictEqual(payload.newText, '');
		assert.strictEqual(payload.dirty, false);
		assert.strictEqual(payload.readOnly, true);
	});

	test('closes Review editors without pending hunks after manual refresh', () => {
		const pendingUri = vscode.Uri.file('D:/repo/src/pending.ts');
		const reviewedUri = vscode.Uri.file('D:/repo/src/reviewed.ts');
		const missingUri = vscode.Uri.file('D:/repo/src/missing.ts');
		const pending = reviewFileState(pendingUri, 'src/pending.ts', {
			hunks: computeLineDiff(pendingUri.toString(), 'old\n', 'new\n'),
		});
		const reviewed = reviewFileState(reviewedUri, 'src/reviewed.ts');
		const session: ReviewSession = {
			id: 'manual-refresh',
			mode: 'git',
			rootUri: vscode.Uri.file('D:/repo'),
			createdAt: 1,
			files: new Map([[pendingUri.toString(), pending], [reviewedUri.toString(), reviewed]]),
		};
		const disposed: string[] = [];
		const host = (uri: vscode.Uri) => ({
			uri,
			panel: { dispose: () => disposed.push(uri.toString()) },
		});
		const manager = Object.create(ReviewWebviewManager.prototype) as ReviewWebviewManager;
		Object.assign(manager as unknown as Record<string, unknown>, {
			getSession: () => session,
			hosts: new Map([
				[pendingUri.toString(), host(pendingUri)],
				[reviewedUri.toString(), host(reviewedUri)],
				[missingUri.toString(), host(missingUri)],
			]),
			refreshTimers: new Map(),
		});

		const closed = manager.closeCompleted().map((uri) => uri.toString());

		assert.deepStrictEqual(closed, [reviewedUri.toString(), missingUri.toString()]);
		assert.deepStrictEqual(disposed, closed);
	});

	test('invokes completed Review editor cleanup only from the manual refresh flow', () => {
		const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'reviewController.ts'), 'utf8');
		assert.match(source, /refreshGitSessionFiles\(\{ source: 'manual' \}\);\s+this\.closeCompletedReviewEditorsAfterManualRefresh\(\);/);
		assert.doesNotMatch(source, /refreshGitSessionFiles\(\{ source: 'gitIndexChanged' \}\);\s+this\.closeCompletedReviewEditorsAfterManualRefresh\(\);/);
	});
});

suite('Extension configuration', () => {
	test('declares settings in the intended display order', () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
			contributes?: { configuration?: { properties?: Record<string, { order?: number }> } };
		};
		const expected = [
			'cliDiff.autoStartGitReview',
			'cliDiff.refreshDebounceMs',
			'cliDiff.reviewWikiChanges',
			'cliDiff.reviewEditorMode',
			'cliDiff.aiReviewStrategy',
			'cliDiff.aiReviewMaxRounds',
			'cliDiff.aiReviewFileConcurrency',
			'cliDiff.aiReviewLanguage',
		];
		const properties = manifest.contributes?.configuration?.properties ?? {};
		assert.deepStrictEqual(Object.keys(properties), expected);
		assert.deepStrictEqual(expected.map((key) => properties[key]?.order), [1, 2, 3, 4, 5, 6, 7, 8]);
	});

	test('declares one refresh debounce setting for background synchronization', () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
			contributes?: { configuration?: { properties?: Record<string, unknown> } };
		};
		const setting = manifest.contributes?.configuration?.properties?.['cliDiff.refreshDebounceMs'] as {
			type?: unknown;
			default?: unknown;
			minimum?: unknown;
			description?: unknown;
		} | undefined;
		assert.ok(setting);
		assert.strictEqual(setting.type, 'number');
		assert.strictEqual(setting.default, 500);
		assert.strictEqual(setting.minimum, 0);
		assert.match(String(setting.description), /Editor text changes still refresh only after save/);
	});

	test('removes snapshot commands and quadratic diff configuration', () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
			activationEvents?: string[];
			contributes?: { commands?: Array<{ command: string }>; configuration?: { properties?: Record<string, unknown> } };
		};
		const commands = new Set((manifest.contributes?.commands ?? []).map((item) => item.command));
		const properties = manifest.contributes?.configuration?.properties ?? {};
		assert.strictEqual(commands.has('cli-diff.captureBaseline'), false);
		assert.strictEqual(commands.has('cli-diff.startSnapshotReview'), false);
		assert.strictEqual(manifest.activationEvents?.some((event) => event.includes('Snapshot') || event.includes('captureBaseline')), false);
		for (const key of ['cliDiff.maxFiles', 'cliDiff.maxDiffLines', 'cliDiff.maxDiffCells', 'cliDiff.maxFileBytes', 'cliDiff.exclude', 'cliDiff.nativeDiffInline', 'cliDiff.aiReviewFindingOrder']) {
			assert.strictEqual(Object.prototype.hasOwnProperty.call(properties, key), false);
		}
	});

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
		assert.strictEqual(setting.default, 32);
		assert.strictEqual(setting.minimum, 0);
		assert.strictEqual(Object.prototype.hasOwnProperty.call(setting, 'maximum'), false);
		assert.match(String(setting.description), /0 means unlimited/);
	});

	test('declares AI review strategy setting defaults', () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
			contributes?: { configuration?: { properties?: Record<string, unknown> } };
		};
		const setting = manifest.contributes?.configuration?.properties?.['cliDiff.aiReviewStrategy'] as {
			type?: unknown;
			default?: unknown;
			enum?: unknown[];
		} | undefined;

		assert.ok(setting);
		assert.strictEqual(setting.type, 'string');
		assert.strictEqual(setting.default, 'Multi');
		assert.deepStrictEqual(setting.enum, ['Auto', 'Multi', 'FileOnly']);
	});


	test('declares AI review file concurrency setting defaults', () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
			contributes?: { configuration?: { properties?: Record<string, unknown> } };
		};
		const setting = manifest.contributes?.configuration?.properties?.['cliDiff.aiReviewFileConcurrency'] as {
			type?: unknown;
			default?: unknown;
			minimum?: unknown;
			description?: unknown;
		} | undefined;

		assert.ok(setting);
		assert.strictEqual(setting.type, 'number');
		assert.strictEqual(setting.default, 3);
		assert.strictEqual(setting.minimum, 0);
		assert.match(String(setting.description), /0 runs all pending files concurrently/);
	});

	test('declares review editor mode setting defaults', () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
			contributes?: { configuration?: { properties?: Record<string, unknown> } };
		};
		const setting = manifest.contributes?.configuration?.properties?.['cliDiff.reviewEditorMode'] as {
			default?: unknown;
			enum?: unknown[];
			enumItemLabels?: unknown[];
		} | undefined;

		assert.ok(setting);
		assert.strictEqual(setting.default, 'nativeEditor');
		assert.deepStrictEqual(setting.enum, ['nativeEditor', 'reviewPage']);
		assert.deepStrictEqual(setting.enumItemLabels, ['Native inline diff editor', 'Review page']);

	});
});

suite('Review controller bulk actions', () => {
	test('admits one Agent task per project while allowing different projects concurrently', () => {
		const controller = Object.create(ReviewController.prototype) as any;
		controller.projectAgentRuntimes = new Map();
		const rootA = workspaceFolder('/tmp/cli-diff-project-a');
		const rootB = workspaceFolder('/tmp/cli-diff-project-b');

		const taskA = controller.beginProjectAgentTask('review', rootA, 'project-a');
		const duplicateA = controller.beginProjectAgentTask('update', rootA, 'project-a');
		const taskB = controller.beginProjectAgentTask('initialize', rootB, 'project-b');

		assert.ok(taskA);
		assert.strictEqual(duplicateA, undefined);
		assert.ok(taskB);
		assert.notStrictEqual(taskA.projectKey, taskB.projectKey);
		assert.strictEqual(controller.isCurrentProjectAgentTask(taskA), true);
		assert.strictEqual(controller.isCurrentProjectAgentTask(taskB), true);

		controller.clearProjectAgentTask(taskA);
		assert.strictEqual(controller.isCurrentProjectAgentTask(taskA), false);
		assert.strictEqual(controller.isCurrentProjectAgentTask(taskB), true);
	});

	test('keeps concurrent project Agent logs and lifecycle updates isolated', async () => {
		const saved: StoredProjectAgentRun[] = [];
		const controller = Object.create(ReviewController.prototype) as any;
		Object.assign(controller, {
			projectAgentRuntimes: new Map(),
			agentRunStore: {
				save: async (run: StoredProjectAgentRun) => {
					saved.push({ ...run, entries: [...run.entries] });
				},
			},
			scheduleLlmWikiDashboardRefresh: () => undefined,
		});
		const rootA = workspaceFolder('/tmp/cli-diff-agent-log-a');
		const rootB = workspaceFolder('/tmp/cli-diff-agent-log-b');
		const taskA = controller.beginProjectAgentTask('review', rootA, 'project-a');
		const taskB = controller.beginProjectAgentTask('update', rootB, 'project-b');
		assert.ok(taskA);
		assert.ok(taskB);

		await Promise.all([
			controller.startProjectAgentRun(taskA, {
				kind: 'run_start', title: 'A started', summary: 'A', status: 'running', details: [],
			}, 'review', { progress: 'A running' }),
			controller.startProjectAgentRun(taskB, {
				kind: 'run_start', title: 'B started', summary: 'B', status: 'running', details: [],
			}, 'wiki', { progress: 'B running' }),
		]);
		controller.appendProjectAgentRunLog(taskA, {
			kind: 'assistant_message', title: 'A trace', summary: 'Only A', status: 'info', details: [],
		});
		await controller.finishProjectAgentRun(taskA, 'completed', 'A complete');

		const runtimeA = controller.projectAgentRuntimes.get(taskA.projectKey);
		const runtimeB = controller.projectAgentRuntimes.get(taskB.projectKey);
		assert.strictEqual(runtimeA.run.entries.length, 2);
		assert.strictEqual(runtimeA.run.lifecycle, 'completed');
		assert.strictEqual(runtimeB.run.entries.length, 1);
		assert.strictEqual(runtimeB.run.lifecycle, 'running');
		assert.strictEqual(controller.isCurrentProjectAgentTask(taskB), true);
		assert.ok(saved.some((run) => run.rootUri === rootA.uri.toString()));
		assert.ok(saved.some((run) => run.rootUri === rootB.uri.toString()));
	});

	test('restores a persisted running project task as interrupted without restarting it', async () => {
		const root = vscode.Uri.file('/tmp/cli-diff-interrupted-project');
		const stored: StoredProjectAgentRun = {
			version: 1,
			runId: 'interrupted-run',
			projectId: 'project-a',
			rootUri: root.toString(),
			kind: 'update',
			source: 'wiki',
			lifecycle: 'running',
			startedAt: '2026-07-24T00:00:00.000Z',
			updatedAt: '2026-07-24T00:00:01.000Z',
			progress: 'Updating',
			sequence: 1,
			entries: [{
				id: 'interrupted-run-1',
				sequence: 1,
				timestamp: '2026-07-24T00:00:01.000Z',
				source: 'wiki',
				kind: 'run_start',
				title: 'Started',
				summary: 'Updating',
				status: 'running',
				details: [],
			}],
		};
		let recoveredRoot: string | undefined;
		let persisted: StoredProjectAgentRun | undefined;
		const controller = Object.create(ReviewController.prototype) as any;
		Object.assign(controller, {
			projectAgentRuntimes: new Map(),
			agentRunStore: {
				load: async () => stored,
				save: async (run: StoredProjectAgentRun) => {
					persisted = run;
				},
			},
			wikiInitializationService: {
				recoverInterruptedUpdate: async (rootUri: vscode.Uri) => {
					recoveredRoot = rootUri.toString();
				},
				recoverInterruptedInitialization: async () => undefined,
			},
		});

		await controller.loadProjectAgentRuns([{ id: 'project-a', name: 'A', rootUri: root }]);
		const runtime = controller.projectAgentRuntimes.get(root.toString());
		assert.strictEqual(runtime.task, undefined);
		assert.strictEqual(runtime.run.lifecycle, 'interrupted');
		assert.strictEqual(runtime.run.entries.at(-1)?.title, 'Agent run interrupted');
		assert.strictEqual(recoveredRoot, root.toString());
		assert.strictEqual(persisted?.lifecycle, 'interrupted');
	});

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
		assert.ok(source.includes("this.gitService.applyPatch(folder, patch, { cached: true, check: true })"));
		assert.ok(source.includes("this.gitService.applyPatch(folder, patch, { reverse: true, check: true })"));
		assert.ok(source.includes('await this.refreshGitSessionFiles({ source: \'gitIndexChanged\' })'));
		assert.ok(source.includes("chunkCount: action === 'undo' ? file.acceptedHunks.length + file.rejectedHunks.length : file.hunks.length"));
		assert.ok(source.includes('sort((left, right) => left.file.relativePath.localeCompare(right.file.relativePath))'));
	});

	test('wires AI review partial retry and max round configuration through the controller', () => {
		const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'reviewController.ts'), 'utf8');

		assert.ok(source.includes("event.affectsConfiguration('cliDiff.aiReviewMaxRounds')"));
		assert.ok(source.includes("event.affectsConfiguration('cliDiff.aiReviewStrategy')"));
		assert.ok(source.includes("event.affectsConfiguration('cliDiff.aiReviewFileConcurrency')"));
		assert.ok(source.includes("vscode.workspace.getConfiguration('cliDiff').get<number>('aiReviewMaxRounds', 32)"));
		assert.ok(source.includes("vscode.workspace.getConfiguration('cliDiff').get<string>('aiReviewStrategy', 'Multi')"));
		assert.ok(source.includes("vscode.workspace.getConfiguration('cliDiff').get<number>('aiReviewFileConcurrency', 3)"));
		assert.strictEqual(source.includes('aiReviewFindingOrder'), false);
		assert.ok(source.includes('const strategy = this.aiReviewStrategy();'));
		assert.ok(source.includes('const fileConcurrency = this.aiReviewFileConcurrency();'));
		assert.ok(source.includes('strategy,'));
		assert.ok(source.includes('fileConcurrency,'));
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
		assert.ok(source.includes('normalizeAiSuggestionReplacementText(suggestion.replacementText, hunk)'));
		assert.ok(source.includes('this.retainAppliedAiSuggestions'));
		assert.ok(source.includes("console.error('[Cli Diff Review] AI suggestion mapping failed'"));
		assert.ok(source.includes('appliedAiSuggestion'));
		assert.ok(source.includes('aiReviewToResign = appliedSuggestion ? this.aiReviewStore.load(aiReviewSession) : undefined;'));
		assert.ok(source.includes('await this.saveAiReviewWithCurrentSignature(aiReviewToResign'));
		assert.ok(source.includes('await this.saveAiReviewWithCurrentSignature(storedReview'));
		assert.ok(source.includes('this.findRegeneratedSuggestionHunk'));
		assert.ok(source.includes('await this.refreshGitReviewFile(file.uri)'));
	});

	test('uses one configured debounce for file, Git, and AI dashboard refreshes', () => {
		const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'reviewController.ts'), 'utf8');
		assert.ok(source.includes("get<number>('refreshDebounceMs', 500)"));
		assert.strictEqual((source.match(/this\.refreshDebounceMs\(\)/g) ?? []).length, 3);
		assert.ok(source.includes('if (!event.document.isDirty)'));
		assert.ok(source.includes('await this.flushHumanEdits(document)'));
	});

	test('wires review editor mode through native editor and review page presenters', () => {
		const controllerSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'reviewController.ts'), 'utf8');
		const nativeSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'nativeReviewEditor.ts'), 'utf8');

		assert.ok(controllerSource.includes("import { NativeReviewEditorManager"));
		assert.ok(controllerSource.includes('firstReviewRevealPosition'));
		assert.ok(controllerSource.includes("get<string>('reviewEditorMode', 'nativeEditor')"));
		assert.ok(controllerSource.includes("configured === 'reviewPage' ? 'reviewPage' : 'nativeEditor'"));
		assert.ok(controllerSource.includes("await this.openReviewPresentation(uri);"));
		assert.ok(controllerSource.includes('const effectiveReveal = reveal ?? (file ? firstReviewRevealPosition(file) : undefined);'));
		assert.ok(controllerSource.includes("await this.nativeReviewEditor.revealChunk(uri, effectiveReveal.hunkId)"));
		assert.ok(controllerSource.includes("await this.reviewWebview.open(uri, effectiveReveal?.line !== undefined"));
		assert.ok(controllerSource.includes('this.nativeReviewEditor.refresh(uri);'));
		assert.ok(controllerSource.includes('private async syncNativeReviewAfterMutation(uri: vscode.Uri, reveal?: NativeReviewRevealPosition): Promise<void>'));
		assert.ok(controllerSource.includes('await this.nativeReviewEditor.syncOpen(uri, reveal);'));
		assert.ok(controllerSource.includes('await this.syncNativeReviewAfterMutation(target.file.uri, { line: target.hunk.newStart, column: 0 });'));
		assert.ok(controllerSource.includes('await this.syncNativeReviewAfterMutation(file.uri);'));
		assert.ok(controllerSource.includes('await this.syncNativeReviewAfterMutation(refreshedFile.uri);'));
		assert.ok(controllerSource.includes('...this.nativeReviewEditor.closeCompleted(),'));
		assert.ok(nativeSource.includes('registerTextDocumentContentProvider(NativeReviewEditorManager.beforeDocumentScheme'));
		assert.ok(nativeSource.includes('registerTextDocumentContentProvider(NativeReviewEditorManager.afterDocumentScheme'));
		assert.ok(nativeSource.includes("provideTextDocumentContent: (uri) => this.provideReviewDocumentContent(uri)"));
		assert.ok(nativeSource.includes("'vscode.diff'"));
		assert.ok(nativeSource.includes("this.reviewDocumentUri(file, 'before')"));
		assert.ok(nativeSource.includes("this.reviewDocumentUri(file, 'after')"));
		assert.ok(nativeSource.includes("return payload.side === 'after' ? file.newText : this.beforeText(file);"));
		assert.ok(nativeSource.includes('public async syncOpen(uri: vscode.Uri, reveal?: NativeReviewRevealPosition): Promise<boolean>'));
		assert.ok(nativeSource.includes('private readonly openFileKeys = new Set<string>();'));
		assert.ok(nativeSource.includes('vscode.window.tabGroups.onDidChangeTabs'));
		assert.ok(nativeSource.includes('if (tabs.length === 0 && !this.openFileKeys.has(key) && !this.isActiveReviewDocumentForFile(uri))'));
		assert.ok(nativeSource.includes('vscode.window.tabGroups.close(tabs, true)'));
		assert.ok(nativeSource.includes('private isActiveReviewDocumentForFile(fileUri: vscode.Uri): boolean'));
		assert.ok(nativeSource.includes('this.refresh(uri);'));
		assert.ok(nativeSource.includes('await this.reveal(file, reveal ?? firstReviewRevealPosition(file));'));
		assert.ok(nativeSource.includes('this.openFileKeys.add(key);'));
		assert.ok(nativeSource.includes('return true;'));
		assert.ok(nativeSource.includes('query: encodeURIComponent(JSON.stringify({ uri: uri.toString(), side }))'));
		assert.strictEqual(nativeSource.includes('side, revision'), false);
		assert.ok(nativeSource.includes('private fileUriFromDiffInput(input: vscode.TabInputTextDiff): vscode.Uri | undefined'));
		assert.ok(nativeSource.includes('private textDiffInput(tab: vscode.Tab): vscode.TabInputTextDiff | undefined'));
		assert.ok(nativeSource.includes("'original' in input"));
		assert.ok(nativeSource.includes("'modified' in input"));
		assert.ok(nativeSource.includes('private isUriLike(value: unknown): value is vscode.Uri'));
		assert.strictEqual(nativeSource.includes('nativeDiffInline'), false);
		assert.strictEqual(nativeSource.includes('ensureInlineDiffMode'), false);
		assert.strictEqual(nativeSource.includes('renderSideBySide'), false);
		assert.strictEqual(nativeSource.includes('registerCodeLensProvider'), false);
		assert.strictEqual(nativeSource.includes('provideReviewCodeLenses'), false);
		assert.strictEqual(nativeSource.includes("diffConfig.update('codeLens'"), false);
		assert.ok(nativeSource.includes("vscode.commands.executeCommand('revealLine'"));
		assert.ok(nativeSource.includes('input instanceof vscode.TabInputTextDiff'));
		assert.ok(nativeSource.includes('closeCompleted(): vscode.Uri[]'));
		assert.strictEqual(nativeSource.includes('createTextEditorDecorationType'), false);
		assert.strictEqual(nativeSource.includes('registerInlineCompletionItemProvider'), false);
		assert.strictEqual(nativeSource.includes('provideInlineCompletionItems('), false);
		assert.strictEqual(nativeSource.includes("editor.action.inlineSuggest.trigger"), false);
		assert.strictEqual(nativeSource.includes('new vscode.InlineCompletionItem'), false);
		assert.strictEqual(nativeSource.includes('gutterIconPath'), false);
		assert.strictEqual(nativeSource.includes('oldCodeBlockDecoration'), false);
		assert.strictEqual(nativeSource.includes('oldCodeBlockText'), false);
		assert.strictEqual(nativeSource.includes('display: block'), false);
		assert.strictEqual(nativeSource.includes('white-space: pre'), false);
		assert.strictEqual(nativeSource.includes('editor.findMatchHighlightBackground'), false);
		assert.strictEqual(nativeSource.includes("borderWidth: '0 0 0 2px'"), false);
		assert.strictEqual(nativeSource.includes("borderWidth: '1px 0 1px 2px'"), false);
	});

	test('keeps native diff document URIs stable across review revisions', () => {
		const manager = Object.create(NativeReviewEditorManager.prototype) as {
			reviewDocumentUriForFileUri(uri: vscode.Uri, side: 'before' | 'after'): vscode.Uri;
			reviewDocumentPayload(uri: vscode.Uri): { fileUri: vscode.Uri; side: 'before' | 'after' } | undefined;
		};
		const fileUri = vscode.Uri.file('D:/repo/src/app.ts');
		const before = manager.reviewDocumentUriForFileUri(fileUri, 'before');
		const after = manager.reviewDocumentUriForFileUri(fileUri, 'after');
		const afterAgain = manager.reviewDocumentUriForFileUri(fileUri, 'after');

		assert.strictEqual(after.toString(), afterAgain.toString());
		assert.strictEqual(decodeURIComponent(after.query).includes('revision'), false);
		assert.strictEqual(manager.reviewDocumentPayload(before)?.fileUri.toString(), fileUri.toString());
		assert.strictEqual(manager.reviewDocumentPayload(after)?.side, 'after');
	});

	test('hides accepted chunks from the native diff without adding review CodeLens actions', () => {
		const uri = vscode.Uri.file('/repo/src/app.ts');
		const oldText = 'old\nkeep\n';
		const newText = 'new\nkeep\npending\n';
		const [accepted, pending] = computeLineDiff(uri.toString(), oldText, newText);
		const file = reviewFileState(uri, 'src/app.ts', {
			oldText,
			newText,
			hunks: [pending],
			acceptedHunks: [reviewedHunkFrom(accepted, 'accept')],
			revision: 7,
		});
		const session: ReviewSession = {
			id: 'native-accepted-baseline', mode: 'git', rootUri: vscode.Uri.file('/repo'), createdAt: 1,
			files: new Map([[uri.toString(), file]]),
		};
		const manager = Object.create(NativeReviewEditorManager.prototype) as any;
		manager.getSession = () => session;
		const before = manager.reviewDocumentUriForFileUri(uri, 'before');
		const after = manager.reviewDocumentUriForFileUri(uri, 'after');

		assert.strictEqual(manager.provideReviewDocumentContent(before), 'new\nkeep\n');
		assert.strictEqual(manager.provideReviewDocumentContent(after), newText);

		for (const [caseName, baseline, working] of [
			['add', '', 'added\n'],
			['delete', 'deleted\n', ''],
			['modify', 'before\n', 'after\n'],
		] as const) {
			const acceptedHunk = computeLineDiff(`${uri.toString()}#${caseName}`, baseline, working)[0];
			const acceptedFile = reviewFileState(uri, `src/${caseName}.ts`, {
				oldText: baseline,
				newText: working,
				acceptedHunks: [reviewedHunkFrom(acceptedHunk, 'accept')],
			});
			assert.strictEqual(manager.beforeText(acceptedFile), working, `${caseName} should disappear from native diff after accept`);
		}
	});
});

suite('Review state', () => {
	test('uses only the Wiki setting as a plugin-owned review path filter', () => {
		assert.strictEqual(isDotReviewPath('.env'), true);
		assert.strictEqual(isDotReviewPath('.github/workflows/release.yml'), true);
		assert.strictEqual(isDotReviewPath('src/.cache/output.txt'), true);
		assert.strictEqual(shouldSkipReviewPath('.env'), false);
		assert.strictEqual(shouldSkipReviewPath('.github/workflows/release.yml'), false);
		assert.strictEqual(shouldSkipReviewPath('src/.cache/output.txt'), false);
		assert.strictEqual(shouldSkipReviewPath('src/app.ts'), false);
		assert.strictEqual(shouldSkipReviewPath('src/file.name.ts'), false);
		assert.strictEqual(shouldSkipReviewPath('.agents/skills/llm-code-wiki/SKILL.md', true), false);
		assert.strictEqual(shouldSkipReviewPath('.agents/skills/llm-code-wiki/references/overview.md', true), false);
		assert.strictEqual(shouldSkipReviewPath('.agents/skills/llm-code-wiki/references/overview.md', false), true);
		assert.strictEqual(shouldSkipReviewPath('.agents/skills/llm-code-wiki/.state.json', true), false);
		assert.strictEqual(shouldSkipReviewPath('.agents/skills/llm-code-wiki/private.json', true), false);
		assert.strictEqual(shouldSkipReviewPath('.agents/skills/llm-code-wiki/.state.json', false), true);
		assert.strictEqual(shouldSkipReviewPath('.skills/llm-code-wiki/SKILL.md', true), false);
		assert.strictEqual(shouldSkipReviewPath('.agents/skills/other-skill/SKILL.md', true), false);
		assert.strictEqual(shouldSkipReviewPath('.skills/other-skill/SKILL.md', true), false);
		assert.strictEqual(shouldSkipReviewPath('.wiki/overview.md', true), false);
	});

	test('treats mismatched expected revisions as stale', () => {
		assert.strictEqual(isStaleRevision(3), false);
		assert.strictEqual(isStaleRevision(3, 3), false);
		assert.strictEqual(isStaleRevision(3, 2), true);
	});

	test('keeps Git revisions stable when only regenerated review timestamps change', () => {
		const uri = vscode.Uri.file('/repo/demo.ts');
		const accepted = reviewedHunkFrom(computeLineDiff(uri.toString(), 'old\n', 'new\n')[0], 'accept');
		const file = reviewFileState(uri, 'demo.ts', {
			oldText: 'old\n',
			newText: 'new\n',
			acceptedHunks: [accepted],
			gitSnapshot: {
				headText: 'old\n', indexText: 'new\n', workingText: 'new\n',
				headExists: true, indexExists: true, workingExists: true,
			},
		});
		const regenerated = { ...file, acceptedHunks: [{ ...accepted, reviewedAt: accepted.reviewedAt + 1000 }] };
		assert.strictEqual(gitReviewFileStateFingerprint(file), gitReviewFileStateFingerprint(regenerated));
		assert.notStrictEqual(
			gitReviewFileStateFingerprint(file),
			gitReviewFileStateFingerprint({ ...regenerated, gitSnapshot: { ...regenerated.gitSnapshot!, indexText: 'other\n' } }),
		);
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

	test('maps reviewed baseline starts through manual edits before the hunk', () => {
		const acceptedBaseline = 'a\nmanual\nb\nC\n';
		const mappedBaselineStart = mapLineAfterLineEdits(2, [{ oldStart: 1, oldLines: 0, newLines: 1 }]);
		const restored = replaceLineBlock(acceptedBaseline, mappedBaselineStart, 1, 'c\n');

		assert.strictEqual(mappedBaselineStart, 3);
		assert.strictEqual(restored, 'a\nmanual\nb\nc\n');
	});

	test('selects the first review chunk as the default reveal position', () => {
		const uri = vscode.Uri.file('D:/repo/src/reveal.ts');
		const baseHunk = computeLineDiff(uri.toString(), 'old\n', 'new\n')[0];
		const laterPending = { ...baseHunk, id: 'later-pending', newStart: 9 };
		const earlierPending = { ...baseHunk, id: 'earlier-pending', newStart: 2 };
		const laterReviewed = reviewedHunk({ ...baseHunk, id: 'later-reviewed' }, 'accept', 8, baseHunk.newLines, baseHunk.oldStart, 8);
		const earlierReviewed = reviewedHunk({ ...baseHunk, id: 'earlier-reviewed' }, 'reject', 3, baseHunk.oldLines, baseHunk.oldStart, 3);

		assert.deepStrictEqual(firstReviewRevealPosition(reviewFileState(uri, 'src/reveal.ts', {
			hunks: [laterPending, earlierPending],
			acceptedHunks: [earlierReviewed],
		})), { line: 2, column: 0, hunkId: 'earlier-pending' });
		assert.deepStrictEqual(firstReviewRevealPosition(reviewFileState(uri, 'src/reveal.ts', {
			acceptedHunks: [laterReviewed],
			rejectedHunks: [earlierReviewed],
		})), { line: 3, column: 0, hunkId: 'reject-earlier-reviewed' });
		assert.strictEqual(firstReviewRevealPosition(reviewFileState(uri, 'src/reveal.ts')), undefined);
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
		const provider = new ReviewTreeProvider(() => session, () => storedAiReview({
			findings: [{
				id: 'finding-skipped',
				uri: file.uri.toString(),
				relativePath: file.relativePath,
				hunkId: 'skipped-hunk',
				line: 1,
				severity: 'warning',
				title: 'Skipped finding',
				explanation: 'Risk',
				recommendation: 'Fix',
				evidence: [],
				generationOrder: 0,
			}],
			suggestions: [{
				id: 'suggestion-skipped',
				uri: file.uri.toString(),
				relativePath: file.relativePath,
				hunkId: 'skipped-hunk',
				line: 1,
				replacementText: 'suggested\n',
				rationale: 'Prefer this.',
				generationOrder: 0,
			}],
		}));
		const [child] = provider.getChildren();
		const item = provider.getTreeItem(child);

		assert.strictEqual(child, file);
		assert.strictEqual(item.description, 'Unsupported Git change');
		assert.strictEqual(item.contextValue, 'cliDiffFileSkipped');
	});

	test('appends AI review counts to review tree file descriptions', () => {
		const uri = vscode.Uri.file('D:/repo/src/app.ts');
		const hunk = computeLineDiff(uri.toString(), 'a\n', 'b\n')[0];
		const file = reviewFileState(uri, 'src/app.ts', { hunks: [hunk] });
		const session: ReviewSession = {
			id: 'tree-ai-review',
			mode: 'git',
			rootUri: vscode.Uri.file('D:/repo'),
			createdAt: 1,
			files: new Map([[uri.toString(), file]]),
		};
		const defaultProvider = new ReviewTreeProvider(() => session);
		const singularProvider = new ReviewTreeProvider(() => session, () => storedAiReview({
			findings: [aiReviewFinding(uri, 'src/app.ts', hunk)],
			suggestions: [aiReviewSuggestion(uri, 'src/app.ts', hunk)],
		}));
		const pluralProvider = new ReviewTreeProvider(() => session, () => storedAiReview({
			findings: [
				aiReviewFinding(uri, 'src/app.ts', hunk, 'finding-1', 0),
				aiReviewFinding(uri, 'src/app.ts', hunk, 'finding-2', 1),
			],
			suggestions: [
				aiReviewSuggestion(uri, 'src/app.ts', hunk, 'suggestion-1', 0),
				aiReviewSuggestion(uri, 'src/app.ts', hunk, 'suggestion-2', 1),
			],
		}));

		assert.strictEqual(defaultProvider.getTreeItem(file).description, '1 Pending');
		assert.strictEqual(singularProvider.getTreeItem(file).description, '1 Pending, 1 finding, 1 suggestion');
		assert.strictEqual(pluralProvider.getTreeItem(file).description, '1 Pending, 2 findings, 2 suggestions');
	});

	test('groups aggregate Git review files by project and filters selected projects', () => {
		const parent = vscode.Uri.file('D:/projects');
		const projects: ReviewProject[] = [
			{ id: 'api', name: 'api', rootUri: vscode.Uri.joinPath(parent, 'api') },
			{ id: 'web', name: 'web', rootUri: vscode.Uri.joinPath(parent, 'web') },
		];
		const apiFile = reviewFileState(vscode.Uri.joinPath(projects[0].rootUri, 'src/app.ts'), 'src/app.ts', {
			projectId: 'api',
			projectName: 'api',
			hunks: computeLineDiff('api', 'a\n', 'b\n'),
		});
		const webFile = reviewFileState(vscode.Uri.joinPath(projects[1].rootUri, 'src/app.ts'), 'src/app.ts', {
			projectId: 'web',
			projectName: 'web',
			hunks: computeLineDiff('web', 'a\n', 'b\n'),
		});
		const session: ReviewSession = {
			id: 'multi',
			mode: 'git',
			rootUri: parent,
			createdAt: 1,
			files: new Map([[apiFile.uri.toString(), apiFile], [webFile.uri.toString(), webFile]]),
			projects,
			trackingTarget: { kind: 'aggregate' },
		};
		const provider = new ReviewTreeProvider(() => session, () => storedAiReview({
			findings: [aiReviewFinding(apiFile.uri, apiFile.relativePath, apiFile.hunks[0])],
			suggestions: [aiReviewSuggestion(apiFile.uri, apiFile.relativePath, apiFile.hunks[0])],
		}));
		const groups = provider.getChildren();
		assert.deepStrictEqual(groups.map((group) => provider.getTreeItem(group).label), ['api', 'web']);
		assert.strictEqual(provider.getTreeItem(groups[0]).description, '1 Pending');
		assert.strictEqual(provider.getChildren(groups[0]).length, 1);
		assert.strictEqual(provider.getChildren(groups[1]).length, 1);

		const aggregate = buildReviewDashboardPayload(session, undefined, () => false);
		assert.deepStrictEqual(aggregate.files.map((file) => file.relativePath), ['api/src/app.ts', 'web/src/app.ts']);
		assert.strictEqual(aggregate.trackingTarget?.label, 'projects');
		assert.strictEqual(aggregate.trackingTarget?.kind, 'aggregate');
		assert.strictEqual(aggregate.trackingTarget?.canSwitch, true);

		session.trackingTarget = { kind: 'project', projectId: 'web' };
		assert.deepStrictEqual(visibleReviewFiles(session), [webFile]);
		const selected = buildReviewDashboardPayload(session, undefined, () => false);
		assert.deepStrictEqual(selected.files.map((file) => file.relativePath), ['src/app.ts']);
		assert.strictEqual(selected.trackingTarget?.label, 'web');
		assert.strictEqual(provider.getChildren().length, 1);

		const singleChildParent: ReviewSession = {
			...session,
			projects: [projects[0]],
			files: new Map([[apiFile.uri.toString(), apiFile]]),
			trackingTarget: { kind: 'aggregate' },
		};
		const singleChildPayload = buildReviewDashboardPayload(singleChildParent, undefined, () => false);
		assert.strictEqual(singleChildPayload.trackingTarget?.label, 'projects');
		assert.strictEqual(singleChildPayload.trackingTarget?.canSwitch, true);
		assert.strictEqual(singleChildPayload.files[0].relativePath, 'api/src/app.ts');

		const rootProject: ReviewSession = {
			...singleChildParent,
			rootUri: projects[0].rootUri,
			trackingTarget: { kind: 'project', projectId: projects[0].id },
		};
		const rootProjectPayload = buildReviewDashboardPayload(rootProject, undefined, () => false);
		assert.strictEqual(rootProjectPayload.trackingTarget?.canSwitch, false);
		assert.strictEqual(rootProjectPayload.files[0].relativePath, 'src/app.ts');
	});

	test('builds dashboard payload with current review and action states', () => {
		const pendingUri = vscode.Uri.file('D:/repo/src/pending.ts');
		const reviewedUri = vscode.Uri.file('D:/repo/src/reviewed.ts');
		const skippedUri = vscode.Uri.file('D:/repo/src/skipped.ts');
		const htmlUri = vscode.Uri.file('D:/repo/src/page.html');
		const jsonUri = vscode.Uri.file('D:/repo/src/config.json');
		const noExtensionUri = vscode.Uri.file('D:/repo/README');
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
				[htmlUri.toString(), reviewFileState(htmlUri, 'src/page.html')],
				[jsonUri.toString(), reviewFileState(jsonUri, 'src/config.json')],
				[noExtensionUri.toString(), reviewFileState(noExtensionUri, 'README')],
			]),
		};

		const empty = buildReviewDashboardPayload(undefined, undefined, () => false);
		const payload = buildReviewDashboardPayload(session, pendingUri, (uri) => uri.toString() === pendingUri.toString());
		const pending = payload.files.find((file) => file.relativePath === 'src/pending.ts');
		const reviewed = payload.files.find((file) => file.relativePath === 'src/reviewed.ts');
		const skipped = payload.files.find((file) => file.relativePath === 'src/skipped.ts');
		const html = payload.files.find((file) => file.relativePath === 'src/page.html');
		const json = payload.files.find((file) => file.relativePath === 'src/config.json');
		const noExtension = payload.files.find((file) => file.relativePath === 'README');

		assert.deepStrictEqual(empty.files, []);
		assert.strictEqual(payload.currentReviewLabel, 'pending.ts');
		assert.strictEqual(payload.files.length, 3);
		assert.strictEqual(html, undefined);
		assert.strictEqual(json, undefined);
		assert.strictEqual(noExtension, undefined);
		assert.strictEqual(pending?.active, true);
		assert.strictEqual(pending?.dirty, true);
		assert.strictEqual(pending?.acceptDisabled, true);
		assert.strictEqual(pending?.chunks.length, 1);
		assert.strictEqual(pending?.chunks[0].hunkId, pendingHunk.id);
		assert.strictEqual(pending?.chunks[0].canAccept, false);
		assert.strictEqual(pending?.chunks[0].canReject, false);
		assert.strictEqual(pending?.chunks[0].canUndo, false);
		assert.strictEqual(Object.prototype.hasOwnProperty.call(pending?.chunks[0] ?? {}, 'preview'), false);
		assert.strictEqual(reviewed?.undoDisabled, false);
		assert.strictEqual(reviewed?.chunks.length, 1);
		assert.strictEqual(reviewed?.chunks[0].reviewStatus, 'reviewed');
		assert.strictEqual(reviewed?.chunks[0].reviewDecision, 'accepted');
		assert.strictEqual(reviewed?.chunks[0].canAccept, false);
		assert.strictEqual(reviewed?.chunks[0].canReject, false);
		assert.strictEqual(reviewed?.chunks[0].canUndo, true);
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
		const mappedFindingFile = findingPayload.files.find((file) => file.relativePath === 'src/pending.ts');
		const mappedFindingChunk = mappedFindingFile?.chunks.find((chunk) => chunk.hunkId === pendingHunk.id);
		assert.strictEqual(mappedFindingFile?.description, '1 Pending, 1 finding');
		assert.strictEqual(mappedFindingChunk?.findings[0].title, 'Mapped finding');
		session.files.set(pendingUri.toString(), reviewFileState(pendingUri, 'src/pending.ts', {
			hunks: [pendingHunk],
			appliedAiSuggestions: [{
				suggestionId: 'suggestion-1',
				sourceHunkId: pendingHunk.id,
				currentHunkId: pendingHunk.id,
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
		assert.strictEqual(suggestionFile?.description, '1 Pending, 1 suggestion');
		assert.strictEqual(suggestionFile?.chunks[0].suggestions[0].replacementText, 'suggested\n');
		assert.strictEqual(suggestionFile?.chunks[0].appliedSuggestion?.suggestionId, 'suggestion-1');
		assert.strictEqual(suggestionFile?.aiReviewResult?.summary, 'Model returned 0 findings. Accepted 1 of 1 suggestions.');
		const pluralReviewPayload = buildReviewDashboardPayload(session, pendingUri, () => false, {
			...defaultLlmWikiDashboardState(),
			reviewFindings: [
				aiReviewFinding(pendingUri, 'src/pending.ts', pendingHunk, 'finding-1', 0),
				aiReviewFinding(pendingUri, 'src/pending.ts', pendingHunk, 'finding-2', 1),
			],
			reviewSuggestions: [
				aiReviewSuggestion(pendingUri, 'src/pending.ts', pendingHunk, 'suggestion-1', 0),
				aiReviewSuggestion(pendingUri, 'src/pending.ts', pendingHunk, 'suggestion-2', 1),
			],
		});
		assert.strictEqual(
			pluralReviewPayload.files.find((file) => file.relativePath === 'src/pending.ts')?.description,
			'1 Pending, 2 findings, 2 suggestions',
		);
		const resolvedHunk = {
			...pendingHunk,
			id: `suggestion-resolved-${pendingHunk.id}`,
			newText: pendingHunk.oldText,
			newLines: pendingHunk.oldLines,
			operable: false,
		};
		session.files.set(pendingUri.toString(), reviewFileState(pendingUri, 'src/pending.ts', {
			oldText: pendingHunk.oldText,
			newText: pendingHunk.oldText,
			hunks: [],
			appliedAiSuggestions: [{
				suggestionId: 'suggestion-resolved',
				sourceHunkId: pendingHunk.id,
				currentHunkId: resolvedHunk.id,
				reviewItemId: pendingHunk.id,
				originalHunk: pendingHunk,
				replacementText: pendingHunk.oldText,
				appliedHunk: resolvedHunk,
				appliedHunks: [],
				resolvedToIndex: true,
				appliedAt: 1,
			}],
		}));
		const resolvedPayload = buildReviewDashboardPayload(session, pendingUri, () => false, {
			...defaultLlmWikiDashboardState(),
			reviewSuggestions: [aiReviewSuggestion(pendingUri, 'src/pending.ts', pendingHunk, 'suggestion-resolved', 0)],
		});
		const resolvedFile = resolvedPayload.files.find((file) => file.relativePath === 'src/pending.ts');
		assert.strictEqual(resolvedFile?.pendingCount, 0);
		assert.strictEqual(resolvedFile?.acceptDisabled, true);
		assert.strictEqual(resolvedFile?.rejectDisabled, true);
		assert.strictEqual(resolvedFile?.chunks.length, 1);
		assert.strictEqual(resolvedFile?.chunks[0].reviewStatus, 'resolved');
		assert.strictEqual(resolvedFile?.chunks[0].appliedSuggestion?.suggestionId, 'suggestion-resolved');
		assert.strictEqual(resolvedFile?.chunks[0].canAccept, false);
		assert.strictEqual(resolvedFile?.chunks[0].canReject, false);
		const skippedReviewPayload = buildReviewDashboardPayload(session, pendingUri, () => false, {
			...defaultLlmWikiDashboardState(),
			reviewFindings: [aiReviewFinding(skippedUri, 'src/skipped.ts', pendingHunk, 'finding-skipped', 0)],
			reviewSuggestions: [aiReviewSuggestion(skippedUri, 'src/skipped.ts', pendingHunk, 'suggestion-skipped', 0)],
		});
		assert.strictEqual(skippedReviewPayload.files.find((file) => file.relativePath === 'src/skipped.ts')?.description, 'skipped');
		session.files.set(pendingUri.toString(), reviewFileState(pendingUri, 'src/pending.ts', { hunks: [pendingHunk] }));
		session.files.set(reviewedUri.toString(), reviewFileState(reviewedUri, 'src/reviewed.ts', {
			acceptedHunks: [{
				...reviewedHunkFrom({ ...reviewedHunk, newText: 'better reviewed\n' }, 'accept'),
				id: `accept-1-${reviewedHunk.id}`,
				appliedAiSuggestion: {
					suggestionId: 'suggestion-reviewed',
					sourceHunkId: reviewedHunk.id,
					currentHunkId: reviewedHunk.id,
					originalHunk: reviewedHunk,
					replacementText: 'better reviewed\n',
					appliedHunk: { ...reviewedHunk, newText: 'better reviewed\n' },
					appliedAt: 1,
				},
			}],
		}));
		const reviewedFindingPayload = buildReviewDashboardPayload(session, reviewedUri, () => false, {
			...defaultLlmWikiDashboardState(),
			reviewFindings: [
				{
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
				},
				{
					id: 'finding-pending',
					uri: pendingUri.toString(),
					relativePath: 'src/pending.ts',
					hunkId: pendingHunk.id,
					line: pendingHunk.newStart,
					severity: 'info',
					title: 'Other file finding',
					explanation: 'Risk',
					recommendation: 'Fix',
					evidence: [],
					generationOrder: 1,
				},
			],
			reviewSuggestions: [{
				id: 'suggestion-reviewed',
				uri: reviewedUri.toString(),
				relativePath: 'src/reviewed.ts',
				hunkId: reviewedHunk.id,
				line: reviewedHunk.newStart,
				replacementText: 'better reviewed\n',
				rationale: 'Prefer this reviewed code.',
				generationOrder: 0,
			}],
		});
		const reviewedFindingFile = reviewedFindingPayload.files.find((file) => file.relativePath === 'src/reviewed.ts');
		const reviewedFindingChunk = reviewedFindingFile?.chunks[0];
		const otherFileChunk = reviewedFindingPayload.files
			.find((file) => file.relativePath === 'src/pending.ts')
			?.chunks.find((chunk) => chunk.hunkId === pendingHunk.id);
		assert.strictEqual(reviewedFindingFile?.description, '1 Accepted, 1 finding, 1 suggestion');
		assert.strictEqual(reviewedFindingFile?.chunks.length, 1);
		assert.notStrictEqual(reviewedFindingChunk?.hunkId, reviewedHunk.id);
		assert.strictEqual(reviewedFindingChunk?.reviewStatus, 'reviewed');
		assert.strictEqual(reviewedFindingChunk?.findings[0].title, 'Reviewed finding');
		assert.strictEqual(reviewedFindingChunk?.suggestions[0].replacementText, 'better reviewed\n');
		assert.strictEqual(reviewedFindingChunk?.appliedSuggestion?.suggestionId, 'suggestion-reviewed');
		assert.strictEqual(otherFileChunk?.findings[0].title, 'Other file finding');

		const journalAccepted = {
			...reviewedHunkFrom(reviewedHunk, 'accept'),
			id: 'journal-random-id',
			sourceHunkId: reviewedHunk.id,
			reviewItemId: reviewedHunk.id,
		};
		session.files.set(reviewedUri.toString(), reviewFileState(reviewedUri, 'src/reviewed.ts', {
			acceptedHunks: [journalAccepted],
		}));
		const journalAcceptedPayload = buildReviewDashboardPayload(session, reviewedUri, () => false, {
			...defaultLlmWikiDashboardState(),
			reviewFindings: [aiReviewFinding(reviewedUri, 'src/reviewed.ts', reviewedHunk, 'journal-finding', 0)],
		});
		const journalAcceptedFile = journalAcceptedPayload.files.find((file) => file.relativePath === 'src/reviewed.ts');
		assert.strictEqual(journalAcceptedFile?.chunks.length, 1);
		assert.strictEqual(journalAcceptedFile?.chunks[0].hunkId, 'journal-random-id');
		assert.strictEqual(journalAcceptedFile?.chunks[0].findings[0].title, 'Finding');
	});

	test('maps AI review related hunk ids to dashboard related chunks', () => {
		const primaryUri = vscode.Uri.file('D:/repo/src/primary.ts');
		const relatedUri = vscode.Uri.file('D:/repo/src/related.ts');
		const primaryHunk = computeLineDiff(primaryUri.toString(), 'old\n', 'new\n')[0];
		const relatedHunk = computeLineDiff(relatedUri.toString(), 'before\n', 'after\n')[0];
		const session: ReviewSession = {
			id: 'dashboard-related-chunks',
			mode: 'git',
			rootUri: vscode.Uri.file('D:/repo'),
			createdAt: 1,
			files: new Map([
				[primaryUri.toString(), reviewFileState(primaryUri, 'src/primary.ts', { hunks: [primaryHunk] })],
				[relatedUri.toString(), reviewFileState(relatedUri, 'src/related.ts', { hunks: [relatedHunk] })],
			]),
		};

		const payload = buildReviewDashboardPayload(session, primaryUri, () => false, {
			...defaultLlmWikiDashboardState(),
			reviewFindings: [{
				id: 'integration-finding',
				uri: primaryUri.toString(),
				relativePath: 'src/primary.ts',
				hunkId: primaryHunk.id,
				line: primaryHunk.newStart,
				severity: 'warning',
				title: 'Cross-file contract',
				explanation: 'Risk',
				recommendation: 'Fix',
				evidence: [],
				generationOrder: 0,
				source: 'integration',
				relatedHunkIds: [relatedHunk.id, 'missing-related-hunk'],
			}],
		});

		const finding = payload.files
			.find((file) => file.relativePath === 'src/primary.ts')
			?.chunks.find((chunk) => chunk.hunkId === primaryHunk.id)
			?.findings[0];
		assert.deepStrictEqual(finding?.relatedChunks, [{
			uri: relatedUri.toString(),
			hunkId: relatedHunk.id,
			relativePath: 'src/related.ts',
			line: relatedHunk.newStart,
		}]);
	});

	test('classifies dashboard files from chunk change kinds instead of review decisions', () => {
		const addedUri = vscode.Uri.file('D:/repo/src/added.ts');
		const deletedUri = vscode.Uri.file('D:/repo/src/deleted.ts');
		const modifiedUri = vscode.Uri.file('D:/repo/src/modified.ts');
		const mixedUri = vscode.Uri.file('D:/repo/src/mixed.ts');
		const acceptedAddUri = vscode.Uri.file('D:/repo/src/accepted-add.ts');
		const addHunk = computeLineDiff(addedUri.toString(), '', 'added\n')[0];
		const deleteHunk = computeLineDiff(deletedUri.toString(), 'deleted\n', '')[0];
		const modifyHunk = computeLineDiff(modifiedUri.toString(), 'before\n', 'after\n')[0];
		const session: ReviewSession = {
			id: 'dashboard-change-kinds',
			mode: 'git',
			rootUri: vscode.Uri.file('D:/repo'),
			createdAt: 1,
			files: new Map([
				[addedUri.toString(), reviewFileState(addedUri, 'src/added.ts', { hunks: [addHunk] })],
				[deletedUri.toString(), reviewFileState(deletedUri, 'src/deleted.ts', { hunks: [deleteHunk] })],
				[modifiedUri.toString(), reviewFileState(modifiedUri, 'src/modified.ts', { hunks: [modifyHunk] })],
				[mixedUri.toString(), reviewFileState(mixedUri, 'src/mixed.ts', { hunks: [addHunk, deleteHunk] })],
				[acceptedAddUri.toString(), reviewFileState(acceptedAddUri, 'src/accepted-add.ts', {
					acceptedHunks: [reviewedHunkFrom(addHunk, 'accept')],
				})],
			]),
		};

		const files = new Map(buildReviewDashboardPayload(session, undefined, () => false)
			.files.map((file) => [file.relativePath, file]));
		assert.deepStrictEqual(
			[files.get('src/added.ts')?.statusLabel, files.get('src/added.ts')?.statusKind],
			['U', 'untracked'],
		);
		assert.deepStrictEqual(
			[files.get('src/deleted.ts')?.statusLabel, files.get('src/deleted.ts')?.statusKind],
			['D', 'deleted'],
		);
		assert.deepStrictEqual(
			[files.get('src/modified.ts')?.statusLabel, files.get('src/modified.ts')?.statusKind],
			['M', 'modified'],
		);
		assert.deepStrictEqual(
			[files.get('src/mixed.ts')?.statusLabel, files.get('src/mixed.ts')?.statusKind],
			['M', 'modified'],
		);
		assert.deepStrictEqual(
			[files.get('src/accepted-add.ts')?.statusLabel, files.get('src/accepted-add.ts')?.statusKind],
			['U', 'untracked'],
		);
		assert.strictEqual(files.get('src/accepted-add.ts')?.description, '1 Accepted');
	});

	test('deduplicates dashboard chunks when reviewed hunks reappear as pending', () => {
		const uri = vscode.Uri.file('D:/repo/src/duplicate.ts');
		const rejectedUri = vscode.Uri.file('D:/repo/src/rejected-duplicate.ts');
		const duplicateHunk = computeLineDiff(uri.toString(), 'old\nsame\n', 'new\nsame\n')[0];
		const pendingHunk = computeLineDiff(uri.toString(), 'new\nsame\n', 'new\nsame\nlater\n')[0];
		const rejectedDuplicateHunk = computeLineDiff(rejectedUri.toString(), 'before\n', 'after\n')[0];
		const session: ReviewSession = {
			id: 'dashboard-duplicates',
			mode: 'git',
			rootUri: vscode.Uri.file('D:/repo'),
			createdAt: 1,
			files: new Map([
				[uri.toString(), reviewFileState(uri, 'src/duplicate.ts', {
					hunks: [duplicateHunk, pendingHunk],
					acceptedHunks: [reviewedHunkFrom(duplicateHunk, 'accept')],
				})],
				[rejectedUri.toString(), reviewFileState(rejectedUri, 'src/rejected-duplicate.ts', {
					hunks: [rejectedDuplicateHunk],
					rejectedHunks: [reviewedHunkFrom(rejectedDuplicateHunk, 'reject')],
				})],
			]),
		};

		const payload = buildReviewDashboardPayload(session, uri, () => false);
		const acceptedFile = payload.files.find((file) => file.relativePath === 'src/duplicate.ts');
		const rejectedFile = payload.files.find((file) => file.relativePath === 'src/rejected-duplicate.ts');

		assert.strictEqual(acceptedFile?.pendingCount, 1);
		assert.strictEqual(acceptedFile?.reviewedCount, 1);
		assert.strictEqual(acceptedFile?.description, '1 Pending, 1 Accepted');
		assert.deepStrictEqual(acceptedFile?.chunks.map((chunk) => chunk.reviewStatus), ['reviewed', 'pending']);
		assert.strictEqual(acceptedFile?.chunks.some((chunk) => chunk.hunkId === duplicateHunk.id), false);
		assert.strictEqual(acceptedFile?.chunks.some((chunk) => chunk.hunkId === pendingHunk.id), true);
		assert.strictEqual(rejectedFile?.pendingCount, 0);
		assert.strictEqual(rejectedFile?.reviewedCount, 1);
		assert.strictEqual(rejectedFile?.chunks.length, 1);
		assert.strictEqual(rejectedFile?.chunks[0].reviewStatus, 'reviewed');
		assert.strictEqual(rejectedFile?.chunks[0].reviewDecision, 'rejected');
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
				asWebviewUri: (resource: vscode.Uri) => resource,
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
		assert.ok(view.webview.html.includes('<option value="glm">GLM</option>'));
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
		assert.ok(view.webview.html.includes('.wiki-run-status.recovered'));
		assert.ok(view.webview.html.includes("return 'recovered'"));
		assert.ok(view.webview.html.includes('Recovered after error'));
		assert.ok(view.webview.html.includes('const openRunLogKeys = new Set()'));
		assert.ok(view.webview.html.includes('details[data-run-log-key][open]'));
		assert.ok(view.webview.html.includes('function applyRunLogDetailsState'));
		assert.ok(view.webview.html.includes('details.dataset.runLogKey = key'));
		assert.ok(view.webview.html.includes('details.open = openRunLogKeys.has(key)'));
		assert.ok(view.webview.html.includes('function runLogRoundKey'));
		assert.ok(view.webview.html.includes('function runLogEntryKey'));
		assert.ok(view.webview.html.includes('runLogListScrollPositions.get(projectKey)'));
		assert.ok(view.webview.html.includes('restoreScrollTop(wikiRunList, runLogScrollTop)'));
		assert.ok(view.webview.html.includes('function renderProjectAgents'));
		assert.ok(view.webview.html.includes("type: 'selectTrackingProject'"));
		assert.ok(view.webview.html.includes('const runLogDetailScrollPositions = new Map()'));
		assert.ok(view.webview.html.includes('function captureRunLogDetailScrollPositions'));
		assert.ok(view.webview.html.includes('function pruneRunLogDetailScrollPositions'));
		assert.ok(view.webview.html.includes('function restoreRunLogDetailScrollPosition'));
		assert.ok(view.webview.html.includes('let renderedRunLogSignature'));
		assert.ok(view.webview.html.includes('renderedRunLogSignature === nextSignature'));
		assert.ok(view.webview.html.includes('pre.dataset.runLogDetailScrollKey = scrollKey'));
		assert.ok(view.webview.html.includes('function renderReviewFileDetail'));
		assert.ok(view.webview.html.includes('function shouldNavigateReviewCard'));
		assert.ok(view.webview.html.includes("target?.closest('button, a')"));
		assert.ok(view.webview.html.includes('selection.toString().length === 0'));
		assert.ok(view.webview.html.includes('container.contains(selection.anchorNode)'));
		assert.ok(view.webview.html.includes("wrapper.addEventListener('click'"));
		assert.ok(view.webview.html.includes("vscode.postMessage({ type: 'openChunk', uri: file.uri, hunkId: chunk.hunkId })"));
		assert.strictEqual(view.webview.html.includes("container.addEventListener('click', openPrimary)"), false);
		assert.ok(view.webview.html.includes('if (shouldNavigateReviewCard(event, container))'));
		assert.ok(view.webview.html.includes('function restoreScrollTop'));
		assert.ok(view.webview.html.includes('const pendingScrollTops = new WeakMap()'));
		assert.ok(view.webview.html.includes('const suggestionScrollPositions = new Map()'));
		assert.ok(view.webview.html.includes('function captureSuggestionScrollPositions'));
		assert.ok(view.webview.html.includes('function pruneSuggestionScrollPositions'));
		assert.ok(view.webview.html.includes('function restoreSuggestionScrollPosition'));
		assert.ok(view.webview.html.includes('function reviewFileDetailSignature'));
		assert.ok(view.webview.html.includes('let renderedReviewDetailSignature'));
		assert.ok(view.webview.html.includes('renderedReviewDetailSignature === nextSignature'));
		assert.ok(view.webview.html.includes('renderedReviewDetailSignature = nextSignature'));
		assert.ok(view.webview.html.includes('pre.dataset.suggestionScrollKey = scrollKey'));
		assert.ok(view.webview.html.includes('top: pre.scrollTop'));
		assert.ok(view.webview.html.includes('left: pre.scrollLeft'));
		assert.ok(view.webview.html.includes('pre.scrollTop = Math.min(position.top'));
		assert.ok(view.webview.html.includes('pre.scrollLeft = Math.min(position.left'));
		assert.strictEqual(view.webview.html.includes("pre.addEventListener('scroll'"), false);
		assert.ok(view.webview.html.includes('overscroll-behavior: contain'));
		assert.ok(view.webview.html.includes('user-select: text'));
		assert.ok(view.webview.html.includes('const pendingScrollTop = pendingScrollTops.get(container)'));
		assert.ok(view.webview.html.includes('pendingScrollTops.delete(container)'));
		assert.ok(view.webview.html.includes('const listScrollTop = list.scrollTop'));
		assert.ok(view.webview.html.includes('restoreScrollTop(list, listScrollTop)'));
		assert.ok(view.webview.html.includes('renderedReviewDetailUri === file.uri'));
		assert.ok(view.webview.html.includes('pendingScrollTops.get(reviewFileDetail)'));
		assert.ok(view.webview.html.includes('restoreScrollTop(reviewFileDetail, detailScrollTop)'));
		assert.ok(view.webview.html.includes('function aiReviewActionLabel'));
		assert.ok(view.webview.html.includes("return 'Generate AI review'"));
		assert.ok(!view.webview.html.includes("'Retry AI review'"));
		assert.ok(view.webview.html.includes("'Continue AI review'"));
		assert.ok(view.webview.html.includes("action.title = 'Undo AI suggestion'"));
		assert.ok(view.webview.html.includes("return 'Regenerate AI review'"));
		assert.ok(view.webview.html.includes("wiki.aiReviewStatus === 'partial'"));
		assert.ok(view.webview.html.includes("typeof item.round === 'number'"));
		assert.ok(view.webview.html.includes('item.fileUri || item.relativePath'));
		assert.ok(view.webview.html.includes('wiki-run-detail'));
		assert.ok(view.webview.html.includes('wiki-run-round'));
		assert.ok(view.webview.html.includes('wiki-run-file'));
		assert.ok(view.webview.html.includes('review-file-detail'));
		assert.ok(view.webview.html.includes('.review-file-detail::-webkit-scrollbar-track'));
		assert.ok(view.webview.html.includes('scrollbar-color: var(--vscode-scrollbarSlider-background, rgba(128, 128, 128, 0.35)) transparent'));
		assert.ok(view.webview.html.includes('review-chunk'));
		assert.ok(view.webview.html.includes('review-chunk-action'));
		assert.ok(view.webview.html.includes('function chunkActionButton'));
		assert.strictEqual(view.webview.html.includes('review-action-pending'), false);
		assert.strictEqual(view.webview.html.includes('review-action-spin'), false);
		assert.strictEqual(view.webview.html.includes("button.innerHTML = icons.pending"), false);
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
		assert.ok(view.webview.html.includes('review-related-chunk'));
		assert.ok(view.webview.html.includes("vscode.postMessage({ type: 'openChunk', uri: chunk.uri, hunkId: chunk.hunkId })"));
		assert.ok(view.webview.html.includes("container.title = finding.explanation + '\\n\\n' + finding.recommendation;"));
		assert.ok(view.webview.html.includes("chunkActionButton('acceptChunk'"));
		assert.ok(view.webview.html.includes("chunkActionButton('rejectChunk'"));
		assert.ok(view.webview.html.includes("chunkActionButton('undoChunk'"));
		assert.ok(view.webview.html.includes('vscode.postMessage({ type, uri, hunkId, revision })'));
		assert.ok(view.webview.html.includes('.review-chunk.add'));
		assert.ok(view.webview.html.includes('.review-chunk.delete'));
		assert.ok(view.webview.html.includes('.review-chunk.modify'));
		assert.ok(view.webview.html.includes('.review-chunk.has-findings'));
		assert.ok(view.webview.html.includes('.review-chunk.has-suggestion'));
		assert.ok(view.webview.html.includes('function renderReviewChunkSuggestion'));
		assert.ok(view.webview.html.includes('https://open.bigmodel.cn/api/paas/v4'));
		assert.ok(view.webview.html.includes('glm-5.2'));
		assert.ok(view.webview.html.includes("['xhigh', 'XHigh']"));
		assert.ok(view.webview.html.includes('review-suggestion-action'));
		assert.ok(view.webview.html.includes("const canApply = chunk.reviewStatus === 'pending' && !applied"));
		assert.ok(view.webview.html.includes('if (canApply)'));
		assert.ok(view.webview.html.includes('min-width: 64px;'));
		assert.ok(view.webview.html.includes('line-height: 18px;'));
		assert.ok(view.webview.html.includes('cursor: pointer;'));
		assert.ok(view.webview.html.includes('user-select: none;'));
		assert.ok(view.webview.html.includes('.review-suggestion-action::before'));
		assert.ok(view.webview.html.includes('inset: -6px -4px;'));
		assert.ok(view.webview.html.includes('.review-suggestion-action:hover:not(:disabled)'));
		assert.ok(view.webview.html.includes("type: 'applyAiSuggestion'"));
		assert.strictEqual(view.webview.html.includes("type: applied ? 'undoAiSuggestion' : 'applyAiSuggestion'"), false);
		assert.ok(view.webview.html.includes('review-file-result'));
		assert.strictEqual(view.webview.html.includes("details.setAttribute('open', '')"), false);
		assert.strictEqual(view.webview.html.includes('reviewChunkOpenStates'), false);
		assert.strictEqual(view.webview.html.includes("const details = document.createElement(expandable ? 'details' : 'div')"), false);
		assert.strictEqual(view.webview.html.includes('id="findings"'), false);
		assert.strictEqual(view.webview.html.includes('function renderFindings'), false);
		assert.strictEqual(view.webview.html.includes('findings for current file'), false);
		assert.ok(view.webview.html.includes("const container = document.createElement('div')"));
		assert.strictEqual(view.webview.html.includes('No findings for this chunk.'), false);
		assert.ok(view.webview.html.includes("chunk.reviewStatus === 'reviewed'"));
		assert.strictEqual(view.webview.html.includes('review-chunk-preview'), false);
		const dashboardSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'reviewDashboard.ts'), 'utf8');
		assert.strictEqual(dashboardSource.includes('dashboardChunkPreview'), false);
		assert.ok(view.webview.html.includes('var(--file-extension-column-width, auto)'));
		assert.ok(view.webview.html.includes("tree.style.removeProperty('--file-extension-column-width')"));
		assert.ok(view.webview.html.includes('function updateFileExtensionColumnWidth'));
		assert.ok(view.webview.html.includes('icon.getBoundingClientRect().width'));
		assert.ok(view.webview.html.includes("tree.style.setProperty('--file-extension-column-width', width + 'px')"));
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
		assert.ok(view.webview.html.includes("const hasReviewDetail = Boolean(reviewDetailFile) && wikiMode === 'main';"));
		assert.ok(view.webview.html.includes('renderReviewFileDetail(reviewDetailFile);'));
		assert.strictEqual(view.webview.html.includes('renderReviewFileDetail(undefined);'), false);
		assert.ok(view.webview.html.includes('data-menu-action="initializeWiki"'));
		assert.ok(view.webview.html.includes('data-menu-action="updateWiki"'));
		assert.ok(view.webview.html.includes('data-menu-action="generateAiReview"'));
		assert.ok(view.webview.html.includes('data-menu-action="openWikiIndex"'));
		assert.ok(view.webview.html.includes('data-menu-action="openExtensionSettings"'));
		assert.ok(view.webview.html.includes('Code Wiki is up to date'));
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
		messageHandler({ type: 'acceptFile', uri: uri.toString(), revision: 0 });
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
		messageHandler({ type: 'selectTrackingTarget' });
		messageHandler({ type: 'selectTrackingProject', projectId: 'project-b' });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(commands.some((call) => call.command === 'cli-diff.openWikiIndex' && call.args.length === 0));
		assert.ok(commands.some((call) => call.command === 'workbench.action.openSettings'
			&& call.args[0] === '@ext:local.cli-diff-review'));
		assert.ok(commands.some((call) => call.command === 'cli-diff.selectTrackingTarget'));
		assert.ok(commands.some((call) => call.command === 'cli-diff.selectTrackingTarget'
			&& call.args[0] === 'project-b'));
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
		messageHandler({ type: 'acceptChunk', uri: uri.toString(), hunkId: 'hunk-1', revision: 0 });
		messageHandler({ type: 'rejectChunk', uri: uri.toString(), hunkId: 'hunk-1', revision: 0 });
		messageHandler({ type: 'undoChunk', uri: uri.toString(), hunkId: 'hunk-1', revision: 0 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(commands.some((call) => call.command === 'cli-diff.acceptChange'
			&& call.args[0] === uri.toString()
			&& call.args[1] === 'hunk-1'
			&& call.args[2] === 0));
		assert.ok(commands.some((call) => call.command === 'cli-diff.rejectChange'
			&& call.args[0] === uri.toString()
			&& call.args[1] === 'hunk-1'
			&& call.args[2] === 0));
		assert.ok(commands.some((call) => call.command === 'cli-diff.restoreChange'
			&& call.args[0] === uri.toString()
			&& call.args[1] === 'hunk-1'
			&& call.args[2] === 0));
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

	test('allows reviewed undo to use exact coordinates when context is duplicated', () => {
		const block = 'before1\nbefore2\nbefore3\nx\nafter1\nafter2\nafter3\n';
		const text = block + block;
		const context = captureLineBlockContext(text, 3, 1);

		assert.strictEqual(lineBlockWithContextMatches(text, 3, 1, 'x\n', context), true);
		assert.strictEqual(lineBlockWithContextMatchesUniquely(text, 3, 1, 'x\n', context), false);
	});

	test('accepts file-level added hunks at their recorded duplicated context', async () => {
		const uri = vscode.Uri.file('/repo/src/repeated.ts');
		const block = 'before1\nbefore2\nbefore3\nafter1\nafter2\nafter3\n';
		const baseline = block + block;
		const current = replaceLineBlock(baseline, 3, 0, 'added\n');
		const [hunk] = computeLineDiff(uri.toString(), baseline, current);
		assert.ok(hunk);
		assert.strictEqual(lineBlockWithContextMatchesUniquely(baseline, hunk.oldStart, hunk.oldLines, hunk.oldText, {
			before: hunk.oldContextBefore,
			after: hunk.oldContextAfter,
		}), false);

		const file = reviewFileState(uri, 'src/repeated.ts', { oldText: baseline, newText: current, hunks: [hunk] });
		const session: ReviewSession = { id: 'duplicate-file-accept', mode: 'git', rootUri: vscode.Uri.file('/repo'), createdAt: 1, files: new Map([[uri.toString(), file]]) };
		const harness = reviewControllerHarness(session, current);

		await harness.controller.acceptFileCore(file);

		assert.strictEqual(file.oldText, current);
		assert.strictEqual(file.hunks.length, 0);
		assert.strictEqual(file.acceptedHunks.length, 1);
		assert.deepStrictEqual(harness.writes, []);
		assert.strictEqual(harness.unmatchedMutationCount(), 0);
	});

	test('matches duplicate added chunk content at its recorded current coordinate', () => {
		const uri = vscode.Uri.file('/repo/src/repeated-add.ts');
		const emptyBlock = 'before1\nbefore2\nbefore3\nafter1\nafter2\nafter3\n';
		const existingBlock = 'before1\nbefore2\nbefore3\nadded\nafter1\nafter2\nafter3\n';
		const baseline = emptyBlock + existingBlock;
		const current = replaceLineBlock(baseline, 3, 0, 'added\n');
		const [hunk] = computeLineDiff(uri.toString(), baseline, current);
		assert.ok(hunk);
		assert.strictEqual(hunk.kind, 'add');
		assert.strictEqual(lineBlockWithContextMatchesUniquely(current, hunk.newStart, hunk.newLines, hunk.newText, {
			before: hunk.newContextBefore,
			after: hunk.newContextAfter,
		}), false);

		const controller = Object.create(ReviewController.prototype) as TestReviewController;
		assert.strictEqual(controller.originalHunkSideMatches(current, hunk, 'new', hunk.newStart), true);
		assert.strictEqual(replaceLineBlock(current, hunk.newStart, hunk.newLines, hunk.oldText), baseline);
	});

	test('refreshes instead of accepting an unmatched file hunk', async () => {
		const uri = vscode.Uri.file('/repo/src/stale.ts');
		const [original] = computeLineDiff(uri.toString(), 'old\n', 'new\n');
		assert.ok(original);
		const hunk = { ...original, oldText: 'stale\n' };
		const file = reviewFileState(uri, 'src/stale.ts', { oldText: 'old\n', newText: 'new\n', hunks: [hunk] });
		const session: ReviewSession = { id: 'stale-file-accept', mode: 'git', rootUri: vscode.Uri.file('/repo'), createdAt: 1, files: new Map([[uri.toString(), file]]) };
		const harness = reviewControllerHarness(session, 'new\n');

		await harness.controller.acceptFileCore(file);

		assert.strictEqual(file.oldText, 'old\n');
		assert.strictEqual(file.hunks.length, 1);
		assert.strictEqual(file.acceptedHunks.length, 0);
		assert.deepStrictEqual(harness.writes, []);
		assert.strictEqual(harness.unmatchedMutationCount(), 1);
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

	test('merges root AGENTS.md managed guidance without overwriting user content', () => {
		const created = mergeManagedAgentsGuidance(undefined, '# Project Agents\n\nUse `.agents/skills/llm-code-wiki`.');
		assert.ok(created.includes(agentsGuidanceStartMarker));
		assert.ok(created.includes(agentsGuidanceEndMarker));
		assert.ok(created.includes('.agents/skills/llm-code-wiki'));

		const appended = mergeManagedAgentsGuidance('# Existing\n\nKeep this.\n', '## Cli Diff Review\n\nRead the wiki.');
		assert.ok(appended.startsWith('# Existing\n\nKeep this.'));
		assert.ok(appended.includes('## Cli Diff Review'));

		const replaced = mergeManagedAgentsGuidance(appended, '## Cli Diff Review\n\nUpdated guidance.');
		assert.ok(replaced.includes('# Existing'));
		assert.ok(replaced.includes('Updated guidance.'));
		assert.ok(!replaced.includes('Read the wiki.'));

		assert.strictEqual(removeManagedAgentsGuidanceBlock(replaced), '# Existing\n\nKeep this.\n');
		assert.strictEqual(removeManagedAgentsGuidanceBlock(created), undefined);
	});

	test('documents normal coding agent collaboration boundaries', () => {
		const root = path.join(__dirname, '..', '..');
		const skill = fs.readFileSync(path.join(root, 'llm-code-wiki', 'SKILL.md'), 'utf8');
		const schema = fs.readFileSync(path.join(root, 'llm-code-wiki', 'schema.md'), 'utf8');
		const initializer = fs.readFileSync(path.join(root, 'src', 'wiki', 'wikiInitializer.ts'), 'utf8');

		assert.ok(skill.includes('✨💬 我已阅读llm-code-wiki.SKILL.md'));
		assert.ok(skill.includes('✨🎯 我已阅读llm-code-wiki/references：{references名称}'));
		assert.ok(skill.includes('`.agents/skills/llm-code-wiki`'));
		assert.ok(skill.includes('Do not read every reference page at once unless the task truly requires broad repository context.'));
		assert.ok(skill.includes('Normal coding agents are encouraged to help maintain business knowledge pages under `references/`'));
		assert.ok(skill.includes('keeping the wiki aligned is part of the expected work when the change affects durable project knowledge'));
		assert.ok(skill.includes('Wiki updates are expected when changes affect behavior, architecture, workflows, public interfaces, commands, configuration, data flow, module responsibilities, file structure, or important design decisions.'));
		assert.ok(skill.includes('Small formatting-only edits, comment-only changes, or mechanical cleanups with no durable knowledge change usually do not require wiki updates; say why in the final response.'));
		assert.ok(skill.includes('Before substantial code changes, read `references/index.md` and only the relevant reference pages.'));
		assert.ok(skill.includes('In the final response, state whether wiki pages were updated, and if not, why no wiki update was needed.'));
		assert.ok(skill.includes('Do not modify `SKILL.md`, `references/schema.md`, or `.state.json`.'));
		assert.ok(skill.includes('When adding a new business knowledge page, update `references/index.md`.'));
		assert.ok(skill.includes('treat source as authoritative and update the affected `references/` pages'));
		assert.ok(skill.includes('✨⚠️ 发现知识库与源码存在较多不一致。我会优先基于源码协助更新可确认的内容；建议随后在 Cli Diff Review 中执行 Update LLM Code Wiki 做一次整体同步。'));

		assert.ok(schema.includes('`Host Wiki Agent`: the Cli Diff Review plugin Agent'));
		assert.ok(schema.includes('`Normal coding agent`: an external coding agent'));
		assert.ok(schema.includes('`AI Review Agent`: the Cli Diff Review review Agent'));
		assert.ok(schema.includes('Normal coding agents are encouraged to edit business knowledge pages'));
		assert.ok(schema.includes('keeping the wiki aligned is part of the expected work when the change affects durable project knowledge'));
		assert.ok(schema.includes('Wiki updates are expected when changes affect behavior, architecture, workflows, public interfaces, commands, configuration, data flow, module responsibilities, file structure, or important design decisions.'));
		assert.ok(schema.includes('Small formatting-only edits, comment-only changes, or mechanical cleanups with no durable knowledge change usually do not require wiki updates'));
		assert.ok(schema.includes('avoid low-value documentation churn'));
		assert.ok(schema.includes('`.agents/skills/llm-code-wiki/references`'));
		assert.ok(schema.includes('Do not list `references/schema.md` as a normal knowledge page.'));
		assert.ok(schema.includes('`.state.json`'));

		assert.ok(initializer.includes('write_agents_guidance'));
		assert.ok(initializer.includes('.agents/skills/llm-code-wiki/SKILL.md'));
		assert.ok(initializer.includes('Explicitly invite Claude Code, Codex, and other coding agents'));
		assert.ok(initializer.includes('keeping the wiki aligned is part of the expected work when the change affects durable project knowledge'));
		assert.ok(initializer.includes('changes affect behavior, architecture, workflows, public interfaces, commands, configuration, data flow, module responsibilities, file structure, or important design decisions'));
		assert.ok(initializer.includes('formatting-only edits, comment-only changes, or mechanical cleanups'));
		assert.ok(initializer.includes('should record uncertainty in references/open-questions.md'));
		assert.ok(initializer.includes('state in the final response whether wiki pages were updated, or why no wiki update was needed'));
		assert.ok(initializer.includes('must not modify .agents/skills/llm-code-wiki/SKILL.md'));
		assert.ok(initializer.includes('do not list schema.md in the main index catalog'));
		assert.ok(initializer.includes('Preserve and integrate source-grounded Wiki updates already made by normal coding agents'));
		assert.ok(initializer.includes('Do not add schema.md to the normal index.md catalog of business wiki pages.'));
	});

	test('passes Agent trace events through Wiki initialization', async function (this: Mocha.Context) {
		this.timeout(30000);
		const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-extension-'));
		const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-wiki-init-'));
		try {
			writeRepoFile(extensionRoot, 'llm-code-wiki/SKILL.md', '# Skill\n');
			writeRepoFile(extensionRoot, 'llm-code-wiki/schema.md', '# Schema\n');
			writeRepoFile(repositoryRoot, 'src/app.ts', 'export const value = 1;\n');
			const wiki = validWikiResponse();
			const responses = [
				JSON.stringify({
					type: 'tool_calls',
					calls: [
						...wiki.files.map((file, index) => ({
							id: `write-${index}`,
							name: 'write_wiki_file',
							arguments: file,
						})),
						{
							id: 'write-agents',
							name: 'write_agents_guidance',
							arguments: {
								content: '# Project Agents\n\nThis project uses `.agents/skills/llm-code-wiki` for repository knowledge.',
							},
						},
					],
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
			const agents = fs.readFileSync(path.join(repositoryRoot, 'AGENTS.md'), 'utf8');
			assert.ok(agents.includes(agentsGuidanceStartMarker));
			assert.ok(agents.includes('.agents/skills/llm-code-wiki'));
			assert.ok(trace.some((event) => event.kind === 'llm_request'));
			assert.ok(trace.some((event) => event.kind === 'tool_result' && event.summary.includes('write_wiki_file')));
			assert.ok(trace.some((event) => event.kind === 'run_complete'));
		} finally {
			fs.rmSync(extensionRoot, { recursive: true, force: true });
			fs.rmSync(repositoryRoot, { recursive: true, force: true });
		}
	});

	test('deleteWiki removes the wiki directory and root AGENTS.md managed block', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-wiki-delete-'));
		try {
			writeRepoFile(root, '.agents/skills/llm-code-wiki/SKILL.md', '# Skill\n');
			writeRepoFile(root, 'AGENTS.md', mergeManagedAgentsGuidance('# Human guidance\n', '## Cli Diff Review\n\nRead the wiki.'));
			const service = new WikiInitializationService(vscode.Uri.file(root));

			await service.deleteWiki(vscode.Uri.file(root));

			assert.strictEqual(fs.existsSync(path.join(root, '.agents', 'skills', 'llm-code-wiki')), false);
			assert.strictEqual(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# Human guidance\n');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
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

	test('sends GLM JSON Output, thinking, and native tools', async () => {
		const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
		const client = new GlmClient('https://open.bigmodel.cn/api/paas/v4', 'secret', 'xhigh', async (input, init) => {
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
			model: 'glm-5.2',
			messages: [{ role: 'user', content: 'Use json and inspect the file.' }],
			tools: [{
				name: 'read_file',
				description: 'Read a file.',
				parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
			}],
		});

		assert.strictEqual(calls[0].url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
		assert.deepStrictEqual(calls[0].body.response_format, { type: 'json_object' });
		assert.deepStrictEqual(calls[0].body.thinking, { type: 'enabled' });
		assert.strictEqual(calls[0].body.reasoning_effort, 'xhigh');
		assert.strictEqual(calls[0].body.temperature, undefined);
		assert.strictEqual(calls[0].body.tool_choice, 'auto');
		const tools = calls[0].body.tools as Array<{ function: { strict?: boolean } }>;
		assert.strictEqual(tools[0].function.strict, undefined);
		assert.strictEqual(completion.reasoningContent, 'Need the source file.');
		assert.strictEqual(completion.toolCalls[0].name, 'read_file');
	});

	test('supports GLM disabled thinking', async () => {
		let body: Record<string, unknown> = {};
		const client = new GlmClient('https://open.bigmodel.cn/api/paas/v4', 'secret', 'disabled', async (_input, init) => {
			body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ choices: [{ message: { content: '{"type":"final","result":{}}' } }] }), { status: 200 });
		});

		await client.completeJson({ model: 'glm-5.2', systemPrompt: 'json system', userPrompt: 'user', temperature: 0.3 });

		assert.deepStrictEqual(body.thinking, { type: 'disabled' });
		assert.strictEqual(body.temperature, 0.3);
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
		assert.strictEqual(saved.profiles.length, 1);
		assert.strictEqual(saved.profiles[0].id, saved.activeProfileId);
		assert.strictEqual(runtime?.apiKey, 'secret-key');
		assert.strictEqual(saved.jsonOutputEnabled, false);
		assert.strictEqual(saved.thinkingMode, 'disabled');
		assert.strictEqual(saved.strictTools, false);
		assert.strictEqual(globalState.values.has('cliDiff.llm.apiKey'), false);

		await store.save({
			profileId: saved.activeProfileId,
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

	test('stores GLM capabilities and applies provider defaults', async () => {
		const globalState = new TestMemento();
		const secrets = new TestSecretStorage();
		const store = new LlmConfigStore({ globalState, secrets } as unknown as vscode.ExtensionContext);

		const saved = await store.save({
			provider: 'glm',
			baseUrl: '',
			model: '',
			apiKey: 'secret-key',
			jsonOutputEnabled: false,
			thinkingMode: 'xhigh',
			strictTools: true,
		});
		const runtime = await store.runtimeConfig();

		assert.strictEqual(saved.provider, 'glm');
		assert.strictEqual(saved.baseUrl, 'https://open.bigmodel.cn/api/coding/paas/v4');
		assert.strictEqual(saved.model, 'glm-5.2');
		assert.strictEqual(saved.jsonOutputEnabled, true);
		assert.strictEqual(saved.thinkingMode, 'xhigh');
		assert.strictEqual(saved.strictTools, false);
		assert.strictEqual(runtime?.provider, 'glm');
		assert.strictEqual(runtime?.apiKey, 'secret-key');
	});

	test('migrates legacy provider config to capability defaults', async () => {
		const openAiState = new TestMemento();
		openAiState.values.set('cliDiff.llm.provider', 'openai');
		openAiState.values.set('cliDiff.llm.baseUrl', 'https://api.openai.com/v1');
		openAiState.values.set('cliDiff.llm.model', 'gpt-test');
		const anthropicState = new TestMemento();
		anthropicState.values.set('cliDiff.llm.provider', 'anthropic');
		anthropicState.values.set('cliDiff.llm.baseUrl', 'https://api.anthropic.com');
		anthropicState.values.set('cliDiff.llm.model', 'claude-test');
		const openAiSecrets = new TestSecretStorage();
		await openAiSecrets.store('cliDiff.llm.apiKey', 'openai-secret');
		const anthropicSecrets = new TestSecretStorage();
		await anthropicSecrets.store('cliDiff.llm.apiKey', 'anthropic-secret');

		const openAi = await new LlmConfigStore({ globalState: openAiState, secrets: openAiSecrets } as unknown as vscode.ExtensionContext).savedConfig();
		const anthropic = await new LlmConfigStore({ globalState: anthropicState, secrets: anthropicSecrets } as unknown as vscode.ExtensionContext).savedConfig();

		assert.strictEqual(openAi.jsonOutputEnabled, true);
		assert.strictEqual(anthropic.jsonOutputEnabled, false);
		assert.strictEqual(openAi.thinkingMode, 'disabled');
		assert.strictEqual(anthropic.strictTools, false);
		assert.strictEqual(openAi.activeProfileId, 'default');
		assert.strictEqual(anthropic.profiles[0].configured, true);
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

	test('migrates legacy OpenAI-compatible official GLM config', async () => {
		const globalState = new TestMemento();
		globalState.values.set('cliDiff.llm.provider', 'openai');
		globalState.values.set('cliDiff.llm.baseUrl', 'https://open.bigmodel.cn/api/paas/v4');
		globalState.values.set('cliDiff.llm.model', 'glm-5.2');
		const secrets = new TestSecretStorage();

		const saved = await new LlmConfigStore({ globalState, secrets } as unknown as vscode.ExtensionContext).savedConfig();

		assert.strictEqual(saved.provider, 'glm');
		assert.strictEqual(saved.baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
		assert.strictEqual(saved.model, 'glm-5.2');
		assert.strictEqual(saved.jsonOutputEnabled, true);
		assert.strictEqual(saved.thinkingMode, 'high');
		assert.strictEqual(saved.strictTools, false);
		assert.strictEqual(globalState.values.get('cliDiff.llm.provider'), 'glm');
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
				activeProfileId: 'openai-gpt-test',
				profiles: [{
					id: 'openai-gpt-test',
					provider: 'openai' as const,
					baseUrl: 'https://example.test',
					model: 'gpt-test',
					hasApiKey: true,
					configured: true,
					jsonOutputEnabled: true,
					thinkingMode: 'disabled' as const,
					strictTools: false,
				}],
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

	test('rejects native tool arguments outside an enum', async () => {
		const trace: AgentTraceEvent[] = [];
		const completions = [
			{ content: '', toolCalls: [{ id: 'call-1', name: 'search', arguments: '{"mode":"unsupported"}' }] },
			{ content: '{"type":"final","result":{"summary":"done"}}', toolCalls: [] },
		];
		const result = await new AgentRunner().run({
			config: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'test', apiKey: 'secret' },
			client: { completeJson: async () => '', complete: async () => completions.shift() ?? { content: '', toolCalls: [] } },
			systemPrompt: 'test',
			userPrompt: 'test',
			tools: [{
				name: 'search',
				description: 'Search.',
				parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['literal', 'regex'] } }, required: ['mode'], additionalProperties: false },
				execute: async (args) => args,
			}],
			onTrace: (event) => trace.push(event),
		});

		assert.strictEqual(result.result.summary, 'done');
		assert.ok(trace.some((event) => event.kind === 'parse_error' && event.summary.includes('allowed values')));
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

	test('uses GLM native tools and returns reasoning content on the next round', async () => {
		const requests: Array<{ jsonOutput?: boolean; tools?: unknown[]; messages?: Array<{ role: string; reasoningContent?: string; toolCallId?: string }> }> = [];
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
				provider: 'glm',
				baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
				model: 'glm-5.2',
				apiKey: 'secret',
				jsonOutputEnabled: true,
				thinkingMode: 'high',
				strictTools: false,
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
		assert.strictEqual(requests[0].jsonOutput, true);
		assert.ok(requests[0].tools?.length);
		assert.ok(requests[1].messages?.some((message) => message.role === 'assistant' && message.reasoningContent === 'I need to echo.'));
		assert.ok(requests[1].messages?.some((message) => message.role === 'tool' && message.toolCallId === 'call-1'));
		assert.ok(trace.some((event) => event.kind === 'run_start' && event.summary.includes('GLM model glm-5.2')));
		assert.ok(trace.some((event) => event.kind === 'llm_response' && event.summary.includes('native tool call')));
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

	test('does not cap tool calls and resumes from the last complete Agent round', async () => {
		const tool = {
			name: 'echo',
			description: 'Echo.',
			parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false },
			execute: async (args: Record<string, unknown>) => args,
		};
		const calls = Array.from({ length: 41 }, (_, index) => ({ id: `call-${index}`, name: 'echo', arguments: { value: index } }));
		const responses = [
			JSON.stringify({ type: 'tool_calls', calls }),
			'network unavailable',
		];
		let checkpoint: AgentRunCheckpoint | undefined;
		await assert.rejects(() => new AgentRunner().run({
			config: { provider: 'openai', baseUrl: 'https://example.test', model: 'test', apiKey: 'secret' },
			client: {
				completeJson: async () => {
					const response = responses.shift();
					if (response === 'network unavailable') {
						throw new Error(response);
					}
					return response ?? '';
				},
			},
			systemPrompt: 'test checkpoint',
			userPrompt: 'test',
			tools: [tool],
			maxRounds: 'unlimited',
			onCheckpoint: (value) => {
				checkpoint = value;
			},
		}), /network unavailable/);
		assert.ok(checkpoint);
		assert.strictEqual(checkpoint.nextRound, 2);
		assert.strictEqual(checkpoint.toolCalls, 41);

		const resumedRequests: unknown[] = [];
		const resumed = await new AgentRunner().run({
			config: { provider: 'openai', baseUrl: 'https://example.test', model: 'test', apiKey: 'secret' },
			client: {
				completeJson: async (request) => {
					resumedRequests.push(request);
					return '{"type":"final","result":{"summary":"continued"}}';
				},
			},
			systemPrompt: 'test checkpoint',
			userPrompt: 'test',
			tools: [tool],
			maxRounds: 'unlimited',
			resumeFrom: checkpoint,
		});
		assert.strictEqual(resumed.rounds, 2);
		assert.strictEqual(resumed.toolCalls, 41);
		assert.strictEqual(resumed.result.summary, 'continued');
		assert.ok(JSON.stringify(resumedRequests[0]).includes('tool_results'));
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
		assert.strictEqual(tools.some((tool) => tool.name === 'list_wiki_files'), false);
		assert.strictEqual(tools.some((tool) => tool.name === 'read_wiki_file'), false);
		assert.strictEqual(tools.some((tool) => tool.name === 'search_wiki_files'), false);
		const toolsWithWiki = createReadOnlyAgentTools({ root: workspaceFolder('/repo'), reviewSession: session, includeWikiTools: true });
		assert.strictEqual(toolsWithWiki.some((tool) => tool.name === 'list_wiki_files'), true);
		assert.strictEqual(toolsWithWiki.some((tool) => tool.name === 'read_wiki_file'), true);
		assert.strictEqual(toolsWithWiki.some((tool) => tool.name === 'search_wiki_files'), true);
		assert.strictEqual(toolsWithWiki.some((tool) => tool.name === 'search_workspace'), true);
		assert.strictEqual(toolsWithWiki.some((tool) => tool.name === 'list_workspace_directory'), true);
		assert.strictEqual(toolsWithWiki.some((tool) => tool.name === 'read_workspace_file'), true);
		assert.strictEqual(toolsWithWiki.some((tool) => tool.name === 'read_pending_change'), true);
		assert.strictEqual(toolsWithWiki.some((tool) => tool.name === 'write_wiki_file'), false);
		const list = await tools.find((tool) => tool.name === 'list_workspace_files')?.execute({}, undefined) as { files: string[] };
		const read = await tools.find((tool) => tool.name === 'read_workspace_file')?.execute({ path: 'src/deleted.ts' }, undefined) as {
			content: string;
			currentExists: boolean;
			contentSource: string;
			startLine: number;
			endLine: number;
			totalLines: number;
		};
		const readTool = tools.find((tool) => tool.name === 'read_workspace_file');
		if (!readTool) {
			throw new Error('read_workspace_file tool is unavailable');
		}
		const readSchema = readTool.parameters as { required?: string[]; properties?: Record<string, unknown>; additionalProperties?: boolean };
		const searchTool = tools.find((tool) => tool.name === 'search_workspace');
		if (!searchTool) {
			throw new Error('search_workspace tool is unavailable');
		}
		const search = await searchTool.execute({ query: 'removed', mode: 'literal', limit: 10 }, undefined) as {
			matches: Array<{ path: string; text: string }>;
		};
		const fuzzy = await searchTool.execute({ query: 'eprtd', mode: 'fuzzy', limit: 10 }, undefined) as {
			matches: Array<{ path: string }>;
		};
		const regex = await searchTool.execute({ query: 'removed\\s*=\\s*true', mode: 'regex', limit: 10 }, undefined) as {
			matches: Array<{ path: string }>;
		};

		assert.ok(list.files.includes('src/deleted.ts'));
		assert.strictEqual(read.content, 'export const removed = true;\n');
		assert.strictEqual(read.currentExists, false);
		assert.strictEqual(read.contentSource, 'reviewOldText');
		assert.strictEqual(read.startLine, 1);
		assert.strictEqual(read.endLine, 1);
		assert.strictEqual(read.totalLines, 1);
		assert.deepStrictEqual(readSchema.required, ['path', 'offset', 'limit']);
		assert.ok(readSchema.properties?.offset);
		assert.ok(readSchema.properties?.limit);
		assert.strictEqual(readSchema.additionalProperties, false);
		assert.strictEqual(search.matches[0].path, 'src/deleted.ts');
		assert.ok(search.matches[0].text.includes('removed'));
		assert.strictEqual(fuzzy.matches[0].path, 'src/deleted.ts');
		assert.strictEqual(regex.matches[0].path, 'src/deleted.ts');
		await assert.rejects(
			() => searchTool.execute({ query: '[', mode: 'regex', limit: 10 }, undefined),
			/SyntaxError/,
		);
	});

	test('reads workspace files by line range and distinguishes files from directories', async function (this: Mocha.Context) {
		this.timeout(10000);
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-agent-tools-'));
		try {
			writeRepoFile(root, 'src/app.go', 'first\r\nsecond\r\nthird');
			writeRepoFile(root, 'src/nested/helper.go', 'package nested\n');
			writeRepoFile(root, 'src/.hidden.go', 'package hidden\n');
			writeRepoFile(root, 'node_modules/package/index.js', 'module.exports = {};\n');
			const tools = createReadOnlyAgentTools({ root: workspaceFolder(root) });
			const read = tools.find((tool) => tool.name === 'read_workspace_file');
			const list = tools.find((tool) => tool.name === 'list_workspace_directory');
			assert.ok(read);
			assert.ok(list);

			const range = await read.execute({ path: 'src/app.go', offset: 2, limit: 2 }, undefined) as {
				content: string;
				truncated: boolean;
				startLine: number;
				endLine: number;
				totalLines: number;
				contentSource: string;
			};
			assert.deepStrictEqual(range, {
				path: 'src/app.go',
				content: 'second\r\nthird',
				truncated: true,
				currentExists: true,
				contentSource: 'workspace',
				startLine: 2,
				endLine: 3,
				totalLines: 3,
			});
			const complete = await read.execute({ path: 'src/app.go', offset: 1, limit: 0 }, undefined) as { content: string; truncated: boolean };
			assert.strictEqual(complete.content, 'first\r\nsecond\r\nthird');
			assert.strictEqual(complete.truncated, false);

			const beyondEnd = await read.execute({ path: 'src/app.go', offset: 20, limit: 5 }, undefined) as {
				content: string;
				startLine: number;
				endLine: number;
				totalLines: number;
			};
			assert.strictEqual(beyondEnd.content, '');
			assert.strictEqual(beyondEnd.startLine, 20);
			assert.strictEqual(beyondEnd.endLine, 19);
			assert.strictEqual(beyondEnd.totalLines, 3);

			assert.deepStrictEqual(await list.execute({ path: 'src' }, undefined), {
				path: 'src',
				entries: [
					{ name: 'nested', path: 'src/nested', type: 'directory' },
					{ name: 'app.go', path: 'src/app.go', type: 'file' },
				],
			});
			const rootListing = await list.execute({ path: '.' }, undefined) as { entries: Array<{ path: string }> };
			assert.deepStrictEqual(rootListing.entries.map((entry) => entry.path), ['src']);

			await assert.rejects(() => read.execute({ path: 'src' }, undefined), /is a directory, not a file.*list_workspace_directory/);
			await assert.rejects(() => read.execute({ path: 'missing.go' }, undefined), /does not exist or cannot be accessed/);
			await assert.rejects(() => read.execute({ path: 'src/app.go', offset: 0 }, undefined), /offset must be a positive integer/);
			await assert.rejects(() => read.execute({ path: 'src/app.go', limit: 1.5 }, undefined), /limit must be a non-negative integer/);
			await assert.rejects(() => list.execute({ path: 'src/app.go' }, undefined), /is a file.*read_workspace_file/);
			await assert.rejects(() => list.execute({ path: 'missing' }, undefined), /does not exist or cannot be accessed/);
			await assert.rejects(() => list.execute({ path: '../outside' }, undefined), /Invalid relative path/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('protects Wiki template and state files from Agent writes', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-agent-'));
		try {
			writeRepoFile(root, '.agents/skills/llm-code-wiki/references/schema.md', '# Schema\n');
			writeRepoFile(root, '.agents/skills/llm-code-wiki/references/interfaces/api.md', '# API Contract\nThe API returns a token.\n');
			writeRepoFile(root, 'AGENTS.md', '# Human notes\n\nKeep me.\n');
			let agentsGuidanceWritten = false;
			const tools = createWikiAgentTools({ root: workspaceFolder(root), generatedFiles: new Set() });
			const list = tools.find((tool) => tool.name === 'list_wiki_files');
			const read = tools.find((tool) => tool.name === 'read_wiki_file');
			const search = tools.find((tool) => tool.name === 'search_wiki_files');
			const write = tools.find((tool) => tool.name === 'write_wiki_file');
			const writeAgents = createWikiAgentTools({
				root: workspaceFolder(root),
				generatedFiles: new Set(),
				onAgentsGuidanceWritten: () => {
					agentsGuidanceWritten = true;
				},
			}).find((tool) => tool.name === 'write_agents_guidance');
			assert.ok(list);
			assert.ok(read);
			assert.ok(search);
			assert.ok(write);
			assert.ok(writeAgents);
			assert.ok(JSON.stringify(writeAgents.parameters).includes('durable project knowledge'));
			assert.ok(JSON.stringify(writeAgents.parameters).includes('formatting-only/comment-only/mechanical cleanups'));
			assert.ok(JSON.stringify(writeAgents.parameters).includes('SKILL.md, references/schema.md, and .state.json are protected'));
			assert.deepStrictEqual(await list.execute({}, undefined), { files: ['interfaces/api.md', 'schema.md'] });
			assert.deepStrictEqual(await search.execute({ query: 'api returns', mode: 'fuzzy', limit: 10 }, undefined), {
				matches: [{ path: 'interfaces/api.md', line: 2, text: 'The API returns a token.' }],
			});
			assert.deepStrictEqual(await search.execute({ query: 'API\\s+returns', mode: 'regex', limit: 10 }, undefined), {
				matches: [{ path: 'interfaces/api.md', line: 2, text: 'The API returns a token.' }],
			});
			assert.deepStrictEqual(await read.execute({ path: 'schema.md' }, undefined), {
				path: '.agents/skills/llm-code-wiki/references/schema.md',
				content: '# Schema\n',
				truncated: false,
			});
			await assert.rejects(() => write.execute({ path: 'schema.md', content: 'changed' }), /protected/);
			await assert.rejects(() => write.execute({ path: 'SKILL.md', content: 'changed' }), /protected/);
			await assert.rejects(() => write.execute({ path: '../outside.md', content: 'changed' }), /Invalid relative path/);
			await write.execute({ path: 'overview.md', content: '# Overview\n' });
			assert.strictEqual(fs.readFileSync(path.join(root, '.agents', 'skills', 'llm-code-wiki', 'references', 'overview.md'), 'utf8'), '# Overview\n');
			await assert.rejects(() => writeAgents.execute({ content: `${agentsGuidanceStartMarker}\nnope` }), /managed block markers/);
			await writeAgents.execute({ content: '## Cli Diff Review\n\nRead `.agents/skills/llm-code-wiki/SKILL.md`.' });
			const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
			assert.strictEqual(agentsGuidanceWritten, true);
			assert.ok(agents.includes('# Human notes'));
			assert.ok(agents.includes(agentsGuidanceStartMarker));
			assert.ok(agents.includes('.agents/skills/llm-code-wiki/SKILL.md'));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

suite('Wiki state', () => {
	test('copies the generic specification and detects source fingerprint changes', async function (this: Mocha.Context) {
		this.timeout(30000);
		const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-extension-'));
		const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-wiki-state-'));
		try {
			writeRepoFile(extensionRoot, 'llm-code-wiki/SKILL.md', '# Skill\n');
			writeRepoFile(extensionRoot, 'llm-code-wiki/schema.md', '# Schema\n');
			writeRepoFile(repositoryRoot, 'src/app.ts', 'export const value = 1;\n');
			writeRepoFile(repositoryRoot, '.env', 'secret\n');
			writeRepoFile(repositoryRoot, 'AGENTS.md', '# Agent guidance\n');
			const folder = workspaceFolder(repositoryRoot);
			const service = new WikiStateService(vscode.Uri.file(extensionRoot));
			const state = await service.ensureScaffold(folder, 'initializing');

			assert.strictEqual(fs.existsSync(path.join(repositoryRoot, '.wiki')), false);
			assert.strictEqual(fs.existsSync(path.join(repositoryRoot, '.skills', 'llm-code-wiki')), false);
			assert.strictEqual(fs.readFileSync(path.join(repositoryRoot, '.agents', 'skills', 'llm-code-wiki', 'SKILL.md'), 'utf8'), '# Skill\n');
			assert.strictEqual(fs.readFileSync(path.join(repositoryRoot, '.agents', 'skills', 'llm-code-wiki', 'references', 'schema.md'), 'utf8'), '# Schema\n');
			assert.strictEqual(state.version, 2);
			assert.ok(state.skillHash);
			assert.ok(state.schemaHash);
			assert.strictEqual(fs.existsSync(path.join(repositoryRoot, '.agents', 'skills', 'llm-code-wiki', '.state.json')), true);
			const ready = await service.completeRun(folder, state, 'done', ['overview.md']);
			assert.strictEqual(ready.status, 'ready');
			assert.ok(ready.sourceFingerprints['src/app.ts']);
			assert.strictEqual(ready.sourceFingerprints['.env'], undefined);
			assert.strictEqual(ready.sourceFingerprints['AGENTS.md'], undefined);
			assert.strictEqual(ready.sourceFingerprints['.agents/skills/llm-code-wiki/references/schema.md'], undefined);
			const initialization = new WikiInitializationService(vscode.Uri.file(extensionRoot));
			assert.strictEqual(await initialization.needsUpdate(folder), true);
			writeRepoFile(repositoryRoot, 'AGENTS.md', mergeManagedAgentsGuidance(undefined, '# Project Agents\n\nRead the wiki.'));
			assert.strictEqual(await initialization.needsUpdate(folder), false);

			const fresh = await service.assessFreshness(folder);
			assert.strictEqual(fresh.status, 'fresh');
			assert.strictEqual(fresh.totalChangedSourceCount, 0);

			writeRepoFile(repositoryRoot, 'src/app.ts', 'export const value = 2;\n');
			writeRepoFile(repositoryRoot, 'src/new.ts', 'export const next = true;\n');
			const diff = await service.sourceDiff(folder, ready);
			assert.deepStrictEqual(diff.added, ['src/new.ts']);
			assert.deepStrictEqual(diff.modified, ['src/app.ts']);
			const stale = await service.assessFreshness(folder);
			assert.strictEqual(stale.status, 'stale');
			assert.strictEqual(stale.totalChangedSourceCount, 2);
			assert.deepStrictEqual(stale.addedSourcePaths, ['src/new.ts']);
			assert.deepStrictEqual(stale.modifiedSourcePaths, ['src/app.ts']);
			const unknown = await service.assessFreshness(workspaceFolder(path.join(repositoryRoot, 'missing-root')));
			assert.strictEqual(unknown.status, 'unknown');
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
			strategy: 'FileOnly',
			onTrace: (event, context) => trace.push({
				event,
				relativePath: context.relativePath ?? '',
				fileIndex: context.fileIndex ?? 0,
				fileCount: context.fileCount ?? 0,
			}),
		});

		assert.strictEqual(result.findings.length, 2);
		assert.ok(trace.some((item) => item.event.kind === 'llm_request' && item.relativePath === 'src/a.ts' && item.fileIndex === 1 && item.fileCount === 2));
		assert.ok(trace.some((item) => item.event.title === 'Review findings parsed' && item.relativePath === 'src/b.ts'));
	});


	test('runs file review concurrently when file concurrency is zero', async () => {
		const firstUri = vscode.Uri.file('/repo/src/a.ts');
		const secondUri = vscode.Uri.file('/repo/src/b.ts');
		const firstHunk = computeLineDiff(firstUri.toString(), 'a\n', 'aa\n')[0];
		const secondHunk = computeLineDiff(secondUri.toString(), 'b\n', 'bb\n')[0];
		const session: ReviewSession = {
			id: 'ai-review-file-concurrency',
			mode: 'git',
			rootUri: vscode.Uri.file('/repo'),
			createdAt: 1,
			files: new Map([
				[firstUri.toString(), reviewFileState(firstUri, 'src/a.ts', { hunks: [firstHunk] })],
				[secondUri.toString(), reviewFileState(secondUri, 'src/b.ts', { hunks: [secondHunk] })],
			]),
		};
		let activeRequests = 0;
		let maxActiveRequests = 0;
		let firstStarted: (() => void) | undefined;
		const firstStartedPromise = new Promise<void>((resolve) => {
			firstStarted = resolve;
		});

		const result = await new CodeReviewAgentService().review({
			session,
			root: workspaceFolder('/repo'),
			config: { provider: 'openai', baseUrl: 'https://example.test', model: 'test', apiKey: 'secret' },
			client: {
				completeJson: async (request) => {
					const userPrompt = request.messages?.find((message) => message.role === 'user')?.content ?? '';
					if (userPrompt.includes('src/a.ts')) {
						activeRequests += 1;
						maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
						firstStarted?.();
						await new Promise((resolve) => setTimeout(resolve, 25));
						activeRequests -= 1;
						return '{"type":"final","result":{"findings":[{"hunkId":"' + firstHunk.id + '","severity":"warning","title":"A","explanation":"Risk A","recommendation":"Fix A"}]}}';
					}
					await firstStartedPromise;
					activeRequests += 1;
					maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
					activeRequests -= 1;
					return '{"type":"final","result":{"findings":[{"hunkId":"' + secondHunk.id + '","severity":"info","title":"B","explanation":"Risk B","recommendation":"Fix B"}]}}';
				},
			},
			language: 'en',
			strategy: 'FileOnly',
			fileConcurrency: 0,
		});

		assert.strictEqual(maxActiveRequests, 2);
		assert.deepStrictEqual(result.completedFiles, [firstUri.toString(), secondUri.toString()]);
		assert.deepStrictEqual(result.findings.map((finding) => finding.title), ['A', 'B']);
		assert.deepStrictEqual(result.findings.map((finding) => finding.generationOrder), [0, 1]);
	});

	test('runs multi-agent review with skipped KB and integration related hunks', async () => {
		const apiUri = vscode.Uri.file('/repo/src/api.ts');
		const callerUri = vscode.Uri.file('/repo/src/caller.ts');
		const apiHunk = computeLineDiff(apiUri.toString(), 'export const version = 1;\n', 'export const version = 2;\n')[0];
		const callerHunk = computeLineDiff(callerUri.toString(), 'if (version === 1) {\n}\n', 'if (version === 1) {\n  run();\n}\n')[0];
		const session: ReviewSession = {
			id: 'ai-review-multi',
			mode: 'git',
			rootUri: vscode.Uri.file('/repo'),
			createdAt: 1,
			files: new Map([
				[apiUri.toString(), reviewFileState(apiUri, 'src/api.ts', { hunks: [apiHunk] })],
				[callerUri.toString(), reviewFileState(callerUri, 'src/caller.ts', { hunks: [callerHunk] })],
			]),
		};
		const responses = [
			'{"type":"final","result":{"summary":"Plan summary","changeIntent":"Coordinate API and caller","riskAreas":["contract"],"integrationChecks":["caller"],"filePlans":{"src/api.ts":"Check API contract.","src/caller.ts":"Check caller contract."}}}',
			'{"type":"final","result":{"findings":[{"hunkId":"' + apiHunk.id + '","severity":"warning","title":"API issue","explanation":"Risk A","recommendation":"Fix A"}],"suggestions":[]}}',
			'{"type":"final","result":{"findings":[],"suggestions":[]}}',
			'{"type":"final","result":{"findings":[{"hunkId":"' + apiHunk.id + '","relatedHunkIds":["' + callerHunk.id + '","missing","' + apiHunk.id + '"],"relatedPaths":["src/caller.ts"],"severity":"warning","title":"Caller not updated","explanation":"The caller still assumes the old contract.","recommendation":"Update the caller with the API change.","evidence":["src/caller.ts:1"]},{"hunkId":"' + apiHunk.id + '","severity":"warning","title":"API issue","explanation":"Duplicate","recommendation":"Duplicate"}]}}',
		];
		const requests: Array<{ system: string; user: string }> = [];

		const result = await new CodeReviewAgentService().review({
			session,
			root: workspaceFolder('/repo'),
			config: { provider: 'openai', baseUrl: 'https://example.test', model: 'test', apiKey: 'secret' },
			client: {
				completeJson: async (request) => {
					requests.push({
						system: request.messages?.find((message) => message.role === 'system')?.content ?? '',
						user: request.messages?.find((message) => message.role === 'user')?.content ?? '',
					});
					return responses.shift() ?? '{"type":"final","result":{"findings":[]}}';
				},
			},
			language: 'en',
			strategy: 'Multi',
			includeWikiTools: false,
		});

		assert.strictEqual(requests.length, 4);
		assert.ok(requests[0].system.includes('AI Review Planning Agent'));
		assert.ok(requests.every((request) => !request.system.includes('Knowledge Retrieval Agent')));
		assert.ok(requests.some((request) => request.user.includes('Change-set summary:') && request.user.includes('Check API contract.')));
		assert.ok(requests[3].system.includes('Integration Review Agent'));
		assert.strictEqual(result.strategy, 'Multi');
		assert.strictEqual(result.pipeline, 'multi');
		assert.strictEqual(result.completedIntegration, true);
		assert.strictEqual(result.planSummary, 'Plan summary');
		assert.ok(result.knowledgeContextSummary?.includes('KB Retrieval skipped'));
		assert.deepStrictEqual(result.findings.map((finding) => finding.title), ['API issue', 'Caller not updated']);
		const integrationFinding = result.findings.find((finding) => finding.title === 'Caller not updated');
		assert.strictEqual(integrationFinding?.source, 'integration');
		assert.strictEqual(integrationFinding?.uri, apiUri.toString());
		assert.deepStrictEqual(integrationFinding?.relatedHunkIds, [callerHunk.id]);
		assert.deepStrictEqual(integrationFinding?.relatedPaths, ['src/caller.ts']);
	});


	test('retrieves Wiki context with source tools and preserves freshness claims', async () => {
		const firstUri = vscode.Uri.file('/repo/src/api.ts');
		const secondUri = vscode.Uri.file('/repo/src/caller.ts');
		const firstHunk = computeLineDiff(firstUri.toString(), 'old\n', 'new\n')[0];
		const secondHunk = computeLineDiff(secondUri.toString(), 'old\n', 'new\n')[0];
		const session: ReviewSession = {
			id: 'ai-review-knowledge-freshness',
			mode: 'git',
			rootUri: vscode.Uri.file('/repo'),
			createdAt: 1,
			files: new Map([
				[firstUri.toString(), reviewFileState(firstUri, 'src/api.ts', { hunks: [firstHunk] })],
				[secondUri.toString(), reviewFileState(secondUri, 'src/caller.ts', { hunks: [secondHunk] })],
			]),
		};
		const freshness = {
			status: 'stale' as const,
			checkedAt: '2026-07-12T00:00:00.000Z',
			lastSyncedAt: '2026-07-11T00:00:00.000Z',
			addedSourcePaths: [],
			modifiedSourcePaths: ['src/api.ts'],
			deletedSourcePaths: [],
			totalChangedSourceCount: 1,
			reason: 'Source files changed since the last Wiki synchronization.',
		};
		const responses = [
			'{"type":"final","result":{"summary":"KB context","relevantPages":["interfaces.md"],"knowledgeClaims":[{"page":"interfaces.md","claim":"API returns new","status":"confirmed","evidencePaths":["src/api.ts:1"],"confidence":0.9},{"page":"bad","claim":"drop","status":"invalid","evidencePaths":[],"confidence":2}]}}',
			'{"type":"final","result":{"summary":"Plan","filePlans":{"src/api.ts":"Check API.","src/caller.ts":"Check caller."}}}',
			'{"type":"final","result":{"findings":[],"suggestions":[]}}',
			'{"type":"final","result":{"findings":[],"suggestions":[]}}',
			'{"type":"final","result":{"findings":[]}}'
		];
		const requests: Array<{ system: string; user: string; tools: string[] }> = [];
		const result = await new CodeReviewAgentService().review({
			session,
			root: workspaceFolder('/repo'),
			config: { provider: 'openai', baseUrl: 'https://example.test', model: 'test', apiKey: 'secret' },
			client: {
				completeJson: async (request) => {
					requests.push({
						system: request.messages?.find((message) => message.role === 'system')?.content ?? '',
						user: request.messages?.find((message) => message.role === 'user')?.content ?? '',
						tools: (request.tools ?? []).map((tool) => tool.name),
					});
					return responses.shift() ?? '{"type":"final","result":{"findings":[]}}';
				},
			},
			language: 'en',
			strategy: 'Multi',
			includeWikiTools: true,
			knowledgeFreshness: freshness,
		});

		assert.strictEqual(requests.length, 5);
		assert.ok(requests[0].system.includes('Current source code is authoritative'));
		assert.ok(requests[0].system.includes('Use search_wiki_files to locate relevant Wiki pages'));
		assert.ok(requests[0].system.includes('read_workspace_file'));
		assert.ok(requests[0].system.includes('search_workspace'));
		assert.ok(requests[0].system.includes('read_wiki_file'));
		assert.ok(requests[0].system.includes('search_wiki_files'));
		assert.strictEqual(requests[0].system.includes('write_wiki_file'), false);
		assert.ok(requests[0].user.includes('"status":"stale"'));
		assert.ok(requests[4].user.includes('Knowledge claims to verify:'));
		assert.ok(requests[4].user.includes('API returns new'));
		assert.strictEqual(result.knowledgeFreshness?.status, 'stale');
		assert.strictEqual(result.knowledgeClaims?.length, 1);
		assert.strictEqual(result.findings.length, 0);
	});

	test('resumes partial multi-agent review by rerunning only integration', async () => {
		const apiUri = vscode.Uri.file('/repo/src/api.ts');
		const callerUri = vscode.Uri.file('/repo/src/caller.ts');
		const apiHunk = computeLineDiff(apiUri.toString(), 'a\n', 'aa\n')[0];
		const callerHunk = computeLineDiff(callerUri.toString(), 'b\n', 'bb\n')[0];
		const session: ReviewSession = {
			id: 'ai-review-integration-retry',
			mode: 'git',
			rootUri: vscode.Uri.file('/repo'),
			createdAt: 1,
			files: new Map([
				[apiUri.toString(), reviewFileState(apiUri, 'src/api.ts', { hunks: [apiHunk] })],
				[callerUri.toString(), reviewFileState(callerUri, 'src/caller.ts', { hunks: [callerHunk] })],
			]),
		};
		const responses = [
			'{"type":"final","result":{"summary":"Retry plan","filePlans":{"src/api.ts":"Check API.","src/caller.ts":"Check caller."}}}',
			'{"type":"final","result":{"findings":[{"hunkId":"' + apiHunk.id + '","severity":"info","title":"A","explanation":"Risk A","recommendation":"Fix A"}],"suggestions":[]}}',
			'{"type":"final","result":{"findings":[{"hunkId":"' + callerHunk.id + '","severity":"info","title":"B","explanation":"Risk B","recommendation":"Fix B"}],"suggestions":[]}}',
			'{"type":"final","result":{"findings":"bad"}}',
		];
		let partial: StoredAiReview | undefined;
		try {
			await new CodeReviewAgentService().review({
				session,
				root: workspaceFolder('/repo'),
				config: { provider: 'openai', baseUrl: 'https://example.test', model: 'test', apiKey: 'secret' },
				client: { completeJson: async () => responses.shift() ?? '' },
				language: 'en',
				strategy: 'Multi',
			});
			assert.fail('Expected partial integration review failure.');
		} catch (error) {
			assert.ok(error instanceof AiReviewPartialError);
			partial = error.review;
		}

		assert.ok(partial);
		assert.strictEqual(partial.completedIntegration, false);
		assert.deepStrictEqual(partial.completedFiles, [apiUri.toString(), callerUri.toString()]);
		assert.deepStrictEqual(partial.findings.map((finding) => finding.title), ['A', 'B']);

		const retryPrompts: string[] = [];
		const retried = await new CodeReviewAgentService().review({
			session,
			root: workspaceFolder('/repo'),
			config: { provider: 'openai', baseUrl: 'https://example.test', model: 'test', apiKey: 'secret' },
			client: {
				completeJson: async (request) => {
					retryPrompts.push(request.messages?.find((message) => message.role === 'user')?.content ?? '');
					return '{"type":"final","result":{"findings":[{"hunkId":"' + apiHunk.id + '","relatedHunkIds":["' + callerHunk.id + '"],"severity":"warning","title":"Integration","explanation":"Risk","recommendation":"Fix","evidence":["src/api.ts:1"]}]}}';
				},
			},
			language: 'en',
			strategy: 'Multi',
			existingReview: partial,
		});

		assert.deepStrictEqual(retryPrompts.map((prompt) => prompt.startsWith('Run integration review')), [true]);
		assert.strictEqual(retryPrompts.some((prompt) => prompt.includes('Review all pending chunks')), false);
		assert.strictEqual(retried.completedIntegration, true);
		assert.deepStrictEqual(retried.findings.map((finding) => finding.title), ['A', 'B', 'Integration']);
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
				strategy: 'FileOnly',
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
			strategy: 'FileOnly',
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
		const reviewWithLanguage = async (language: 'zh-CN' | 'en', includeWikiTools = false): Promise<string> => {
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
				includeWikiTools,
			});
			return systemPrompt;
		};

		const zhPrompt = await reviewWithLanguage('zh-CN');
		const enPrompt = await reviewWithLanguage('en');
		const wikiPrompt = await reviewWithLanguage('en', true);
		assert.ok(zhPrompt.includes('Simplified Chinese'));
		assert.ok(enPrompt.includes('English'));
		assert.ok(zhPrompt.includes('Do not translate hunkId values'));
		assert.ok(enPrompt.includes('Do not translate hunkId values'));
		assert.ok(enPrompt.includes('Source files are read-only.'));
		assert.strictEqual(enPrompt.includes('optional Wiki context'), false);
		assert.ok(wikiPrompt.includes('Source and Wiki files are read-only.'));
		assert.ok(wikiPrompt.includes('optional Wiki context'));
		assert.ok(enPrompt.includes('Allowed finding severities are error, warning, suggestion, and info'));
		assert.ok(zhPrompt.includes('Keep finding title, explanation, and recommendation concise'));
		assert.ok(enPrompt.includes('valid JSON string content'));
		assert.ok(enPrompt.includes('replacementText replaces the entire current newText'));
		assert.ok(enPrompt.includes('preserve the hunk line terminator'));
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
				completeJson: async () => `{"type":"final","result":{"findings":[],"suggestions":[{"hunkId":"${hunk.id}","replacementText":"better","rationale":"Tighter implementation."}]}}`,
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

	test('sorts findings by chunk position', () => {
		const uri = vscode.Uri.file('/repo/src/app.ts');
		const hunks = computeLineDiff(uri.toString(), 'a\nold\nc\nold2\n', 'a\nnew\nc\nnew2\n');
		const file = reviewFileState(uri, 'src/app.ts', { hunks });
		const findings = validateReviewFindings({
			findings: [
				{ hunkId: hunks[1].id, severity: 'error', title: 'Later', explanation: 'x', recommendation: 'x' },
				{ hunkId: hunks[0].id, severity: 'info', title: 'Earlier', explanation: 'x', recommendation: 'x' },
			],
		}, file);

		assert.deepStrictEqual(sortFindings(findings, [file]).map((item) => item.title), ['Earlier', 'Later']);
	});

	test('keeps review signature stable across review-only transitions and skips Wiki files', async () => {
		const sourceUri = vscode.Uri.file('/repo/src/app.ts');
		const wikiUri = vscode.Uri.file('/repo/.agents/skills/llm-code-wiki/references/overview.md');
		const hunk = computeLineDiff(sourceUri.toString(), 'a\n', 'b\n')[0];
		const source = reviewFileState(sourceUri, 'src/app.ts', { hunks: [hunk] });
		const wiki = reviewFileState(wikiUri, '.agents/skills/llm-code-wiki/references/overview.md', { hunks: computeLineDiff(wikiUri.toString(), 'a\n', 'b\n') });
		const session: ReviewSession = { id: 'x', mode: 'git', rootUri: vscode.Uri.file('/repo'), createdAt: 1, files: new Map([[sourceUri.toString(), source], [wikiUri.toString(), wiki]]) };
		const first = reviewChangeSignature(session);
		const store = new AiReviewStore(new TestMemento() as unknown as vscode.Memento);
		const review: StoredAiReview = {
			signature: first,
			findings: [{
				id: 'finding-1',
				uri: sourceUri.toString(),
				relativePath: 'src/app.ts',
				hunkId: hunk.id,
				line: hunk.newStart,
				severity: 'warning',
				title: 'Bound',
				explanation: 'Risk',
				recommendation: 'Fix',
				evidence: [],
				generationOrder: 0,
			}],
			suggestions: [],
			fileResults: [],
			generatedAt: '2026-06-25T00:00:00.000Z',
			status: 'complete',
			completedFiles: [sourceUri.toString()],
		};
		await store.save(session, review);

		source.revision += 1;
		assert.strictEqual(reviewChangeSignature(session), first);
		assert.strictEqual(store.load(session)?.findings[0].title, 'Bound');

		source.hunks = [];
		source.acceptedHunks = [reviewedHunkFrom(hunk, 'accept')];
		source.revision += 1;
		assert.strictEqual(reviewChangeSignature(session), first);
		assert.strictEqual(store.load(session)?.findings[0].title, 'Bound');

		source.hunks = [hunk];
		source.acceptedHunks = [];
		source.revision += 1;
		assert.strictEqual(reviewChangeSignature(session), first);
		assert.strictEqual(store.load(session)?.findings[0].title, 'Bound');

		wiki.revision += 1;
		assert.strictEqual(reviewChangeSignature(session), first);

		source.hunks = [{ ...hunk, newText: 'changed\n' }];
		assert.notStrictEqual(reviewChangeSignature(session), first);
		assert.strictEqual(store.load(session), undefined);
	});

	test('keeps AI review and stable chunk identities when Reject shifts later hunks', () => {
		const uri = vscode.Uri.file('/repo/src/shifted.ts');
		const baseline = 'one\nkeep-a\nkeep-b\nkeep-c\nold-two\n';
		const working = 'ONE\nkeep-a\nkeep-b\nkeep-c\nTWO\n';
		const hunks = computeLineDiff(uri.toString(), baseline, working);
		assert.strictEqual(hunks.length, 2);
		const previous = reviewFileState(uri, 'src/shifted.ts', { hunks });
		const beforeSession: ReviewSession = {
			id: 'before-reject',
			mode: 'git',
			rootUri: vscode.Uri.file('/repo'),
			createdAt: 1,
			files: new Map([[uri.toString(), previous]]),
		};
		const signature = reviewChangeSignature(beforeSession);
		const shiftedSecond = {
			...hunks[1],
			id: 'regenerated-second',
			newStart: Math.max(0, hunks[1].newStart - 1),
		};
		const rejectedFirst = {
			...reviewedHunkFrom(hunks[0], 'reject'),
			id: 'reject-record',
			sourceHunkId: hunks[0].id,
			reviewItemId: hunks[0].id,
		};
		const current = reviewFileState(uri, 'src/shifted.ts', {
			hunks: [shiftedSecond],
			rejectedHunks: [rejectedFirst],
		});
		const afterSession: ReviewSession = { ...beforeSession, id: 'after-reject', files: new Map([[uri.toString(), current]]) };
		assert.strictEqual(reviewChangeSignature(afterSession), signature);
		const controller = Object.create(ReviewController.prototype) as any;
		controller.restoreStableReviewItemIdentities(current, previous);
		assert.strictEqual(current.hunks[0].sourceHunkId, hunks[1].id);
		assert.strictEqual(current.hunks[0].reviewItemId, hunks[1].id);
		const payload = buildReviewDashboardPayload(afterSession, uri, () => false, {
			...defaultLlmWikiDashboardState(),
			reviewFindings: [aiReviewFinding(uri, 'src/shifted.ts', hunks[1], 'shifted-finding', 0)],
		});
		const shiftedChunk = payload.files[0].chunks.find((chunk) => chunk.hunkId === shiftedSecond.id);
		assert.strictEqual(shiftedChunk?.findings[0].title, 'Finding');
	});

	test('maps a suggestion split by Git into one logical chunk using file-state validation', () => {
		const uri = vscode.Uri.file('/repo/src/split.ts');
		const middle = Array.from({ length: 8 }, (_, index) => `old-${index}\n`);
		const baseline = ['head\n', 'old-top\n', ...middle, 'old-bottom\n', 'tail\n'].join('');
		const before = ['head\n', 'new-top\n', ...middle.map((_, index) => `changed-${index}\n`), 'new-bottom\n', 'tail\n'].join('');
		const after = ['head\n', 'new-top\n', ...middle, 'new-bottom\n', 'tail\n'].join('');
		const original = computeLineDiff(uri.toString(), baseline, before)[0];
		const members = computeLineDiff(uri.toString(), baseline, after).map((hunk, index): GitReviewHunk => ({
			...hunk,
			layer: 'pending',
			patch: `patch-${index}`,
			fingerprint: `fingerprint-${index}`,
			projectId: 'project',
			occurrence: 0,
		}));
		assert.strictEqual(members.length, 2);
		const file = reviewFileState(uri, 'src/split.ts', {
			oldText: baseline,
			newText: after,
			hunks: members,
			gitSnapshot: {
				headText: baseline,
				indexText: baseline,
				workingText: after,
				headExists: true,
				indexExists: true,
				workingExists: true,
			},
		});
		const controller = Object.create(ReviewController.prototype) as any;
		Object.assign(controller, { gitService: new GitService() });
		const resolution = controller.findRegeneratedSuggestionHunks(file, original, [], before) as {
			ok: boolean;
			members?: GitReviewHunk[];
			undoText?: string;
		};
		assert.strictEqual(resolution.ok, true);
		assert.ok(resolution.members);
		assert.strictEqual(resolution.members.length, 2);
		assert.strictEqual(resolution.undoText, before);
		const logical = controller.createLogicalSuggestionHunk(file, original, resolution.members, original.id) as GitReviewHunk;
		assert.strictEqual(logical.memberHunks?.length, 2);
		assert.strictEqual(logical.reviewItemId, original.id);
		assert.ok(logical.id.startsWith('suggestion-'));
	});

	test('reports structured AI suggestion mapping failure reasons without source text', () => {
		const uri = vscode.Uri.file('/repo/src/diagnostic.ts');
		const baseline = 'old-secret\n';
		const before = 'pending-secret\n';
		const after = 'suggested-secret\n';
		const original = computeLineDiff(uri.toString(), baseline, before)[0];
		const candidateBase = computeLineDiff(uri.toString(), baseline, after)[0];
		const candidate = {
			...candidateBase,
			layer: 'pending',
			patch: 'patch-a',
			fingerprint: 'candidate-a',
			projectId: 'project',
			occurrence: 0,
		} as GitReviewHunk;
		const controller = Object.create(ReviewController.prototype) as any;

		const noCandidateFile = reviewFileState(uri, 'src/diagnostic.ts', { oldText: baseline, newText: after, hunks: [] });
		const noCandidate = controller.findRegeneratedSuggestionHunks(noCandidateFile, original, [], before);
		assert.strictEqual(noCandidate.ok, false);
		assert.strictEqual(noCandidate.reason, 'no-candidate');
		assert.strictEqual(noCandidate.diagnostics.candidateCount, 0);
		assert.strictEqual(noCandidate.diagnostics.regeneratedHunkCount, 0);
		assert.strictEqual(noCandidate.diagnostics.referenceCompared, true);
		assert.strictEqual(noCandidate.diagnostics.matchesExpectedReference, false);
		assert.strictEqual(noCandidate.diagnostics.resolvedToIndex, false);

		const resolvedFile = reviewFileState(uri, 'src/diagnostic.ts', { oldText: baseline, newText: baseline, hunks: [] });
		const resolved = controller.findRegeneratedSuggestionHunks(resolvedFile, original, [], before);
		assert.strictEqual(resolved.ok, true);
		assert.strictEqual(resolved.effect, 'resolved-to-index');
		assert.deepStrictEqual(resolved.members, []);
		assert.strictEqual(resolved.undoText, before);

		const outsideCandidate = {
			...candidate,
			id: 'outside-candidate',
			oldStart: candidate.oldStart + 10,
			newStart: candidate.newStart + 10,
		};
		const outsideFile = reviewFileState(uri, 'src/diagnostic.ts', { oldText: baseline, newText: after, hunks: [outsideCandidate] });
		const outside = controller.findRegeneratedSuggestionHunks(outsideFile, original, [], before);
		assert.strictEqual(outside.ok, false);
		assert.strictEqual(outside.reason, 'no-candidate');
		assert.strictEqual(outside.diagnostics.regeneratedHunkCount, 1);
		assert.strictEqual(outside.diagnostics.outsideScopeCandidateCount, 1);
		assert.strictEqual(outside.diagnostics.regeneratedHunks[0].disposition, 'outside-target-scope');

		const preservedFile = reviewFileState(uri, 'src/diagnostic.ts', { oldText: baseline, newText: after, hunks: [candidate] });
		const preserved = controller.findRegeneratedSuggestionHunks(preservedFile, original, [candidate], before);
		assert.strictEqual(preserved.ok, false);
		assert.strictEqual(preserved.reason, 'no-candidate');
		assert.strictEqual(preserved.diagnostics.preservedOtherHunkCount, 1);
		assert.strictEqual(preserved.diagnostics.regeneratedHunks[0].disposition, 'preserved-other');

		const overlapFile = reviewFileState(uri, 'src/diagnostic.ts', { oldText: baseline, newText: after, hunks: [candidate] });
		const overlap = controller.findRegeneratedSuggestionHunks(overlapFile, original, [original], before);
		assert.strictEqual(overlap.ok, false);
		assert.strictEqual(overlap.reason, 'other-hunk-overlap');
		assert.ok(overlap.diagnostics.overlappingGroupCount > 0);

		const duplicate = { ...candidate, id: 'candidate-b', patch: 'patch-b', fingerprint: 'candidate-b' };
		const ambiguousFile = reviewFileState(uri, 'src/diagnostic.ts', { oldText: baseline, newText: after, hunks: [candidate, duplicate] });
		const ambiguous = controller.findRegeneratedSuggestionHunks(ambiguousFile, original, [], before);
		assert.strictEqual(ambiguous.ok, false);
		assert.strictEqual(ambiguous.reason, 'ambiguous');
		assert.strictEqual(ambiguous.diagnostics.validGroupCount, 3);
		assert.strictEqual(ambiguous.diagnostics.regeneratedHunkCount, 2);
		assert.ok(ambiguous.diagnostics.regeneratedHunks.every((hunk: { disposition: string }) => hunk.disposition === 'candidate'));
		const serialized = JSON.stringify(ambiguous.diagnostics);
		assert.strictEqual(serialized.includes('old-secret'), false);
		assert.strictEqual(serialized.includes('pending-secret'), false);
		assert.strictEqual(serialized.includes('suggested-secret'), false);

		const multiBaseline = 'target-old-a\ntarget-old-b\nkeep-1\nkeep-2\nkeep-3\nother-old\n';
		const multiBefore = 'target-pending-a\ntarget-pending-b\nkeep-1\nkeep-2\nkeep-3\nother-pending\n';
		const [targetOriginal, otherOriginal] = computeLineDiff(uri.toString(), multiBaseline, multiBefore);
		const partialCandidateBase = computeLineDiff(
			uri.toString(),
			multiBaseline,
			'target-suggested-a\ntarget-old-b\nkeep-1\nkeep-2\nkeep-3\nother-old\n',
		)[0];
		const partialCandidate = {
			...partialCandidateBase,
			layer: 'pending',
			patch: 'partial-patch',
			fingerprint: 'partial-candidate',
			projectId: 'project',
		} as GitReviewHunk;
		const targetResidualFile = reviewFileState(uri, 'src/diagnostic.ts', {
			oldText: multiBaseline,
			newText: 'target-suggested-a\ntarget-suggested-b\nkeep-1\nkeep-2\nkeep-3\nother-pending\n',
			hunks: [partialCandidate],
		});
		const targetResidual = controller.findRegeneratedSuggestionHunks(targetResidualFile, targetOriginal, [], multiBefore);
		assert.strictEqual(targetResidual.ok, false);
		assert.strictEqual(targetResidual.reason, 'target-residual');

		const fullCandidateBase = computeLineDiff(
			uri.toString(),
			multiBaseline,
			'target-suggested-a\ntarget-suggested-b\nkeep-1\nkeep-2\nkeep-3\nother-old\n',
		)[0];
		const fullCandidate = {
			...fullCandidateBase,
			layer: 'pending',
			patch: 'full-patch',
			fingerprint: 'full-candidate',
			projectId: 'project',
		} as GitReviewHunk;
		const otherResidualFile = reviewFileState(uri, 'src/diagnostic.ts', {
			oldText: multiBaseline,
			newText: 'target-suggested-a\ntarget-suggested-b\nkeep-1\nkeep-2\nkeep-3\nother-formatted\n',
			hunks: [fullCandidate],
		});
		const otherResidual = controller.findRegeneratedSuggestionHunks(otherResidualFile, targetOriginal, [otherOriginal], multiBefore);
		assert.strictEqual(otherResidual.ok, false);
		assert.strictEqual(otherResidual.reason, 'other-hunk-residual');
	});

	test('keeps AI suggestions loadable after undoing an accepted AI suggestion chunk', async () => {
		const sourceUri = vscode.Uri.file('/repo/src/app.ts');
		const originalHunk = computeLineDiff(sourceUri.toString(), 'old\n', 'new\n')[0];
		const appliedHunk = { ...originalHunk, newText: 'suggested\n' };
		const appliedSuggestion = {
			suggestionId: 'suggestion-1',
			sourceHunkId: originalHunk.id,
			currentHunkId: originalHunk.id,
			originalHunk,
			replacementText: 'suggested\n',
			appliedHunk,
			appliedAt: 1,
		};
		const acceptedAppliedHunk: ReviewedHunk = {
			...reviewedHunkFrom(appliedHunk, 'accept'),
			id: `accept-1-${originalHunk.id}`,
			appliedAiSuggestion: appliedSuggestion,
		};
		const source = reviewFileState(sourceUri, 'src/app.ts', { hunks: [], acceptedHunks: [acceptedAppliedHunk] });
		const session: ReviewSession = { id: 'accepted-ai-suggestion-undo', mode: 'git', rootUri: vscode.Uri.file('/repo'), createdAt: 1, files: new Map([[sourceUri.toString(), source]]) };
		const store = new AiReviewStore(new TestMemento() as unknown as vscode.Memento);
		const appliedSignature = reviewChangeSignature(session);
		const review: StoredAiReview = {
			signature: appliedSignature,
			findings: [],
			suggestions: [{
				id: 'suggestion-1',
				uri: sourceUri.toString(),
				relativePath: 'src/app.ts',
				hunkId: originalHunk.id,
				line: originalHunk.newStart,
				replacementText: 'suggested\n',
				rationale: 'Prefer suggested code.',
				generationOrder: 0,
			}],
			fileResults: [],
			generatedAt: '2026-06-25T00:00:00.000Z',
			status: 'complete',
			completedFiles: [sourceUri.toString()],
		};
		await store.save(session, review);
		assert.strictEqual(store.load(session)?.suggestions[0].id, 'suggestion-1');

		source.acceptedHunks = [];
		source.hunks = [appliedHunk];
		const restoredSignature = reviewChangeSignature(session);
		assert.strictEqual(restoredSignature, appliedSignature);
		assert.strictEqual(store.load(session)?.suggestions[0].id, 'suggestion-1');
	});

	test('file-level undo keeps accepted AI suggestion text as pending', async () => {
		const sourceUri = vscode.Uri.file('/repo/src/app.ts');
		const originalHunk = computeLineDiff(sourceUri.toString(), 'old\n', 'new\n')[0];
		const appliedHunk = { ...originalHunk, newText: 'suggested\n' };
		const appliedSuggestion = {
			suggestionId: 'suggestion-1',
			sourceHunkId: originalHunk.id,
			currentHunkId: originalHunk.id,
			originalHunk,
			replacementText: 'suggested\n',
			appliedHunk,
			appliedAt: 1,
		};
		const acceptedAppliedHunk: ReviewedHunk = {
			...reviewedHunkFrom(appliedHunk, 'accept'),
			id: `accept-1-${originalHunk.id}`,
			appliedAiSuggestion: appliedSuggestion,
		};
		const source = reviewFileState(sourceUri, 'src/app.ts', {
			oldText: 'suggested\n',
			newText: 'suggested\n',
			hunks: [],
			acceptedHunks: [acceptedAppliedHunk],
			originalText: 'old\n',
		});
		const session: ReviewSession = { id: 'file-ai-suggestion-undo', mode: 'git', rootUri: vscode.Uri.file('/repo'), createdAt: 1, files: new Map([[sourceUri.toString(), source]]) };
		const store = new AiReviewStore(new TestMemento() as unknown as vscode.Memento);
		const appliedSignature = reviewChangeSignature(session);
		await store.save(session, storedAiReview({
			signature: appliedSignature,
			suggestions: [{
				id: 'suggestion-1',
				uri: sourceUri.toString(),
				relativePath: 'src/app.ts',
				hunkId: originalHunk.id,
				line: originalHunk.newStart,
				replacementText: 'suggested\n',
				rationale: 'Prefer suggested code.',
				generationOrder: 0,
			}],
			completedFiles: [sourceUri.toString()],
		}));
		const harness = reviewControllerHarness(session, 'suggested\n', store);

		await harness.controller.undoFileCore(source);

		assert.strictEqual(source.acceptedHunks.length, 0);
		assert.strictEqual(source.oldText, 'old\n');
		assert.strictEqual(source.newText, 'suggested\n');
		assert.strictEqual(harness.currentText(), 'suggested\n');
		assert.deepStrictEqual(harness.writes, []);
		assert.strictEqual(source.hunks.length, 0);
		assert.strictEqual(store.load(session)?.suggestions[0].id, 'suggestion-1');
	});

	test('file-level undo keeps accepted AI suggestion while restoring rejected chunks', async () => {
		const sourceUri = vscode.Uri.file('/repo/src/mixed.ts');
		const baseline = 'old\nsame\nreject-old\n';
		const pending = 'new\nsame\nreject-new\n';
		const [originalHunk, rejectedOriginalHunk] = computeLineDiff(sourceUri.toString(), baseline, pending);
		assert.ok(originalHunk);
		assert.ok(rejectedOriginalHunk);
		const suggestionText = 'suggested-a\nsuggested-b\n';
		const appliedHunk = {
			...originalHunk,
			newLines: 2,
			newText: suggestionText,
		};
		const appliedSuggestion = {
			suggestionId: 'suggestion-1',
			sourceHunkId: originalHunk.id,
			currentHunkId: originalHunk.id,
			originalHunk,
			replacementText: suggestionText,
			appliedHunk,
			appliedAt: 1,
		};
		const acceptedAppliedHunk: ReviewedHunk = {
			...reviewedHunkFrom(appliedHunk, 'accept'),
			id: `accept-1-${originalHunk.id}`,
			appliedAiSuggestion: appliedSuggestion,
		};
		const rejectedHunk: ReviewedHunk = {
			...reviewedHunkFrom(rejectedOriginalHunk, 'reject'),
			currentStart: rejectedOriginalHunk.newStart + 1,
		};
		const reviewedText = 'suggested-a\nsuggested-b\nsame\nreject-old\n';
		const source = reviewFileState(sourceUri, 'src/mixed.ts', {
			oldText: reviewedText,
			newText: reviewedText,
			hunks: [],
			acceptedHunks: [acceptedAppliedHunk],
			rejectedHunks: [rejectedHunk],
			originalText: baseline,
		});
		const session: ReviewSession = { id: 'file-mixed-ai-suggestion-undo', mode: 'git', rootUri: vscode.Uri.file('/repo'), createdAt: 1, files: new Map([[sourceUri.toString(), source]]) };
		const harness = reviewControllerHarness(session, reviewedText);

		await harness.controller.undoFileCore(source);

		assert.strictEqual(source.acceptedHunks.length, 0);
		assert.strictEqual(source.rejectedHunks.length, 0);
		assert.strictEqual(source.oldText, baseline);
		const restored = 'suggested-a\nsuggested-b\nsame\nreject-new\n';
		assert.strictEqual(source.newText, restored);
		assert.strictEqual(harness.currentText(), restored);
		assert.deepStrictEqual(harness.writes, [restored]);
		assert.strictEqual(source.hunks.length, 0);
	});
});

suite('Git patch parser', () => {
	test('parses multiple hunks and preserves directly applicable patch text', () => {
		const patch = [
			'diff --git a/src/demo.txt b/src/demo.txt\n',
			'index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644\n',
			'--- a/src/demo.txt\n',
			'+++ b/src/demo.txt\n',
			'@@ -1,3 +1,3 @@\n',
			' one\n',
			'-old\n',
			'+new\n',
			' three\n',
			'@@ -10 +10 @@\n',
			'-tail\n',
			'\\ No newline at end of file\n',
			'+TAIL\n',
			'\\ No newline at end of file\n',
		].join('');
		const [file] = parseGitPatch(patch, 'project', 'pending');
		assert.strictEqual(file.relativePath, 'src/demo.txt');
		assert.strictEqual(file.oldOid, '1111111111111111111111111111111111111111');
		assert.strictEqual(file.newOid, '2222222222222222222222222222222222222222');
		assert.strictEqual(file.hunks.length, 2);
		assert.strictEqual(file.hunks[0].oldText, 'old\n');
		assert.strictEqual(file.hunks[0].newText, 'new\n');
		assert.strictEqual(file.hunks[1].oldText, 'tail');
		assert.strictEqual(file.hunks[1].newText, 'TAIL');
		assert.strictEqual(combineGitHunkPatches(file.hunks), patch);
	});

	test('parses length-delimited cat-file batches without splitting blob contents', () => {
		const firstOid = '1'.repeat(40);
		const secondOid = '2'.repeat(40);
		const first = Buffer.from('line one\nline two\n');
		const second = Buffer.from('content that looks like a header\n123 blob 9\n');
		const output = Buffer.concat([
			Buffer.from(`${firstOid} blob ${first.length}\n`), first, Buffer.from('\n'),
			Buffer.from(`${secondOid} blob ${second.length}\n`), second, Buffer.from('\n'),
		]);
		const blobs = parseCatFileBatch(output);
		assert.strictEqual(blobs.get(firstOid)?.toString('utf8'), first.toString('utf8'));
		assert.strictEqual(blobs.get(secondOid)?.toString('utf8'), second.toString('utf8'));
	});

	test('decodes Git C-style quoted UTF-8 paths', () => {
		assert.strictEqual(decodeGitPath('"b/\\346\\265\\213\\350\\257\\225 file.txt"'), '测试 file.txt');
	});

	test('marks binary and mode-only file patches unsupported', () => {
		const binary = parseGitPatch('diff --git a/a.bin b/a.bin\nGIT binary patch\nliteral 1\nA\n', 'project', 'pending')[0];
		const mode = parseGitPatch('diff --git a/run script.sh b/run script.sh\nold mode 100644\nnew mode 100755\n', 'project', 'pending')[0];
		assert.match(binary.unsupportedReason ?? '', /binary/);
		assert.match(mode.unsupportedReason ?? '', /mode or metadata/);
		assert.strictEqual(mode.relativePath, 'run script.sh');
	});
});

suite('Git service', () => {
	test('discovers the workspace Git root or direct child Git projects only', async function (this: Mocha.Context) {
		this.timeout(30000);
		const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-projects-'));
		try {
			const api = path.join(parent, 'api');
			const web = path.join(parent, 'web');
			const nested = path.join(api, 'nested');
			const ordinary = path.join(parent, 'notes');
			for (const folder of [api, web, nested, ordinary]) {
				fs.mkdirSync(folder, { recursive: true });
			}
			git(api, 'init');
			git(web, 'init');
			git(nested, 'init');

			const service = new GitService();
			const childProjects = await service.discoverProjects(workspaceFolder(parent));
			assert.deepStrictEqual(childProjects.map((project) => project.name), ['api', 'web']);

			git(parent, 'init');
			const rootProjects = await service.discoverProjects(workspaceFolder(parent));
			assert.strictEqual(rootProjects.length, 1);
			assert.strictEqual(rootProjects[0].rootUri.fsPath, vscode.Uri.file(parent).fsPath);
		} finally {
			removeTempRepo(parent);
		}
	});

	test('uses a staged hunk as the new baseline and keeps only remaining working changes', async function (this: Mocha.Context) {
		this.timeout(30000);
		const root = createTempGitRepo();
		try {
			writeRepoFile(root, 'tracked.txt', 'one\nold-a\nmiddle-1\nmiddle-2\nmiddle-3\nmiddle-4\nmiddle-5\nmiddle-6\nmiddle-7\nold-b\nend\n');
			git(root, 'add', 'tracked.txt');
			git(root, 'commit', '-m', 'initial');
			writeRepoFile(root, 'tracked.txt', 'one\nnew-a\nmiddle-1\nmiddle-2\nmiddle-3\nmiddle-4\nmiddle-5\nmiddle-6\nmiddle-7\nnew-b\nend\n');
			const service = new GitService();
			const folder = workspaceFolder(root);
			const pair = (await service.createFilePairs(folder))[0];
			assert.strictEqual(pair.pendingHunks?.length, 2);
			const first = pair.pendingHunks?.[0];
			assert.ok(first);
			await service.applyPatch(folder, first.patch, { cached: true, check: true });
			await service.applyPatch(folder, first.patch, { cached: true });
			let refreshed = (await service.createFilePairs(folder))[0];
			assert.strictEqual(refreshed.pendingHunks?.length, 1);
			assert.match(refreshed.oldText, /new-a/);
			await service.applyPatch(folder, first.patch, { cached: true, reverse: true, check: true });
			await service.applyPatch(folder, first.patch, { cached: true, reverse: true });
			refreshed = (await service.createFilePairs(folder))[0];
			assert.strictEqual(refreshed.pendingHunks?.length, 2);
		} finally {
			removeTempRepo(root);
		}
	});

	test('rejects and restores an untracked file with a reversible Git patch', async function (this: Mocha.Context) {
		this.timeout(30000);
		const root = createTempGitRepo();
		try {
			writeRepoFile(root, 'tracked.txt', 'base\n');
			git(root, 'add', 'tracked.txt');
			git(root, 'commit', '-m', 'initial');
			writeRepoFile(root, 'new file.txt', 'new\n');
			const service = new GitService();
			const folder = workspaceFolder(root);
			const pair = filePairsByPath(await service.createFilePairs(folder)).get('new file.txt');
			const hunk = pair?.pendingHunks?.[0];
			assert.ok(hunk);
			await service.applyPatch(folder, hunk.patch, { reverse: true, check: true });
			await service.applyPatch(folder, hunk.patch, { reverse: true });
			assert.strictEqual(fs.existsSync(path.join(root, 'new file.txt')), false);
			await service.applyPatch(folder, hunk.patch, { check: true });
			await service.applyPatch(folder, hunk.patch);
			assert.strictEqual(fs.readFileSync(path.join(root, 'new file.txt'), 'utf8'), 'new\n');
		} finally {
			removeTempRepo(root);
		}
	});

	test('reviews untracked files larger than the former file-size limit', async function (this: Mocha.Context) {
		this.timeout(30000);
		const root = createTempGitRepo();
		try {
			writeRepoFile(root, 'tracked.txt', 'base\n');
			git(root, 'add', 'tracked.txt');
			git(root, 'commit', '-m', 'initial');
			const contents = `${'x'.repeat(2_200_000)}\n`;
			writeRepoFile(root, 'large.txt', contents);

			const service = new GitService();
			const pair = filePairsByPath(await service.createFilePairs(workspaceFolder(root))).get('large.txt');
			assert.ok(pair);
			assert.strictEqual(pair.skippedReason, undefined);
			assert.strictEqual(pair.newText, contents);
			assert.strictEqual(pair.pendingHunks?.length, 1);
		} finally {
			removeTempRepo(root);
		}
	});

	test('rejects an added block by removing it from the working file', async function (this: Mocha.Context) {
		this.timeout(30000);
		const root = createTempGitRepo();
		try {
			writeRepoFile(root, 'tracked.txt', 'base\n');
			git(root, 'add', 'tracked.txt');
			git(root, 'commit', '-m', 'initial');
			writeRepoFile(root, 'tracked.txt', 'base\nadded\n');
			const service = new GitService();
			const folder = workspaceFolder(root);
			const pair = await service.createFilePairForUri(vscode.Uri.file(path.join(root, 'tracked.txt')), folder);
			const added = pair?.pendingHunks?.find((hunk) => hunk.kind === 'add');
			assert.ok(added);
			await service.applyPatch(folder, added.patch, { reverse: true, check: true });
			await service.applyPatch(folder, added.patch, { reverse: true });
			assert.strictEqual(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'base\n');
			assert.strictEqual(await service.createFilePairForUri(vscode.Uri.file(path.join(root, 'tracked.txt')), folder), undefined);
		} finally {
			removeTempRepo(root);
		}
	});

	test('uses the index as the Git review baseline', async function (this: Mocha.Context) {
		this.timeout(30000);
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
			assert.strictEqual(byPath.get('tracked.txt')?.gitSnapshot?.indexText, 'base\nwork\n');
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
			writeRepoFile(root, '.agents/skills/llm-code-wiki/SKILL.md', '# Skill\n');
			writeRepoFile(root, '.agents/skills/llm-code-wiki/references/overview.md', '# Overview\n');
			writeRepoFile(root, '.agents/skills/llm-code-wiki/.state.json', '{}\n');
			writeRepoFile(root, '.agents/skills/other-skill/SKILL.md', '# Other\n');
			writeRepoFile(root, '.skills/llm-code-wiki/SKILL.md', '# Old Skill\n');
			pairs = await service.createFilePairs(folder);
			byPath = filePairsByPath(pairs);
			assert.strictEqual(byPath.has('.env'), true);
			assert.strictEqual(byPath.has('.cache/output.txt'), true);
			assert.strictEqual(byPath.has('.gitignore'), true);
			assert.strictEqual(byPath.has('ignored.txt'), false);
			assert.strictEqual(byPath.has('.agents/skills/llm-code-wiki/SKILL.md'), true);
			assert.strictEqual(byPath.has('.agents/skills/llm-code-wiki/references/overview.md'), true);
			assert.strictEqual(byPath.has('.agents/skills/llm-code-wiki/.state.json'), true);
			assert.strictEqual(byPath.has('.agents/skills/other-skill/SKILL.md'), true);
			assert.strictEqual(byPath.has('.skills/llm-code-wiki/SKILL.md'), true);
		} finally {
			removeTempRepo(root);
		}
	});

	test('stages accepted-only index text for tracked files with remaining pending work', async function (this: Mocha.Context) {
		this.timeout(10000);
		const root = createTempGitRepo();
		try {
			writeRepoFile(root, 'tracked.txt', 'old\npending-old\n');
			git(root, 'add', 'tracked.txt');
			git(root, 'commit', '-m', 'initial');
			writeRepoFile(root, 'tracked.txt', 'accepted\npending-new\n');

			const service = new GitService();
			const folder = workspaceFolder(root);
			const entry = await service.readIndexEntry(folder, 'tracked.txt');
			assert.strictEqual(entry.exists, true);

			await service.stageIndexText(folder, 'tracked.txt', 'accepted\npending-old\n', entry.mode, false);

			const pairs = await service.createFilePairs(folder);
			const byPath = filePairsByPath(pairs);
			assert.strictEqual(byPath.get('tracked.txt')?.oldText, 'accepted\npending-old\n');
			assert.strictEqual(byPath.get('tracked.txt')?.gitSnapshot?.indexText, 'accepted\npending-old\n');
			assert.strictEqual(byPath.get('tracked.txt')?.newText, 'accepted\npending-new\n');
			assert.strictEqual(byPath.get('tracked.txt')?.pendingHunks?.length, 1);
		} finally {
			removeTempRepo(root);
		}
	});

	test('stages complete files with git add', async function (this: Mocha.Context) {
		this.timeout(10000);
		const root = createTempGitRepo();
		try {
			writeRepoFile(root, 'tracked.txt', 'old\n');
			git(root, 'add', 'tracked.txt');
			git(root, 'commit', '-m', 'initial');
			writeRepoFile(root, 'tracked.txt', 'accepted\n');

			const service = new GitService();
			const folder = workspaceFolder(root);
			await service.stageFile(folder, 'tracked.txt');

			const pairs = await service.createFilePairs(folder);
			assert.strictEqual(filePairsByPath(pairs).has('tracked.txt'), false);
		} finally {
			removeTempRepo(root);
		}
	});

	test('stages accepted-only index text for untracked files with remaining pending work', async function (this: Mocha.Context) {
		this.timeout(10000);
		const root = createTempGitRepo();
		try {
			writeRepoFile(root, 'tracked.txt', 'base\n');
			git(root, 'add', 'tracked.txt');
			git(root, 'commit', '-m', 'initial');
			writeRepoFile(root, 'loose.txt', 'accepted\npending\n');

			const service = new GitService();
			const folder = workspaceFolder(root);
			await service.stageIndexText(folder, 'loose.txt', 'accepted\n', '100644', true);

			const pairs = await service.createFilePairs(folder);
			const byPath = filePairsByPath(pairs);
			assert.strictEqual(byPath.get('loose.txt')?.oldText, 'accepted\n');
			assert.strictEqual(byPath.get('loose.txt')?.gitSnapshot?.indexText, 'accepted\n');
			assert.strictEqual(byPath.get('loose.txt')?.newText, 'accepted\npending\n');
			assert.strictEqual(byPath.get('loose.txt')?.baselineExists, true);
			assert.strictEqual(byPath.get('loose.txt')?.gitSnapshot?.indexExists, true);
		} finally {
			removeTempRepo(root);
		}
	});

	test('changes the index signature only for index or HEAD changes', async function (this: Mocha.Context) {
		this.timeout(30000);
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

suite('Project Agent run store', () => {
	test('persists the latest complete run independently by project root', async () => {
		const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-agent-runs-'));
		try {
			const context = { storageUri: vscode.Uri.file(storage), globalStorageUri: vscode.Uri.file(storage) } as vscode.ExtensionContext;
			const store = new AgentRunStore(context);
			const rootA = vscode.Uri.file(path.join(storage, 'project-a'));
			const rootB = vscode.Uri.file(path.join(storage, 'project-b'));
			const run = (rootUri: vscode.Uri, runId: string, progress: string, sequence: number): StoredProjectAgentRun => ({
				version: 1,
				runId,
				projectId: rootUri.toString(),
				rootUri: rootUri.toString(),
				kind: 'review',
				source: 'review',
				lifecycle: sequence > 1 ? 'completed' : 'running',
				startedAt: '2026-07-24T00:00:00.000Z',
				updatedAt: '2026-07-24T00:00:01.000Z',
				completedAt: sequence > 1 ? '2026-07-24T00:00:01.000Z' : undefined,
				progress,
				sequence,
				entries: Array.from({ length: sequence }, (_, index) => ({
					id: `${runId}-${index + 1}`,
					sequence: index + 1,
					timestamp: '2026-07-24T00:00:01.000Z',
					source: 'review',
					kind: index === 0 ? 'run_start' : 'run_complete',
					title: index === 0 ? 'Started' : 'Completed',
					summary: progress,
					status: index === 0 ? 'running' : 'success',
					details: [],
				})),
			});

			const firstA = run(rootA, 'run-a', 'first snapshot', 1);
			const finalA = run(rootA, 'run-a', 'completed A', 2);
			await Promise.all([
				store.save(firstA),
				store.save(finalA),
				store.save(run(rootB, 'run-b', 'running B', 1)),
			]);

			const restarted = new AgentRunStore(context);
			assert.strictEqual((await restarted.load(rootA))?.progress, 'completed A');
			assert.strictEqual((await restarted.load(rootA))?.entries.length, 2);
			assert.strictEqual((await restarted.load(rootB))?.progress, 'running B');
		} finally {
			fs.rmSync(storage, { recursive: true, force: true });
		}
	});

	test('ignores corrupt persisted Agent runs', async () => {
		const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-agent-run-corrupt-'));
		try {
			const context = { storageUri: vscode.Uri.file(storage), globalStorageUri: vscode.Uri.file(storage) } as vscode.ExtensionContext;
			const store = new AgentRunStore(context);
			const root = vscode.Uri.file(path.join(storage, 'project'));
			await store.save({
				version: 1,
				runId: 'run',
				rootUri: root.toString(),
				kind: 'initialize',
				source: 'wiki',
				lifecycle: 'running',
				startedAt: '2026-07-24T00:00:00.000Z',
				updatedAt: '2026-07-24T00:00:00.000Z',
				sequence: 0,
				entries: [],
			});
			const directory = path.join(storage, 'agent-runs');
			const file = fs.readdirSync(directory).find((entry) => entry.endsWith('.json'));
			assert.ok(file);
			fs.writeFileSync(path.join(directory, file), '{broken', 'utf8');
			assert.strictEqual(await new AgentRunStore(context).load(root), undefined);
		} finally {
			fs.rmSync(storage, { recursive: true, force: true });
		}
	});
});

suite('Git review journal', () => {
	test('recovers applied rejects after restart and invalidates them on HEAD change', async function (this: Mocha.Context) {
		this.timeout(10000);
		const root = createTempGitRepo();
		const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-journal-'));
		try {
			writeRepoFile(root, 'tracked.txt', 'old\n');
			git(root, 'add', 'tracked.txt');
			git(root, 'commit', '-m', 'initial');
			writeRepoFile(root, 'tracked.txt', 'new\n');
			const service = new GitService();
			const folder = workspaceFolder(root);
			const project = (await service.discoverProjects(folder))[0];
			const pair = (await service.createFilePairs(folder))[0];
			const hunk = pair.pendingHunks?.[0];
			assert.ok(hunk);
			const uri = vscode.Uri.file(path.join(root, 'tracked.txt'));
			const context = { storageUri: vscode.Uri.file(storage), globalStorageUri: vscode.Uri.file(storage) } as vscode.ExtensionContext;
			const beforeHash = await fileStateHash(uri);
			const afterHash = expectedRejectedFileHash(pair.newText, hunk, pair.gitSnapshot?.indexExists ?? true);
			const firstStore = new GitReviewJournalStore(context);
			await firstStore.prepare(project, project.headOid ?? '', pair.relativePath, uri, hunk, beforeHash, afterHash);
			await service.applyPatch(folder, hunk.patch, { reverse: true });

			const restarted = new GitReviewJournalStore(context);
			const recovered = await restarted.load(project, project.headOid ?? '');
			assert.strictEqual(recovered.records.length, 1);
			assert.strictEqual(recovered.records[0].state, 'applied');

			const invalidated = await restarted.load(project, `${project.headOid}-changed`);
			assert.strictEqual(invalidated.headChanged, true);
			assert.deepStrictEqual(invalidated.records, []);
		} finally {
			removeTempRepo(root);
			fs.rmSync(storage, { recursive: true, force: true });
		}
	});

	test('keeps AI findings and suggestions attached after rejecting an entire file', async function (this: Mocha.Context) {
		this.timeout(10000);
		const root = createTempGitRepo();
		const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-file-reject-ai-'));
		try {
			const middle = Array.from({ length: 10 }, (_, index) => `keep-${index}\n`).join('');
			writeRepoFile(root, 'tracked.txt', `old-top\n${middle}old-bottom\n`);
			git(root, 'add', 'tracked.txt');
			git(root, 'commit', '-m', 'initial');
			writeRepoFile(root, 'tracked.txt', `new-top\n${middle}new-bottom\n`);
			const service = new GitService();
			const folder = workspaceFolder(root);
			const project = (await service.discoverProjects(folder))[0];
			const pair = (await service.createFilePairs(folder))[0];
			const hunks = pair.pendingHunks ?? [];
			assert.strictEqual(hunks.length, 2);
			const uri = pair.uri;
			const file = reviewFileState(uri, pair.relativePath, {
				projectId: project.id,
				oldText: pair.oldText,
				newText: pair.newText,
				hunks,
				gitSnapshot: pair.gitSnapshot,
				headOid: pair.headOid,
			});
			const session: ReviewSession = {
				id: 'file-reject-ai', mode: 'git', rootUri: vscode.Uri.file(root), createdAt: 1,
				files: new Map([[uri.toString(), file]]), projects: [project],
			};
			const memento = new TestMemento();
			const aiStore = new AiReviewStore(memento as unknown as vscode.Memento);
			const review = storedAiReview({
				signature: reviewChangeSignature(session),
				findings: hunks.map((hunk, index) => aiReviewFinding(uri, pair.relativePath, hunk, `finding-${index}`, index)),
				suggestions: hunks.map((hunk, index) => aiReviewSuggestion(uri, pair.relativePath, hunk, `suggestion-${index}`, index)),
				completedFiles: [uri.toString()],
			});
			await aiStore.save(session, review);
			const context = { storageUri: vscode.Uri.file(storage), globalStorageUri: vscode.Uri.file(storage) } as vscode.ExtensionContext;
			const journal = new GitReviewJournalStore(context);
			const controller = Object.create(ReviewController.prototype) as any;
			Object.assign(controller, {
				activeSession: session,
				gitService: service,
				gitReviewJournal: journal,
				aiReviewStore: aiStore,
				isOpenDocumentDirty: () => false,
				refreshUi: () => undefined,
				syncNativeReviewAfterMutation: async () => undefined,
				synchronizeOpenDocumentAfterGitMutation: async () => undefined,
				humanEditBatches: new Map(),
				humanSaveIntents: new Map(),
				internalWriteDepth: new Map(),
				writeGraceUntil: new Map(),
				showError: (error: unknown) => { throw error; },
			});

			await controller.rejectFileCore(file, file.revision);
			const rejectedFile = session.files.get(uri.toString());
			assert.ok(rejectedFile);
			assert.strictEqual(rejectedFile.rejectedHunks.length, 2);
			assert.strictEqual(rejectedFile.gitSnapshot?.indexBlobOid, pair.gitSnapshot?.indexBlobOid);
			assert.strictEqual(reviewChangeSignature(session), review.signature);
			const restoredReview = aiStore.load(session);
			assert.strictEqual(restoredReview?.findings.length, 2);
			assert.strictEqual(restoredReview?.suggestions.length, 2);
			const records = (await journal.load(project, project.headOid ?? '')).records;
			assert.ok(records.every((record) => record.kind !== 'reject' || record.indexBlobOid === pair.gitSnapshot?.indexBlobOid));
			const payload = buildReviewDashboardPayload(session, uri, () => false, {
				...defaultLlmWikiDashboardState(),
				reviewFindings: restoredReview?.findings ?? [],
				reviewSuggestions: restoredReview?.suggestions ?? [],
			});
			assert.strictEqual(payload.files[0].chunks.length, 2);
			assert.ok(payload.files[0].chunks.every((chunk) => chunk.findings.length === 1 && chunk.suggestions.length === 1));
		} finally {
			removeTempRepo(root);
			fs.rmSync(storage, { recursive: true, force: true });
		}
	});

	test('persists accepted decisions without staging and flushes them on manual refresh', async function (this: Mocha.Context) {
		this.timeout(10000);
		const root = createTempGitRepo();
		const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-accepted-journal-'));
		try {
			writeRepoFile(root, 'tracked.txt', 'old\n');
			git(root, 'add', 'tracked.txt');
			git(root, 'commit', '-m', 'initial');
			writeRepoFile(root, 'tracked.txt', 'new\n');
			const service = new GitService();
			const folder = workspaceFolder(root);
			const project = (await service.discoverProjects(folder))[0];
			const pair = (await service.createFilePairs(folder))[0];
			const hunk = pair.pendingHunks?.[0];
			assert.ok(hunk);
			const uri = vscode.Uri.file(path.join(root, 'tracked.txt'));
			const context = { storageUri: vscode.Uri.file(storage), globalStorageUri: vscode.Uri.file(storage) } as vscode.ExtensionContext;
			const journal = new GitReviewJournalStore(context);
			const record = await journal.accept(project, project.headOid ?? '', pair.relativePath, uri, hunk, pair.gitSnapshot?.indexBlobOid);
			assert.strictEqual(record.sourceHunkId, hunk.id);
			assert.strictEqual(record.reviewItemId, hunk.id);
			assert.strictEqual(record.memberHunks?.length, 1);

			assert.strictEqual((await service.readIndexEntry(folder, 'tracked.txt')).text, 'old\n');
			const restored = await new GitReviewJournalStore(context).load(project, project.headOid ?? '');
			assert.strictEqual(restored.records.length, 1);
			assert.strictEqual(restored.records[0].kind, 'accept');

			const file = reviewFileState(uri, pair.relativePath, {
				projectId: project.id,
				oldText: pair.oldText,
				newText: pair.newText,
				hunks: [],
				acceptedHunks: [journal.toAcceptedHunk(record, hunk)],
				gitSnapshot: pair.gitSnapshot,
				headOid: pair.headOid,
			});
			const session: ReviewSession = {
				id: 'flush-accepted', mode: 'git', rootUri: vscode.Uri.file(root), createdAt: 1,
				files: new Map([[uri.toString(), file]]), projects: [project],
			};
			const controller = Object.create(ReviewController.prototype) as any;
			Object.assign(controller, {
				activeSession: session,
				gitService: service,
				gitReviewJournal: journal,
				isOpenDocumentDirty: () => false,
			});

			await controller.flushReviewedChangesToIndex();

			assert.strictEqual((await service.readIndexEntry(folder, 'tracked.txt')).text, 'new\n');
			assert.deepStrictEqual((await journal.load(project, project.headOid ?? '')).records, []);
		} finally {
			removeTempRepo(root);
			fs.rmSync(storage, { recursive: true, force: true });
		}
	});

	test('invalidates an accepted decision when a new working edit replaces the same hunk', async function (this: Mocha.Context) {
		this.timeout(10000);
		const root = createTempGitRepo();
		const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-overlap-journal-'));
		try {
			writeRepoFile(root, 'tracked.txt', 'old\n');
			git(root, 'add', 'tracked.txt');
			git(root, 'commit', '-m', 'initial');
			writeRepoFile(root, 'tracked.txt', 'reviewed\n');
			const service = new GitService();
			const folder = workspaceFolder(root);
			const project = (await service.discoverProjects(folder))[0];
			const firstPair = (await service.createFilePairs(folder))[0];
			const reviewedHunk = firstPair.pendingHunks?.[0];
			assert.ok(reviewedHunk);
			const uri = vscode.Uri.file(path.join(root, 'tracked.txt'));
			const context = { storageUri: vscode.Uri.file(storage), globalStorageUri: vscode.Uri.file(storage) } as vscode.ExtensionContext;
			const journal = new GitReviewJournalStore(context);
			await journal.accept(project, project.headOid ?? '', firstPair.relativePath, uri, reviewedHunk, firstPair.gitSnapshot?.indexBlobOid);

			writeRepoFile(root, 'tracked.txt', 'replaced-after-review\n');
			const latestPair = (await service.createFilePairs(folder))[0];
			const file = reviewFileState(uri, latestPair.relativePath, {
				projectId: project.id,
				oldText: latestPair.oldText,
				newText: latestPair.newText,
				hunks: latestPair.pendingHunks ?? [],
				gitSnapshot: latestPair.gitSnapshot,
				headOid: latestPair.headOid,
			});
			const files = new Map([[uri.toString(), file]]);
			const controller = Object.create(ReviewController.prototype) as any;
			Object.assign(controller, { gitReviewJournal: journal, aiReviewStore: { clear: async () => undefined } });

			await controller.attachRejectedJournals(files, [project]);

			assert.strictEqual(file.acceptedHunks.length, 0);
			assert.strictEqual(file.hunks.length, 1);
			assert.strictEqual(file.hunks[0].newText, 'replaced-after-review\n');
			assert.deepStrictEqual((await journal.load(project, project.headOid ?? '')).records, []);
		} finally {
			removeTempRepo(root);
			fs.rmSync(storage, { recursive: true, force: true });
		}
	});

	test('reattaches an unchanged accepted decision after restart', async function (this: Mocha.Context) {
		this.timeout(10000);
		const root = createTempGitRepo();
		const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-restore-accepted-'));
		try {
			writeRepoFile(root, 'tracked.txt', 'old\n');
			git(root, 'add', 'tracked.txt');
			git(root, 'commit', '-m', 'initial');
			writeRepoFile(root, 'tracked.txt', 'reviewed\n');
			const service = new GitService();
			const folder = workspaceFolder(root);
			const project = (await service.discoverProjects(folder))[0];
			const pair = (await service.createFilePairs(folder))[0];
			const hunk = pair.pendingHunks?.[0];
			assert.ok(hunk);
			const uri = vscode.Uri.file(path.join(root, 'tracked.txt'));
			const context = { storageUri: vscode.Uri.file(storage), globalStorageUri: vscode.Uri.file(storage) } as vscode.ExtensionContext;
			await new GitReviewJournalStore(context).accept(project, project.headOid ?? '', pair.relativePath, uri, hunk, pair.gitSnapshot?.indexBlobOid);
			const restarted = new GitReviewJournalStore(context);
			const file = reviewFileState(uri, pair.relativePath, {
				projectId: project.id,
				oldText: pair.oldText,
				newText: pair.newText,
				hunks: pair.pendingHunks ?? [],
				gitSnapshot: pair.gitSnapshot,
				headOid: pair.headOid,
			});
			const controller = Object.create(ReviewController.prototype) as any;
			Object.assign(controller, { gitReviewJournal: restarted, aiReviewStore: { clear: async () => undefined } });

			await controller.attachRejectedJournals(new Map([[uri.toString(), file]]), [project]);

			assert.strictEqual(file.hunks.length, 0);
			assert.strictEqual(file.acceptedHunks.length, 1);
			assert.strictEqual(file.acceptedHunks[0].status, 'accepted');
		} finally {
			removeTempRepo(root);
			fs.rmSync(storage, { recursive: true, force: true });
		}
	});

	test('reattaches every member of an accepted logical suggestion chunk after restart', async function (this: Mocha.Context) {
		this.timeout(10000);
		const root = createTempGitRepo();
		const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-logical-accepted-'));
		try {
			const middle = Array.from({ length: 8 }, (_, index) => `old-${index}\n`);
			const baseline = ['head\n', 'old-top\n', ...middle, 'old-bottom\n', 'tail\n'].join('');
			const before = ['head\n', 'new-top\n', ...middle.map((_, index) => `changed-${index}\n`), 'new-bottom\n', 'tail\n'].join('');
			const after = ['head\n', 'new-top\n', ...middle, 'new-bottom\n', 'tail\n'].join('');
			writeRepoFile(root, 'tracked.txt', baseline);
			git(root, 'add', 'tracked.txt');
			git(root, 'commit', '-m', 'initial');
			writeRepoFile(root, 'tracked.txt', after);
			const service = new GitService();
			const folder = workspaceFolder(root);
			const project = (await service.discoverProjects(folder))[0];
			const pair = (await service.createFilePairs(folder))[0];
			const members = pair.pendingHunks ?? [];
			assert.strictEqual(members.length, 2);
			const uri = vscode.Uri.file(path.join(root, 'tracked.txt'));
			const file = reviewFileState(uri, pair.relativePath, {
				projectId: project.id,
				oldText: pair.oldText,
				newText: pair.newText,
				hunks: members,
				gitSnapshot: pair.gitSnapshot,
				headOid: pair.headOid,
			});
			const original = computeLineDiff(uri.toString(), baseline, before)[0];
			const controller = Object.create(ReviewController.prototype) as any;
			Object.assign(controller, { gitService: service });
			const logical = controller.createLogicalSuggestionHunk(file, original, members, original.id) as GitReviewHunk;
			const appliedSuggestion = {
				suggestionId: 'suggestion-logical',
				sourceHunkId: original.id,
				currentHunkId: logical.id,
				reviewItemId: original.id,
				originalHunk: original,
				replacementText: logical.newText,
				appliedHunk: logical,
				appliedHunks: members,
				appliedText: logical.newText,
				appliedAt: 1,
			};
			const context = { storageUri: vscode.Uri.file(storage), globalStorageUri: vscode.Uri.file(storage) } as vscode.ExtensionContext;
			const journal = new GitReviewJournalStore(context);
			await journal.accept(project, project.headOid ?? '', pair.relativePath, uri, logical, pair.gitSnapshot?.indexBlobOid, appliedSuggestion);

			const restartedFile = reviewFileState(uri, pair.relativePath, {
				projectId: project.id,
				oldText: pair.oldText,
				newText: pair.newText,
				hunks: members,
				gitSnapshot: pair.gitSnapshot,
				headOid: pair.headOid,
			});
			const restartedController = Object.create(ReviewController.prototype) as any;
			Object.assign(restartedController, {
				gitService: service,
				gitReviewJournal: new GitReviewJournalStore(context),
				aiReviewStore: { clear: async () => undefined },
			});
			await restartedController.attachRejectedJournals(new Map([[uri.toString(), restartedFile]]), [project]);

			assert.strictEqual(restartedFile.hunks.length, 0);
			assert.strictEqual(restartedFile.acceptedHunks.length, 1);
			assert.strictEqual(restartedFile.acceptedHunks[0].memberHunks?.length, 2);
			assert.strictEqual(restartedFile.acceptedHunks[0].reviewItemId, original.id);
			await service.applyPatch(folder, restartedFile.acceptedHunks[0].patch ?? '', { cached: true, check: true });
		} finally {
			removeTempRepo(root);
			fs.rmSync(storage, { recursive: true, force: true });
		}
	});

	test('undoing an accepted suggestion keeps suggested text pending until suggestion undo', async function (this: Mocha.Context) {
		this.timeout(10000);
		const root = createTempGitRepo();
		const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-layered-suggestion-undo-'));
		try {
			writeRepoFile(root, 'tracked.txt', 'old\n');
			git(root, 'add', 'tracked.txt');
			git(root, 'commit', '-m', 'initial');
			writeRepoFile(root, 'tracked.txt', 'suggested\n');
			const service = new GitService();
			const folder = workspaceFolder(root);
			const project = (await service.discoverProjects(folder))[0];
			const pair = (await service.createFilePairs(folder))[0];
			const suggestedHunk = pair.pendingHunks?.[0];
			assert.ok(suggestedHunk);
			const uri = vscode.Uri.file(path.join(root, 'tracked.txt'));
			const originalHunk = computeLineDiff(uri.toString(), 'old\n', 'new\n')[0];
			const appliedSuggestion = {
				suggestionId: 'suggestion-layered',
				sourceHunkId: originalHunk.id,
				currentHunkId: suggestedHunk.id,
				reviewItemId: originalHunk.id,
				originalHunk,
				replacementText: 'suggested\n',
				appliedHunk: suggestedHunk,
				appliedHunks: [suggestedHunk],
				appliedWorkingText: 'suggested\n',
				undoWorkingText: 'new\n',
				appliedAt: 1,
			};
			const context = { storageUri: vscode.Uri.file(storage), globalStorageUri: vscode.Uri.file(storage) } as vscode.ExtensionContext;
			const journal = new GitReviewJournalStore(context);
			const record = await journal.accept(
				project,
				project.headOid ?? '',
				pair.relativePath,
				uri,
				suggestedHunk,
				pair.gitSnapshot?.indexBlobOid,
				appliedSuggestion,
			);
			const file = reviewFileState(uri, pair.relativePath, {
				projectId: project.id,
				oldText: pair.oldText,
				newText: pair.newText,
				hunks: [],
				acceptedHunks: [journal.toAcceptedHunk(record, suggestedHunk)],
				appliedAiSuggestions: [],
				gitSnapshot: pair.gitSnapshot,
				headOid: pair.headOid,
			});
			const session: ReviewSession = {
				id: 'layered-suggestion-undo', mode: 'git', rootUri: vscode.Uri.file(root), createdAt: 1,
				files: new Map([[uri.toString(), file]]), projects: [project],
			};
			const controller = Object.create(ReviewController.prototype) as any;
			Object.assign(controller, {
				activeSession: session,
				gitService: service,
				gitReviewJournal: journal,
				aiReviewStore: { load: () => undefined, save: async () => undefined, clear: async () => undefined },
				isOpenDocumentDirty: () => false,
				refreshUi: () => undefined,
				syncNativeReviewAfterMutation: async () => undefined,
				refreshReviewPresentation: () => undefined,
				refreshLlmWikiDashboardState: async () => undefined,
				writeCurrentFileText: async (_uri: vscode.Uri, text: string) => writeRepoFile(root, 'tracked.txt', text),
			});

			await controller.restoreChangeCore(uri.toString(), record.id, file.revision);
			let restored = session.files.get(uri.toString());
			assert.strictEqual(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'suggested\n');
			assert.strictEqual(restored?.acceptedHunks.length, 0);
			assert.strictEqual(restored?.hunks.length, 1);
			assert.strictEqual(restored?.hunks[0].newText, 'suggested\n');
			assert.strictEqual(restored?.appliedAiSuggestions.length, 1);

			await controller.undoAiSuggestionCore(uri.toString(), restored?.hunks[0].id, appliedSuggestion.suggestionId);
			restored = session.files.get(uri.toString());
			assert.strictEqual(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'new\n');
			assert.strictEqual(restored?.hunks.length, 1);
			assert.strictEqual(restored?.hunks[0].newText, 'new\n');
			assert.strictEqual(restored?.appliedAiSuggestions.length, 0);
		} finally {
			removeTempRepo(root);
			fs.rmSync(storage, { recursive: true, force: true });
		}
	});

	test('applies a modify suggestion that resolves its Git hunk to the index', async function (this: Mocha.Context) {
		this.timeout(10000);
		const root = createTempGitRepo();
		const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-resolved-suggestion-apply-'));
		try {
			writeRepoFile(root, 'tracked.txt', 'old-a\nold-b\n');
			git(root, 'add', 'tracked.txt');
			git(root, 'commit', '-m', 'initial');
			writeRepoFile(root, 'tracked.txt', 'pending\n');
			const service = new GitService();
			const folder = workspaceFolder(root);
			const project = (await service.discoverProjects(folder))[0];
			const pair = (await service.createFilePairs(folder))[0];
			const hunk = pair.pendingHunks?.[0];
			assert.ok(hunk);
			assert.strictEqual(hunk.kind, 'modify');
			const uri = pair.uri;
			const file = reviewFileState(uri, pair.relativePath, {
				projectId: project.id,
				oldText: pair.oldText,
				newText: pair.newText,
				hunks: [hunk],
				gitSnapshot: pair.gitSnapshot,
				headOid: pair.headOid,
			});
			const session: ReviewSession = {
				id: 'resolved-suggestion-apply', mode: 'git', rootUri: vscode.Uri.file(root), createdAt: 1,
				files: new Map([[uri.toString(), file]]), projects: [project],
			};
			const suggestion = aiReviewSuggestion(uri, pair.relativePath, hunk, 'suggestion-resolve-index', 0);
			suggestion.replacementText = 'old-a\nold-b\n';
			const review = storedAiReview({ suggestions: [suggestion], completedFiles: [uri.toString()] });
			const savedReviews: StoredAiReview[] = [];
			const context = { storageUri: vscode.Uri.file(storage), globalStorageUri: vscode.Uri.file(storage) } as vscode.ExtensionContext;
			const controller = Object.create(ReviewController.prototype) as any;
			Object.assign(controller, {
				activeSession: session,
				gitService: service,
				gitReviewJournal: new GitReviewJournalStore(context),
				aiReviewStore: {
					load: () => review,
					save: async (_session: ReviewSession, stored: StoredAiReview) => savedReviews.push(stored),
					clear: async () => undefined,
				},
				isOpenDocumentDirty: () => false,
				refreshUi: () => undefined,
				refreshLlmWikiDashboardState: async () => undefined,
				writeCurrentFileText: async (_uri: vscode.Uri, text: string) => writeRepoFile(root, 'tracked.txt', text),
				showError: (error: unknown) => { throw error; },
			});

			await controller.applyAiSuggestionCore(uri.toString(), hunk.id, suggestion.id);
			const resolved = session.files.get(uri.toString());
			assert.strictEqual(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'old-a\nold-b\n');
			assert.strictEqual(git(root, 'diff', '--', 'tracked.txt'), '');
			assert.strictEqual(resolved?.hunks.length, 0);
			assert.strictEqual(resolved?.appliedAiSuggestions.length, 1);
			assert.strictEqual(resolved?.appliedAiSuggestions[0].resolvedToIndex, true);
			assert.deepStrictEqual(resolved?.appliedAiSuggestions[0].appliedHunks, []);
			assert.ok(resolved?.appliedAiSuggestions[0].currentHunkId.startsWith('suggestion-resolved-'));
			assert.strictEqual(savedReviews.length, 1);

			await controller.refreshGitReviewFile(uri, { refreshUi: false });
			assert.strictEqual(session.files.get(uri.toString())?.appliedAiSuggestions.length, 1);
			await controller.flushReviewedChangesToIndex();
			await controller.refreshGitReviewFile(uri, { refreshUi: false });
			assert.strictEqual(session.files.has(uri.toString()), false);
		} finally {
			removeTempRepo(root);
			fs.rmSync(storage, { recursive: true, force: true });
		}
	});

	test('undoing a suggestion resolved to the index restores the original pending hunk', async function (this: Mocha.Context) {
		this.timeout(10000);
		const root = createTempGitRepo();
		const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-resolved-suggestion-undo-'));
		try {
			writeRepoFile(root, 'tracked.txt', 'old\n');
			git(root, 'add', 'tracked.txt');
			git(root, 'commit', '-m', 'initial');
			const service = new GitService();
			const folder = workspaceFolder(root);
			const project = (await service.discoverProjects(folder))[0];
			const uri = vscode.Uri.file(path.join(root, 'tracked.txt'));
			const originalHunk = computeLineDiff(uri.toString(), 'old\n', 'pending\n')[0];
			const controller = Object.create(ReviewController.prototype) as any;
			const resolvedHunk = controller.createResolvedSuggestionHunk(originalHunk, 'old\n', originalHunk.id) as ReviewHunk;
			const appliedSuggestion = {
				suggestionId: 'suggestion-resolved-to-index',
				sourceHunkId: originalHunk.id,
				currentHunkId: resolvedHunk.id,
				reviewItemId: originalHunk.id,
				originalHunk,
				replacementText: 'old\n',
				appliedHunk: resolvedHunk,
				appliedHunks: [],
				appliedWorkingText: 'old\n',
				undoWorkingText: 'pending\n',
				resolvedToIndex: true,
				appliedAt: 1,
			};
			const file = reviewFileState(uri, 'tracked.txt', {
				projectId: project.id,
				oldText: 'old\n',
				newText: 'old\n',
				hunks: [],
				appliedAiSuggestions: [appliedSuggestion],
				gitSnapshot: {
					headText: 'old\n', indexText: 'old\n', workingText: 'old\n',
					headExists: true, indexExists: true, workingExists: true,
				},
				headOid: project.headOid,
			});
			const session: ReviewSession = {
				id: 'resolved-suggestion-undo', mode: 'git', rootUri: vscode.Uri.file(root), createdAt: 1,
				files: new Map([[uri.toString(), file]]), projects: [project],
			};
			const context = { storageUri: vscode.Uri.file(storage), globalStorageUri: vscode.Uri.file(storage) } as vscode.ExtensionContext;
			Object.assign(controller, {
				activeSession: session,
				gitService: service,
				gitReviewJournal: new GitReviewJournalStore(context),
				aiReviewStore: { load: () => undefined, save: async () => undefined, clear: async () => undefined },
				isOpenDocumentDirty: () => false,
				refreshUi: () => undefined,
				refreshReviewPresentation: () => undefined,
				refreshLlmWikiDashboardState: async () => undefined,
				writeCurrentFileText: async (_uri: vscode.Uri, text: string) => writeRepoFile(root, 'tracked.txt', text),
			});

			await controller.undoAiSuggestionCore(uri.toString(), resolvedHunk.id, appliedSuggestion.suggestionId);
			const restored = session.files.get(uri.toString());
			assert.strictEqual(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'pending\n');
			assert.strictEqual(restored?.hunks.length, 1);
			assert.strictEqual(restored?.hunks[0].newText, 'pending\n');
			assert.strictEqual(restored?.appliedAiSuggestions.length, 0);
		} finally {
			removeTempRepo(root);
			fs.rmSync(storage, { recursive: true, force: true });
		}
	});

	test('undoing a rejected suggestion restores suggested text and its applied state', async function (this: Mocha.Context) {
		this.timeout(10000);
		const root = createTempGitRepo();
		const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-layered-reject-undo-'));
		try {
			writeRepoFile(root, 'tracked.txt', 'old\n');
			git(root, 'add', 'tracked.txt');
			git(root, 'commit', '-m', 'initial');
			writeRepoFile(root, 'tracked.txt', 'suggested\n');
			const service = new GitService();
			const folder = workspaceFolder(root);
			const project = (await service.discoverProjects(folder))[0];
			const pair = (await service.createFilePairs(folder))[0];
			const suggestedHunk = pair.pendingHunks?.[0];
			assert.ok(suggestedHunk);
			const uri = vscode.Uri.file(path.join(root, 'tracked.txt'));
			const originalHunk = computeLineDiff(uri.toString(), 'old\n', 'new\n')[0];
			const appliedSuggestion = {
				suggestionId: 'suggestion-rejected',
				sourceHunkId: originalHunk.id,
				currentHunkId: suggestedHunk.id,
				reviewItemId: originalHunk.id,
				originalHunk,
				replacementText: 'suggested\n',
				appliedHunk: suggestedHunk,
				appliedHunks: [suggestedHunk],
				appliedWorkingText: 'suggested\n',
				undoWorkingText: 'new\n',
				appliedAt: 1,
			};
			const context = { storageUri: vscode.Uri.file(storage), globalStorageUri: vscode.Uri.file(storage) } as vscode.ExtensionContext;
			const journal = new GitReviewJournalStore(context);
			const record = await journal.prepare(
				project,
				project.headOid ?? '',
				pair.relativePath,
				uri,
				suggestedHunk,
				await fileStateHash(uri),
				expectedRejectedFileHash(pair.newText, suggestedHunk, pair.gitSnapshot?.indexExists ?? true),
				appliedSuggestion,
			);
			await service.applyPatch(folder, suggestedHunk.patch, { reverse: true });
			await journal.setState(project, project.headOid ?? '', record.id, 'applied');

			const restartedJournal = new GitReviewJournalStore(context);
			const files = new Map<string, ReviewFileState>();
			const controller = Object.create(ReviewController.prototype) as any;
			Object.assign(controller, {
				gitService: service,
				gitReviewJournal: restartedJournal,
				aiReviewStore: { load: () => undefined, save: async () => undefined, clear: async () => undefined },
				isOpenDocumentDirty: () => false,
				refreshUi: () => undefined,
				syncNativeReviewAfterMutation: async () => undefined,
				synchronizeOpenDocumentAfterGitMutation: async () => undefined,
				humanEditBatches: new Map(),
				humanSaveIntents: new Map(),
				internalWriteDepth: new Map(),
				writeGraceUntil: new Map(),
				showError: (error: unknown) => { throw error; },
			});
			await controller.attachRejectedJournals(files, [project]);
			const rejectedFile = files.get(uri.toString());
			assert.ok(rejectedFile);
			const session: ReviewSession = {
				id: 'layered-reject-undo', mode: 'git', rootUri: vscode.Uri.file(root), createdAt: 1,
				files, projects: [project],
			};
			controller.activeSession = session;

			await controller.restoreChangeCore(uri.toString(), rejectedFile.rejectedHunks[0].id, rejectedFile.revision);
			const restored = session.files.get(uri.toString());
			assert.strictEqual(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'suggested\n');
			assert.strictEqual(restored?.rejectedHunks.length, 0);
			assert.strictEqual(restored?.hunks.length, 1);
			assert.strictEqual(restored?.hunks[0].newText, 'suggested\n');
			assert.strictEqual(restored?.appliedAiSuggestions.length, 1);
		} finally {
			removeTempRepo(root);
			fs.rmSync(storage, { recursive: true, force: true });
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

function storedAiReview(overrides: Partial<StoredAiReview> = {}): StoredAiReview {
	return {
		signature: 'test',
		findings: [],
		suggestions: [],
		fileResults: [],
		generatedAt: '2026-06-25T00:00:00.000Z',
		status: 'complete',
		completedFiles: [],
		...overrides,
	};
}

function aiReviewFinding(
	uri: vscode.Uri,
	relativePath: string,
	hunk: ReviewHunk,
	id = 'finding-1',
	generationOrder = 0,
): StoredAiReview['findings'][number] {
	return {
		id,
		uri: uri.toString(),
		relativePath,
		hunkId: hunk.id,
		line: hunk.newStart,
		severity: 'warning',
		title: 'Finding',
		explanation: 'Risk',
		recommendation: 'Fix',
		evidence: [],
		generationOrder,
	};
}

function aiReviewSuggestion(
	uri: vscode.Uri,
	relativePath: string,
	hunk: ReviewHunk,
	id = 'suggestion-1',
	generationOrder = 0,
): StoredAiReview['suggestions'][number] {
	return {
		id,
		uri: uri.toString(),
		relativePath,
		hunkId: hunk.id,
		line: hunk.newStart,
		replacementText: 'suggested\n',
		rationale: 'Prefer this.',
		generationOrder,
	};
}

type TestReviewController = {
	acceptFileCore(uriString?: string | ReviewFileState, expectedRevision?: number): Promise<void>;
	undoFileCore(uriString?: string | ReviewFileState, expectedRevision?: number): Promise<void>;
	originalHunkSideMatches(text: string, hunk: ReviewHunk, side: 'old' | 'new', startLine: number): boolean;
};

type RefreshReviewController = {
	refreshFile(uri: vscode.Uri, options?: { reconcileExternalChanges?: boolean; preferDisk?: boolean }): Promise<void>;
};

function reviewControllerHarness(
	session: ReviewSession,
	initialCurrentText: string,
	store = new AiReviewStore(new TestMemento() as unknown as vscode.Memento),
): { controller: TestReviewController; writes: string[]; currentText: () => string; unmatchedMutationCount: () => number } {
	let currentText = initialCurrentText;
	const writes: string[] = [];
	let unmatchedMutationCount = 0;
	const controller = Object.create(ReviewController.prototype) as TestReviewController;
	Object.assign(controller as unknown as Record<string, unknown>, {
		activeSession: session,
		aiReviewStore: store,
		manualGitBaselines: new Map<string, unknown>(),
		resolveFile: (target?: string | ReviewFileState) => {
			if (!target) {
				return [...session.files.values()][0];
			}
			return typeof target === 'string' ? session.files.get(target) : target;
		},
		isStaleMutation: () => false,
		ensureFileCleanForReviewMutation: () => true,
		readCurrentText: async () => ({ exists: true, text: currentText }),
		writeCurrentFileText: async (_uri: vscode.Uri, text: string) => {
			currentText = text;
			writes.push(text);
		},
		updateSnapshotBaselineFile: async () => undefined,
		refreshFile: async () => undefined,
		refreshUnmatchedMutation: async () => { unmatchedMutationCount += 1; },
		syncNativeReviewAfterMutation: async () => undefined,
		showError: (error: unknown) => {
			throw error;
		},
	});
	return {
		controller,
		writes,
		currentText: () => currentText,
		unmatchedMutationCount: () => unmatchedMutationCount,
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
