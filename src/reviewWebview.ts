import * as path from 'path';
import * as vscode from 'vscode';
import { ReviewedHunk, ReviewFileState, ReviewHunk, ReviewSession, uriKey } from './types';

export interface EditedRange {
	startLine: number;
	endLine: number;
}

type WebviewMessage =
	| { type: 'ready' }
	| { type: 'accept'; uri: string; hunkId: string }
	| { type: 'reject'; uri: string; hunkId: string }
	| { type: 'restore'; uri: string; hunkId: string }
	| { type: 'saveEditedCurrent'; uri: string; text: string; ranges: EditedRange[] };

interface ReviewWebviewPayload {
	uri: string;
	relativePath: string;
	oldText: string;
	newText: string;
	languageId: string;
	pendingHunks: ReviewHunk[];
	acceptedHunks: ReviewedHunk[];
	rejectedHunks: ReviewedHunk[];
	skippedReason?: string;
}

export class ReviewWebviewManager implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private activeUri: vscode.Uri | undefined;
	private ready = false;
	private readonly disposables: vscode.Disposable[] = [];

	public constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly getSession: () => ReviewSession | undefined,
		private readonly saveEditedCurrent: (uri: string, text: string, ranges: EditedRange[]) => Promise<void>,
	) {}

	public open(uri: vscode.Uri): void {
		this.activeUri = uri;
		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel(
				'cliDiffReview',
				'CLI Diff Review',
				vscode.ViewColumn.Active,
				{
					enableScripts: true,
					localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
				},
			);
			this.panel.webview.html = this.renderShell(this.panel.webview);
			this.disposables.push(
				this.panel.onDidDispose(() => {
					this.panel = undefined;
					this.activeUri = undefined;
					this.ready = false;
				}),
				this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
					void this.handleMessage(message);
				}),
			);
		}

		this.panel.reveal(vscode.ViewColumn.Active);
		void this.postState();
	}

	public refresh(): void {
		void this.postState();
	}

	public dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.panel?.dispose();
	}

	private async handleMessage(message: WebviewMessage): Promise<void> {
		if (message.type === 'ready') {
			this.ready = true;
			await this.postState();
			return;
		}

		if (message.type === 'accept') {
			await vscode.commands.executeCommand('cli-diff.acceptChange', message.uri, message.hunkId);
		} else if (message.type === 'reject') {
			await vscode.commands.executeCommand('cli-diff.rejectChange', message.uri, message.hunkId);
		} else if (message.type === 'restore') {
			await vscode.commands.executeCommand('cli-diff.restoreChange', message.uri, message.hunkId);
		} else if (message.type === 'saveEditedCurrent') {
			await this.saveEditedCurrent(message.uri, message.text, message.ranges);
		}

		await this.postState();
	}

	private async postState(): Promise<void> {
		if (!this.panel || !this.activeUri || !this.ready) {
			return;
		}

		const file = this.getSession()?.files.get(uriKey(this.activeUri));
		if (!file || !this.isReviewable(file)) {
			this.panel.dispose();
			return;
		}

		this.panel.title = file ? `Review: ${file.relativePath}` : 'CLI Diff Review';
		const payload = this.serialize(file);
		await this.panel.webview.postMessage({ type: 'state', file: payload });
	}

	private isReviewable(file: ReviewFileState): boolean {
		return file.hunks.length > 0
			|| file.acceptedHunks.length > 0
			|| file.rejectedHunks.length > 0
			|| Boolean(file.skippedReason);
	}

	private serialize(file: ReviewFileState): ReviewWebviewPayload {
		return {
			uri: file.uri.toString(),
			relativePath: file.relativePath,
			oldText: file.oldText,
			newText: file.newText,
			languageId: languageIdFromPath(file.relativePath),
			pendingHunks: file.hunks,
			acceptedHunks: file.acceptedHunks,
			rejectedHunks: file.rejectedHunks,
			skippedReason: file.skippedReason,
		};
	}

	private renderShell(webview: vscode.Webview): string {
		const nonce = createNonce();
		const loaderUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'monaco', 'vs', 'loader.js'));
		const monacoBaseUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'monaco', 'vs')).toString();
		const cspSource = webview.cspSource;

		return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; font-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'nonce-${nonce}'; worker-src blob: data:;">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>CLI Diff Review</title>
	<style>
		:root {
			color-scheme: dark;
			--bg: var(--vscode-editor-background);
			--fg: var(--vscode-editor-foreground);
			--muted: var(--vscode-descriptionForeground);
			--border: rgba(255, 255, 255, 0.10);
			--header-bg: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-editor-foreground) 12%);
			--zone-bg: color-mix(in srgb, var(--vscode-editor-background) 84%, var(--vscode-editor-foreground) 16%);
			--button-bg: color-mix(in srgb, var(--vscode-editor-background) 72%, var(--vscode-editor-foreground) 28%);
			--button-hover: color-mix(in srgb, var(--vscode-editor-background) 58%, var(--vscode-editor-foreground) 42%);
			--add-bg: rgba(46, 160, 67, 0.16);
			--add-line: rgba(46, 160, 67, 0.82);
			--delete-bg: rgba(248, 81, 73, 0.18);
			--delete-line: rgba(248, 81, 73, 0.82);
			--modify-bg: var(--add-bg);
			--modify-line: var(--add-line);
			--reviewed-bg: rgba(128, 128, 128, 0.15);
			--reviewed-line: rgba(160, 160, 160, 0.75);
			--old-code-fg: color-mix(in srgb, var(--vscode-editor-foreground) 84%, transparent);
		}
		body.vscode-light {
			color-scheme: light;
			--border: rgba(0, 0, 0, 0.12);
			--add-bg: rgba(46, 160, 67, 0.13);
			--delete-bg: rgba(209, 36, 47, 0.13);
			--modify-bg: var(--add-bg);
			--reviewed-bg: rgba(96, 96, 96, 0.12);
		}
		* { box-sizing: border-box; }
		html, body {
			width: 100%;
			height: 100%;
			margin: 0;
			overflow: hidden;
			background: var(--bg);
			color: var(--fg);
			font-family: var(--vscode-font-family);
		}
		body {
			display: grid;
			grid-template-rows: 40px 1fr 24px;
		}
		header {
			display: flex;
			align-items: center;
			gap: 12px;
			padding: 0 14px;
			border-bottom: 1px solid var(--border);
			background: var(--bg);
		}
		.title {
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			font-weight: 600;
		}
		.meta {
			margin-left: auto;
			color: var(--muted);
			white-space: nowrap;
		}
		#editor {
			min-height: 0;
			background: var(--bg);
		}
		#status {
			display: flex;
			align-items: center;
			padding: 0 12px;
			border-top: 1px solid var(--border);
			background: var(--bg);
			color: var(--muted);
			font-size: 12px;
		}
		.monaco-editor .view-zones,
		.monaco-editor .view-zone,
		.cli-hunk-zone,
		.cli-hunk-zone * {
			pointer-events: auto !important;
		}
		.cli-line-add { background-color: var(--add-bg) !important; }
		.cli-line-delete { background-color: var(--delete-bg) !important; }
		.cli-line-modify { background-color: var(--modify-bg) !important; }
		.cli-line-reviewed { background-color: var(--reviewed-bg) !important; }
		.monaco-editor .margin-view-overlays .cli-margin-add { border-left: 3px solid var(--add-line); }
		.monaco-editor .margin-view-overlays .cli-margin-delete { border-left: 3px solid var(--delete-line); }
		.monaco-editor .margin-view-overlays .cli-margin-modify { border-left: 3px solid var(--modify-line); }
		.monaco-editor .margin-view-overlays .cli-margin-reviewed { border-left: 3px solid var(--reviewed-line); }
		.cli-hunk-zone {
			width: 100%;
			padding: 4px 12px 6px 0;
			color: var(--fg);
			font-family: var(--vscode-editor-font-family);
			font-size: var(--vscode-editor-font-size);
			line-height: var(--vscode-editor-line-height, 20px);
			overflow: hidden;
		}
		.cli-hunk-header {
			position: relative;
			z-index: 5;
			height: 28px;
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 0 8px;
			border: 1px solid var(--border);
			border-radius: 5px;
			background: var(--zone-bg);
			overflow: hidden;
		}
		.cli-hunk-zone.active .cli-hunk-header {
			outline: 1px solid var(--vscode-focusBorder);
		}
		.cli-hunk-header::before {
			content: "";
			width: 3px;
			align-self: stretch;
			margin: 5px 2px 5px 0;
			border-radius: 2px;
			background: var(--reviewed-line);
		}
		.cli-hunk-zone.add .cli-hunk-header::before { background: var(--add-line); }
		.cli-hunk-zone.delete .cli-hunk-header::before { background: var(--delete-line); }
		.cli-hunk-zone.modify .cli-hunk-header::before { background: var(--modify-line); }
		.cli-hunk-zone.accepted .cli-hunk-header::before,
		.cli-hunk-zone.rejected .cli-hunk-header::before { background: var(--reviewed-line); }
		.cli-summary {
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			color: var(--muted);
			margin-right: auto;
			font-size: 12px;
		}
		.cli-actions {
			display: flex;
			gap: 6px;
			flex: none;
		}
		button {
			position: relative;
			z-index: 6;
			border: 1px solid var(--border);
			border-radius: 4px;
			padding: 1px 8px;
			background: var(--button-bg);
			color: var(--fg);
			cursor: pointer;
			user-select: none;
			font-family: var(--vscode-font-family);
			font-size: 12px;
			line-height: 18px;
		}
		button.primary {
			background: color-mix(in srgb, var(--vscode-button-background) 62%, var(--button-bg) 38%);
			color: var(--vscode-button-foreground);
		}
		button:hover {
			background: var(--button-hover);
		}
		.cli-old-lines {
			margin-top: 4px;
			border-left: 3px solid var(--delete-line);
			background: var(--delete-bg);
		}
		.cli-hunk-zone.modify .cli-old-lines {
			border-left-color: var(--delete-line);
			background: var(--delete-bg);
		}
		.cli-old-line {
			display: grid;
			grid-template-columns: 24px 1fr;
			min-height: var(--vscode-editor-line-height, 20px);
			color: var(--old-code-fg);
			white-space: pre;
		}
		.cli-marker {
			text-align: center;
			user-select: none;
			opacity: 0.85;
		}
		.cli-hunk-zone.delete .cli-marker { color: var(--delete-line); }
		.cli-hunk-zone.modify .cli-marker { color: var(--delete-line); }
		.cli-old-code {
			overflow: hidden;
			text-overflow: clip;
		}
	</style>
</head>
<body>
	<header>
		<div class="title" id="title">CLI Diff Review</div>
		<div class="meta" id="meta"></div>
	</header>
	<div id="editor"></div>
	<div id="status">Loading Monaco...</div>
	<script nonce="${nonce}" src="${loaderUri}"></script>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const monacoBaseUri = ${JSON.stringify(monacoBaseUri)};
		const labels = {
			accept: '\\u63a5\\u53d7',
			reject: '\\u64a4\\u9500',
			previous: '\\u4e0a\\u4e00\\u4e2a',
			next: '\\u4e0b\\u4e00\\u4e2a',
			accepted: '\\u5df2\\u91c7\\u7eb3',
			rejected: '\\u5df2\\u64a4\\u9500',
			noData: '\\u6ca1\\u6709\\u53ef\\u5ba1\\u6821\\u7684\\u6587\\u4ef6\\u6570\\u636e\\u3002',
			ready: 'Ctrl+S \\u4fdd\\u5b58 Review \\u9875\\u7f16\\u8f91\\uff1b\\u5f85\\u5ba1 hunk \\u5185\\u7f16\\u8f91\\u4e0d\\u4f1a\\u81ea\\u52a8\\u5ba1\\u6821\\u3002',
			dirty: 'Review \\u9875\\u6709\\u672a\\u4fdd\\u5b58\\u7f16\\u8f91\\u3002Ctrl+S \\u4fdd\\u5b58\\u3002',
			saveFirst: '\\u8bf7\\u5148 Ctrl+S \\u4fdd\\u5b58 Review \\u9875\\u7f16\\u8f91\\uff0c\\u518d\\u63a5\\u53d7\\u6216\\u64a4\\u9500\\u5f85\\u5ba1 hunk\\u3002',
			saving: '\\u6b63\\u5728\\u4fdd\\u5b58 Review \\u9875\\u7f16\\u8f91...',
			saved: '\\u5df2\\u4fdd\\u5b58\\u3002',
		};

		let editor;
		let model;
		let changeDisposable;
		let state;
		let ready = false;
		let dirty = false;
		let applyingState = false;
		let dirtyRanges = [];
		let lineDecorations = [];
		let zoneIds = [];
		let hunkEntries = [];
		let activeHunkId;

		const titleNode = document.getElementById('title');
		const metaNode = document.getElementById('meta');
		const statusNode = document.getElementById('status');
		const editorNode = document.getElementById('editor');

		self.MonacoEnvironment = {
			getWorkerUrl: function () {
				const workerMain = monacoBaseUri + '/base/worker/workerMain.js';
				const source = "self.MonacoEnvironment={baseUrl:'" + monacoBaseUri + "/'};importScripts('" + workerMain + "');";
				return 'data:text/javascript;charset=utf-8,' + encodeURIComponent(source);
			}
		};

		require.config({ paths: { vs: monacoBaseUri } });
		require(['vs/editor/editor.main'], function () {
			ready = true;
			createEditor();
			vscode.postMessage({ type: 'ready' });
		});

		window.addEventListener('message', function (event) {
			if (event.data.type !== 'state') {
				return;
			}
			setState(event.data.file);
		});

		window.addEventListener('resize', function () {
			if (editor) {
				editor.layout();
			}
		});
		document.addEventListener('pointerdown', stopToolbarPointer, true);
		document.addEventListener('mousedown', stopToolbarPointer, true);
		document.addEventListener('click', onToolbarClick, true);

		function createEditor() {
			defineTheme();
			monaco.editor.setTheme(document.body.classList.contains('vscode-light') ? 'cli-diff-light' : 'cli-diff-dark');

			editor = monaco.editor.create(editorNode, {
				automaticLayout: true,
				readOnly: false,
				minimap: { enabled: false },
				glyphMargin: false,
				folding: false,
				lineNumbers: 'on',
				lineNumbersMinChars: 3,
				lineDecorationsWidth: 12,
				scrollBeyondLastLine: false,
				renderOverviewRuler: false,
				overviewRulerLanes: 0,
				hideCursorInOverviewRuler: true,
				wordWrap: 'off',
				renderWhitespace: 'none',
				renderControlCharacters: false,
				renderLineHighlight: 'gutter',
				padding: { top: 8, bottom: 24 },
				fontFamily: cssVar('--vscode-editor-font-family') || undefined,
				fontSize: parseInt(cssVar('--vscode-editor-font-size'), 10) || 13,
			});

			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveCurrent);
			applyState();
		}

		function defineTheme() {
			const foreground = cssVar('--vscode-editor-foreground') || '#d4d4d4';
			const background = cssVar('--vscode-editor-background') || '#1e1e1e';
			monaco.editor.defineTheme('cli-diff-dark', {
				base: 'vs-dark',
				inherit: true,
				rules: [],
				colors: {
					'editor.background': background,
					'editor.foreground': foreground,
					'editorLineNumber.foreground': cssVar('--vscode-editorLineNumber-foreground') || '#858585',
					'editorCursor.foreground': cssVar('--vscode-editorCursor-foreground') || foreground,
					'editor.selectionBackground': cssVar('--vscode-editor-selectionBackground') || '#264f78',
					'editor.lineHighlightBackground': cssVar('--vscode-editor-lineHighlightBackground') || '#2a2d2e',
				},
			});
			monaco.editor.defineTheme('cli-diff-light', {
				base: 'vs',
				inherit: true,
				rules: [],
				colors: {
					'editor.background': background,
					'editor.foreground': foreground,
					'editorLineNumber.foreground': cssVar('--vscode-editorLineNumber-foreground') || '#237893',
					'editorCursor.foreground': cssVar('--vscode-editorCursor-foreground') || foreground,
					'editor.selectionBackground': cssVar('--vscode-editor-selectionBackground') || '#add6ff',
					'editor.lineHighlightBackground': cssVar('--vscode-editor-lineHighlightBackground') || '#f0f0f0',
				},
			});
		}

		function setState(nextState) {
			state = nextState;
			if (!ready) {
				return;
			}
			applyState();
		}

		function applyState() {
			if (!editor || !state) {
				titleNode.textContent = 'CLI Diff Review';
				metaNode.textContent = '';
				statusNode.textContent = labels.noData;
				return;
			}

			titleNode.textContent = state.relativePath;
			const reviewedCount = state.acceptedHunks.length + state.rejectedHunks.length;
			metaNode.textContent = state.pendingHunks.length + ' pending \\u00b7 ' + reviewedCount + ' reviewed';
			statusNode.textContent = state.skippedReason || labels.ready;

			if (!model) {
				model = monaco.editor.createModel(state.newText, state.languageId || 'plaintext', monaco.Uri.parse('cli-diff-review-current:///' + encodeURIComponent(state.relativePath)));
				editor.setModel(model);
				changeDisposable = model.onDidChangeContent(onModelChanged);
			} else {
				monaco.editor.setModelLanguage(model, state.languageId || 'plaintext');
				if (!dirty && model.getValue() !== state.newText) {
					applyingState = true;
					model.setValue(state.newText);
					applyingState = false;
				}
			}

			if (!dirty) {
				dirtyRanges = [];
			}
			renderInlineDiff();
		}

		function onModelChanged(event) {
			if (applyingState) {
				return;
			}
			dirty = true;
			for (const change of event.changes) {
				const startLine = Math.max(0, change.range.startLineNumber - 1);
				const insertedLines = countInsertedLines(change.text);
				const endLine = Math.max(change.range.endLineNumber, startLine + insertedLines);
				dirtyRanges.push({ startLine, endLine: Math.max(startLine + 1, endLine) });
			}
			statusNode.textContent = labels.dirty;
		}

		function renderInlineDiff() {
			if (!editor || !model || !state) {
				return;
			}

			const oldZoneIds = zoneIds;
			hunkEntries = buildHunkEntries();
			const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight) || 20;

			editor.changeViewZones(function (accessor) {
				for (const id of oldZoneIds) {
					accessor.removeZone(id);
				}
				zoneIds = [];

				for (const entry of hunkEntries) {
					const node = createZoneNode(entry, lineHeight);
					const heightInPx = 38 + (entry.oldLinesToShow.length * lineHeight);
					zoneIds.push(accessor.addZone({
						afterLineNumber: Math.max(0, entry.displayStart),
						heightInPx,
						domNode: node,
					}));
				}
			});

			const nextDecorations = [];
			for (const entry of hunkEntries) {
				if (entry.displayLines <= 0) {
					continue;
				}
				const lineClass = entry.decided ? 'reviewed' : entry.kind;
				nextDecorations.push({
					range: new monaco.Range(entry.displayStart + 1, 1, entry.displayStart + entry.displayLines, 1),
					options: {
						isWholeLine: true,
						className: 'cli-line-' + lineClass,
						marginClassName: 'cli-margin-' + lineClass,
					},
				});
			}
			lineDecorations = editor.deltaDecorations(lineDecorations, nextDecorations);
			updateActiveZone();
		}

		function buildHunkEntries() {
			const pending = state.pendingHunks.map(function (hunk) {
				const oldLinesToShow = hunk.kind === 'delete' || hunk.kind === 'modify' ? splitLines(hunk.oldText) : [];
				return {
					id: hunk.id,
					kind: hunk.kind,
					oldLines: hunk.oldLines,
					newLines: hunk.newLines,
					displayStart: hunk.newStart,
					displayLines: hunk.newLines,
					oldLinesToShow,
					state: 'pending',
					decided: false,
					source: 'pending',
				};
			});

			const accepted = state.acceptedHunks.map(function (hunk) {
				return {
					id: hunk.id,
					kind: hunk.kind,
					oldLines: hunk.oldLines,
					newLines: hunk.newLines,
					displayStart: hunk.displayStart,
					displayLines: hunk.displayLines,
					oldLinesToShow: [],
					state: hunk.status || 'accepted',
					decided: true,
					source: hunk.reviewSource,
				};
			});
			const rejected = state.rejectedHunks.map(function (hunk) {
				return {
					id: hunk.id,
					kind: hunk.kind,
					oldLines: hunk.oldLines,
					newLines: hunk.newLines,
					displayStart: hunk.displayStart,
					displayLines: hunk.displayLines,
					oldLinesToShow: [],
					state: 'rejected',
					decided: true,
					source: hunk.reviewSource,
				};
			});

			return pending.concat(accepted, rejected).sort(function (left, right) {
				if (left.displayStart === right.displayStart) {
					return Number(left.decided) - Number(right.decided);
				}
				return left.displayStart - right.displayStart;
			});
		}

		function createZoneNode(entry, lineHeight) {
			const node = document.createElement('div');
			node.className = 'cli-hunk-zone ' + (entry.decided ? entry.state : entry.kind);
			node.dataset.hunkId = entry.id;
			node.style.setProperty('--vscode-editor-line-height', lineHeight + 'px');

			const header = document.createElement('div');
			header.className = 'cli-hunk-header';
			node.appendChild(header);

			const summary = document.createElement('span');
			summary.className = 'cli-summary';
			summary.textContent = entry.decided
				? reviewedLabel(entry.source) + ' \\u00b7 ' + entry.kind + ' ' + entry.oldLines + '->' + entry.newLines + ' lines'
				: entry.kind + ' ' + entry.oldLines + '->' + entry.newLines + ' lines';
			header.appendChild(summary);

			const actions = document.createElement('div');
			actions.className = 'cli-actions';
			header.appendChild(actions);

			if (!entry.decided) {
				actions.appendChild(createButton(labels.reject, 'reject', entry));
				actions.appendChild(createButton(labels.accept, 'accept', entry, true));
			} else if (entry.source === 'accept' || entry.source === 'reject') {
				actions.appendChild(createButton(labels.reject, 'restore', entry));
			}
			actions.appendChild(createButton(labels.previous, 'previous', entry));
			actions.appendChild(createButton(labels.next, 'next', entry));

			if (entry.oldLinesToShow.length > 0) {
				const oldLines = document.createElement('div');
				oldLines.className = 'cli-old-lines';
				node.appendChild(oldLines);
				for (const line of entry.oldLinesToShow) {
					oldLines.appendChild(createOldLine(line));
				}
			}

			return node;
		}

		function createOldLine(text) {
			const row = document.createElement('div');
			row.className = 'cli-old-line';

			const marker = document.createElement('span');
			marker.className = 'cli-marker';
			marker.textContent = '-';
			row.appendChild(marker);

			const code = document.createElement('span');
			code.className = 'cli-old-code';
			code.textContent = trimLineEnding(text);
			row.appendChild(code);

			void monaco.editor.colorize(trimLineEnding(text) || ' ', state.languageId || 'plaintext', {
				tabSize: editor.getOption(monaco.editor.EditorOption.tabSize) || 4,
			}).then(function (html) {
				code.innerHTML = html.replace(/\\r?\\n$/, '');
			});

			return row;
		}

		function createButton(label, command, entry, primary) {
			const button = document.createElement('button');
			button.textContent = label;
			button.type = 'button';
			button.dataset.command = command;
			button.dataset.hunkId = entry.id;
			if (primary) {
				button.className = 'primary';
			}
			return button;
		}

		function stopToolbarPointer(event) {
			if (closestElement(event.target, '.cli-hunk-zone button')) {
				event.stopPropagation();
			}
		}

		function onToolbarClick(event) {
			const button = closestElement(event.target, 'button[data-command][data-hunk-id]');
			if (!button) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			handleToolbarCommand(button.dataset.command, button.dataset.hunkId);
		}

		function handleToolbarCommand(command, hunkId) {
			if (!state || !command || !hunkId) {
				return;
			}

			if (command === 'next') {
				moveHunk(1, hunkId);
				return;
			}
			if (command === 'previous') {
				moveHunk(-1, hunkId);
				return;
			}
			if (dirty) {
				statusNode.textContent = labels.saveFirst;
				return;
			}
			vscode.postMessage({ type: command, uri: state.uri, hunkId });
		}

		function closestElement(target, selector) {
			if (!target) {
				return undefined;
			}
			if (target.closest) {
				return target.closest(selector);
			}
			return target.parentElement?.closest(selector);
		}

		function saveCurrent() {
			if (!state || !model) {
				return;
			}
			vscode.postMessage({
				type: 'saveEditedCurrent',
				uri: state.uri,
				text: model.getValue(),
				ranges: mergeRanges(dirtyRanges),
			});
			statusNode.textContent = labels.saving;
			dirty = false;
			dirtyRanges = [];
		}

		function moveHunk(direction, fromId) {
			if (hunkEntries.length === 0) {
				return;
			}
			let index = hunkEntries.findIndex(function (entry) { return entry.id === fromId; });
			if (index < 0) {
				index = 0;
			} else {
				index = (index + direction + hunkEntries.length) % hunkEntries.length;
			}
			focusHunk(hunkEntries[index]);
		}

		function focusHunk(entry) {
			activeHunkId = entry.id;
			updateActiveZone();
			const line = Math.max(1, entry.displayStart + 1);
			editor.revealLineInCenter(line);
			editor.setPosition({ lineNumber: line, column: 1 });
			editor.focus();
		}

		function updateActiveZone() {
			for (const node of document.querySelectorAll('.cli-hunk-zone')) {
				node.classList.toggle('active', node.dataset.hunkId === activeHunkId);
			}
		}

		function splitLines(text) {
			if (!text) {
				return [];
			}
			return text.match(/[^\\r\\n]*(?:\\r\\n|\\n|\\r)|[^\\r\\n]+$/g) || [];
		}

		function trimLineEnding(text) {
			return String(text).replace(/\\r?\\n$|\\r$/, '');
		}

		function countInsertedLines(text) {
			if (!text) {
				return 0;
			}
			return text.split(/\\r\\n|\\r|\\n/).length;
		}

		function mergeRanges(ranges) {
			if (ranges.length === 0) {
				return [];
			}
			const sorted = ranges.slice().sort(function (left, right) {
				return left.startLine - right.startLine || left.endLine - right.endLine;
			});
			const merged = [];
			for (const range of sorted) {
				const last = merged[merged.length - 1];
				if (!last || range.startLine > last.endLine) {
					merged.push({ startLine: range.startLine, endLine: range.endLine });
				} else {
					last.endLine = Math.max(last.endLine, range.endLine);
				}
			}
			return merged;
		}

		function reviewedLabel(source) {
			if (source === 'reject') {
				return labels.rejected;
			}
			return labels.accepted;
		}

		function cssVar(name) {
			return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
				|| getComputedStyle(document.body).getPropertyValue(name).trim();
		}
	</script>
</body>
</html>`;
	}
}

function languageIdFromPath(relativePath: string): string {
	const extension = path.extname(relativePath).toLowerCase();
	const languages = new Map<string, string>([
		['.c', 'c'],
		['.cpp', 'cpp'],
		['.cs', 'csharp'],
		['.css', 'css'],
		['.go', 'go'],
		['.html', 'html'],
		['.java', 'java'],
		['.js', 'javascript'],
		['.jsx', 'javascript'],
		['.json', 'json'],
		['.md', 'markdown'],
		['.py', 'python'],
		['.rs', 'rust'],
		['.ts', 'typescript'],
		['.tsx', 'typescript'],
		['.xml', 'xml'],
		['.yaml', 'yaml'],
		['.yml', 'yaml'],
	]);
	return languages.get(extension) ?? 'plaintext';
}

function createNonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let index = 0; index < 32; index += 1) {
		nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
	}
	return nonce;
}
