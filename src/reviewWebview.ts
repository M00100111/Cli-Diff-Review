import * as path from 'path';
import * as vscode from 'vscode';
import { ReviewedHunk, ReviewFileState, ReviewHunk, ReviewSession, uriKey } from './types';

export interface EditedRange {
	startLine: number;
	endLine: number;
}

type WebviewMessage =
	| { type: 'ready' }
	| { type: 'accept'; uri: string; hunkId: string; revision: number }
	| { type: 'reject'; uri: string; hunkId: string; revision: number }
	| { type: 'restore'; uri: string; hunkId: string; revision: number }
	| { type: 'goToDefinition'; uri: string; line: number; column: number }
	| { type: 'findReferences'; uri: string; line: number; column: number }
	| { type: 'smartNavigate'; uri: string; line: number; column: number }
	| { type: 'resolveNavigationAction'; uri: string; line: number; column: number; requestId: number }
	| { type: 'openNavigationTarget'; uri: string; line: number; column: number }
	| { type: 'applyTextEdits'; uri: string; edits: WebviewTextEdit[]; text: string }
	| { type: 'saveCurrentDocument'; uri: string }
	| { type: 'clipboardRead'; requestId: number }
	| { type: 'clipboardWrite'; requestId: number; text: string };

interface WebviewTextEdit {
	range: {
		startLine: number;
		startColumn: number;
		endLine: number;
		endColumn: number;
	};
	text: string;
}

export type ReviewNavigationRequestType = 'goToDefinition' | 'findReferences' | 'smartNavigate' | 'resolveNavigationAction';

export type ReviewNavigationAction = 'goToDefinition' | 'findReferences';

export interface ReviewNavigationTargetPayload {
	id: string;
	uri: string;
	label: string;
	description: string;
	preview: string;
	line: number;
	column: number;
	reviewable: boolean;
	currentFile: boolean;
}

export type ReviewNavigationResponse =
	| { type: 'navigationAction'; requestId: number; action: ReviewNavigationAction; label: string }
	| { type: 'references'; title: string; sourceUri: string; targets: ReviewNavigationTargetPayload[] };

interface ReviewWebviewPayload {
	uri: string;
	relativePath: string;
	oldText: string;
	newText: string;
	revision: number;
	dirty: boolean;
	languageId: string;
	pendingHunks: ReviewHunk[];
	acceptedHunks: ReviewedHunk[];
	rejectedHunks: ReviewedHunk[];
	skippedReason?: string;
	revealLine?: number;
	revealColumn?: number;
}

interface ReviewEditorHost {
	key: string;
	uri: vscode.Uri;
	document: vscode.TextDocument;
	panel: vscode.WebviewPanel;
	ready: boolean;
	stateSequence: number;
	revealPosition?: { line: number; column: number };
	disposables: vscode.Disposable[];
}

export class ReviewWebviewManager implements vscode.CustomTextEditorProvider, vscode.Disposable {
	public static readonly viewType = 'cli-diff.reviewEditor';

	private readonly hosts = new Map<string, ReviewEditorHost>();
	private readonly pendingRevealPositions = new Map<string, { line: number; column: number }>();
	private readonly textEditQueues = new Map<string, Promise<void>>();
	private readonly refreshTimers = new Map<string, NodeJS.Timeout>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly pendingMutations = new Set<string>();

	public constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly getSession: () => ReviewSession | undefined,
		private readonly navigateFromReview: (type: ReviewNavigationRequestType, uri: string, line: number, column: number, requestId?: number) => Promise<ReviewNavigationResponse | undefined>,
		private readonly openNavigationTarget: (uri: string, line: number, column: number) => Promise<void>,
		private readonly onDidActivateReview?: (uri: vscode.Uri) => void,
	) {
		this.disposables.push(
			vscode.window.registerCustomEditorProvider(ReviewWebviewManager.viewType, this),
			vscode.workspace.onDidChangeTextDocument((event) => this.scheduleRefresh(event.document.uri)),
			vscode.workspace.onDidSaveTextDocument((document) => this.scheduleRefresh(document.uri)),
		);
	}

	public resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
		const key = uriKey(document.uri);
		const host: ReviewEditorHost = {
			key,
			uri: document.uri,
			document,
			panel,
			ready: false,
			stateSequence: 0,
			revealPosition: this.pendingRevealPositions.get(key),
			disposables: [],
		};
		this.pendingRevealPositions.delete(key);
		this.hosts.set(key, host);
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
		};
		panel.webview.html = this.renderShell(panel.webview);
		host.disposables.push(
			panel.onDidDispose(() => {
				for (const disposable of host.disposables) {
					disposable.dispose();
				}
				if (this.hosts.get(key) === host) {
					this.hosts.delete(key);
				}
			}),
			panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
				void this.handleMessage(host, message);
			}),
			panel.onDidChangeViewState((event) => {
				if (event.webviewPanel.active) {
					this.onDidActivateReview?.(host.uri);
				}
			}),
		);
		if (panel.active) {
			this.onDidActivateReview?.(host.uri);
		}
	}

	public async open(uri: vscode.Uri, revealPosition?: { line: number; column: number }): Promise<void> {
		const key = uriKey(uri);
		if (revealPosition) {
			this.pendingRevealPositions.set(key, revealPosition);
		}

		await vscode.commands.executeCommand('vscode.openWith', uri, ReviewWebviewManager.viewType, vscode.ViewColumn.Active);
		this.onDidActivateReview?.(uri);
		const host = this.hosts.get(key);
		if (host) {
			host.revealPosition = revealPosition;
			await this.postState(host);
		}
	}

	public refresh(uri?: vscode.Uri): void {
		if (uri) {
			const host = this.hosts.get(uriKey(uri));
			if (host) {
				void this.postState(host);
			}
			return;
		}

		for (const host of this.hosts.values()) {
			void this.postState(host);
		}
	}

	private scheduleRefresh(uri: vscode.Uri): void {
		const key = uriKey(uri);
		if (!this.hosts.has(key)) {
			return;
		}

		const existing = this.refreshTimers.get(key);
		if (existing) {
			clearTimeout(existing);
		}

		this.refreshTimers.set(key, setTimeout(() => {
			this.refreshTimers.delete(key);
			this.refresh(uri);
		}, 50));
	}

	public dispose(): void {
		for (const timer of this.refreshTimers.values()) {
			clearTimeout(timer);
		}
		this.refreshTimers.clear();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		for (const host of this.hosts.values()) {
			host.panel.dispose();
		}
		this.hosts.clear();
	}

	private async handleMessage(host: ReviewEditorHost, message: WebviewMessage): Promise<void> {
		if (message.type === 'ready') {
			host.ready = true;
			await this.postState(host);
			return;
		}

		if (message.type === 'accept' || message.type === 'reject' || message.type === 'restore') {
			const mutationKey = `${message.uri}::${message.hunkId}`;
			if (this.pendingMutations.has(mutationKey)) {
				return;
			}

			this.pendingMutations.add(mutationKey);
			try {
				if (message.type === 'accept') {
					await vscode.commands.executeCommand('cli-diff.acceptChange', message.uri, message.hunkId, message.revision);
				} else if (message.type === 'reject') {
					await vscode.commands.executeCommand('cli-diff.rejectChange', message.uri, message.hunkId, message.revision);
				} else {
					await vscode.commands.executeCommand('cli-diff.restoreChange', message.uri, message.hunkId, message.revision);
				}
			} finally {
				this.pendingMutations.delete(mutationKey);
			}
		} else if (message.type === 'applyTextEdits') {
			await this.enqueueTextEdit(host.key, () => this.applyTextEdits(host, message));
			return;
		} else if (message.type === 'saveCurrentDocument') {
			await this.saveDocument(host, message.uri);
			return;
		} else if (message.type === 'clipboardRead') {
			await host.panel.webview.postMessage({
				type: 'clipboardReadResult',
				requestId: message.requestId,
				text: await vscode.env.clipboard.readText(),
			});
			return;
		} else if (message.type === 'clipboardWrite') {
			await vscode.env.clipboard.writeText(message.text);
			await host.panel.webview.postMessage({
				type: 'clipboardWriteResult',
				requestId: message.requestId,
			});
			return;
		} else if (message.type === 'resolveNavigationAction') {
			const response = await this.navigateFromReview(message.type, message.uri, message.line, message.column, message.requestId);
			if (response) {
				await host.panel.webview.postMessage(response);
			}
			return;
		} else if (message.type === 'openNavigationTarget') {
			await this.openNavigationTarget(message.uri, message.line, message.column);
		} else if (message.type === 'goToDefinition' || message.type === 'findReferences' || message.type === 'smartNavigate') {
			const response = await this.navigateFromReview(message.type, message.uri, message.line, message.column);
			if (response) {
				await host.panel.webview.postMessage(response);
			}
		}

		await this.postState(host);
	}

	private async postState(host: ReviewEditorHost): Promise<void> {
		if (!host.ready) {
			return;
		}

		const file = this.getSession()?.files.get(host.key);
		if (!file) {
			return;
		}

		host.panel.title = `Review: ${file.relativePath}`;
		const payload = this.serialize(file, host.document, host.revealPosition);
		const sequence = ++host.stateSequence;
		const delivered = await host.panel.webview.postMessage({ type: 'state', sequence, file: payload });
		if (delivered) {
			host.revealPosition = undefined;
		}
	}

	private serialize(file: ReviewFileState, document: vscode.TextDocument, revealPosition?: { line: number; column: number }): ReviewWebviewPayload {
		return {
			uri: file.uri.toString(),
			relativePath: file.relativePath,
			oldText: file.oldText,
			newText: document.getText(),
			revision: file.revision,
			dirty: document.isDirty,
			languageId: languageIdFromPath(file.relativePath),
			pendingHunks: file.hunks,
			acceptedHunks: file.acceptedHunks,
			rejectedHunks: file.rejectedHunks,
			skippedReason: file.skippedReason,
			revealLine: revealPosition?.line,
			revealColumn: revealPosition?.column,
		};
	}

	private async applyTextEdits(host: ReviewEditorHost, message: Extract<WebviewMessage, { type: 'applyTextEdits' }>): Promise<void> {
		const document = this.documentForUri(message.uri) ?? host.document;
		const uri = document.uri;
		const edit = new vscode.WorkspaceEdit();
		for (const change of message.edits) {
			edit.replace(uri, new vscode.Range(
				new vscode.Position(Math.max(0, change.range.startLine), Math.max(0, change.range.startColumn)),
				new vscode.Position(Math.max(0, change.range.endLine), Math.max(0, change.range.endColumn)),
			), change.text);
		}

		const applied = await vscode.workspace.applyEdit(edit);
		if (!applied || document.getText() !== message.text) {
			const fallback = new vscode.WorkspaceEdit();
			const fullRange = new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length));
			fallback.replace(uri, fullRange, message.text);
			const fallbackApplied = await vscode.workspace.applyEdit(fallback);
			if (!fallbackApplied) {
				throw new Error('VS Code rejected the review editor edit.');
			}
		}
	}

	private async saveDocument(host: ReviewEditorHost, uriString: string): Promise<void> {
		const document = this.documentForUri(uriString) ?? host.document;
		await document.save();
	}

	private async enqueueTextEdit(key: string, operation: () => Promise<void>): Promise<void> {
		const previous = this.textEditQueues.get(key) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(operation);
		this.textEditQueues.set(key, current);
		try {
			await current;
		} finally {
			if (this.textEditQueues.get(key) === current) {
				this.textEditQueues.delete(key);
			}
		}
	}

	private documentForUri(uriString: string): vscode.TextDocument | undefined {
		return vscode.workspace.textDocuments.find((document) => document.uri.toString() === uriString);
	}

	private renderShell(webview: vscode.Webview): string {
		const nonce = createNonce();
		const loaderUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'monaco', 'vs', 'loader.js'));
		const monacoBaseUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'monaco', 'vs')).toString();
		const cspSource = webview.cspSource;

		return `<!DOCTYPE html>
<html lang="en">
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
			--reject-bg: rgba(248, 81, 73, 0.14);
			--reject-border: rgba(248, 81, 73, 0.38);
			--reject-fg: #ff938a;
			--accept-bg: rgba(46, 160, 67, 0.16);
			--accept-border: rgba(46, 160, 67, 0.42);
			--accept-fg: #7ee787;
			--undo-bg: rgba(88, 166, 255, 0.14);
			--undo-border: rgba(88, 166, 255, 0.40);
			--undo-fg: #79c0ff;
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
			--reject-bg: rgba(209, 36, 47, 0.11);
			--reject-border: rgba(209, 36, 47, 0.35);
			--reject-fg: #b4232f;
			--accept-bg: rgba(46, 160, 67, 0.12);
			--accept-border: rgba(46, 160, 67, 0.35);
			--accept-fg: #1f7a3d;
			--undo-bg: rgba(9, 105, 218, 0.12);
			--undo-border: rgba(9, 105, 218, 0.35);
			--undo-fg: #0969da;
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
			grid-template-rows: 1fr 24px;
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
		.cli-references-zone {
			height: 100%;
			display: flex;
			flex-direction: column;
			border: 1px solid var(--border);
			border-radius: 5px;
			background: var(--bg);
			box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
			overflow: hidden;
		}
		.cli-references-zone.above {
			border-bottom-color: var(--vscode-focusBorder);
		}
		.cli-references-zone.below {
			border-top-color: var(--vscode-focusBorder);
		}
		.cli-references-header {
			height: 30px;
			flex: none;
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 0 12px;
			border-bottom: 1px solid var(--border);
			background: var(--zone-bg);
			color: var(--fg);
			font-size: 12px;
		}
		.cli-references-title {
			font-weight: 600;
			margin-right: auto;
		}
		.cli-references-count {
			color: var(--muted);
		}
		.cli-references-list {
			flex: 1;
			min-height: 0;
			overflow: auto;
			padding: 0;
		}
		.cli-reference-item {
			width: 100%;
			height: 26px;
			display: grid;
			grid-template-columns: minmax(180px, 0.42fr) minmax(120px, 1fr) auto;
			align-items: center;
			gap: 12px;
			padding: 0 12px;
			border: 0;
			border-radius: 0;
			background: transparent;
			color: var(--fg);
			text-align: left;
			cursor: pointer;
			font-family: var(--vscode-font-family);
			line-height: 18px;
		}
		.cli-reference-item:hover {
			background: var(--button-bg);
		}
		.cli-reference-location {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			color: var(--fg);
		}
		.cli-reference-preview {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			color: var(--muted);
			font-family: var(--vscode-editor-font-family);
		}
		.cli-reference-badge {
			border: 1px solid var(--border);
			border-radius: 3px;
			padding: 0 6px;
			color: var(--muted);
			font-size: 11px;
			line-height: 16px;
		}
		.cli-reference-badge.review {
			border-color: var(--accept-border);
			color: var(--accept-fg);
		}
		.cli-references-empty {
			padding: 10px 12px;
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
		.cli-link-hover {
			text-decoration: underline;
			cursor: pointer;
		}
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
			overflow: visible;
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
			overflow: visible;
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
			padding-right: 12px;
		}
		.cli-actions {
			display: flex;
			gap: 6px;
			flex: none;
			position: relative;
			z-index: 8;
			transform: translateX(var(--cli-action-shift, 0px));
			will-change: transform;
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
		button:hover {
			background: var(--button-hover);
		}
		button:disabled {
			cursor: default;
			opacity: 0.55;
		}
		button:disabled:hover {
			background: var(--button-bg);
		}
		button.action-reject {
			background: var(--reject-bg);
			border-color: var(--reject-border);
			color: var(--reject-fg);
		}
		button.action-reject:hover {
			background: color-mix(in srgb, var(--reject-bg) 70%, var(--reject-fg) 30%);
		}
		button.action-accept {
			background: var(--accept-bg);
			border-color: var(--accept-border);
			color: var(--accept-fg);
		}
		button.action-accept:hover {
			background: color-mix(in srgb, var(--accept-bg) 70%, var(--accept-fg) 30%);
		}
		button.action-undo {
			background: var(--undo-bg);
			border-color: var(--undo-border);
			color: var(--undo-fg);
		}
		button.action-undo:hover {
			background: color-mix(in srgb, var(--undo-bg) 70%, var(--undo-fg) 30%);
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
	<div id="editor"></div>
	<div id="status">0 pending &middot; 0 reviewed</div>
	<script nonce="${nonce}" src="${loaderUri}"></script>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const monacoBaseUri = ${JSON.stringify(monacoBaseUri)};
		const labels = {
			accept: 'Accept',
			reject: 'Reject',
			undo: 'Undo',
			previous: 'Prev',
			next: 'Next',
			add: 'Add',
			delete: 'Delete',
			modify: 'modify',
			accepted: 'Accepted',
			rejected: 'Rejected',
			noData: '0 pending \\u00b7 0 reviewed',
			goToDefinition: 'Go to Definition',
			findReferences: 'Find References',
			references: 'References',
			noReferences: 'No references found.',
			copy: 'Copy',
			cut: 'Cut',
			paste: 'Paste',
		};

		let editor;
		let model;
		let changeDisposable;
		let state;
		let ready = false;
		let dirty = false;
		let applyingState = false;
		let lineDecorations = [];
		let zoneIds = [];
		let hunkEntries = [];
		let activeHunkId;
		let pendingMutationKey;
		let navigationModifierDown = false;
		let lastMousePosition;
		let linkDecorationIds = [];
		let navigationHoverRequestId = 0;
		let navigationHoverKey;
		let navigationHoverRange;
		let navigationHoverAction = 'goToDefinition';
		let navigationHoverTimer;
		let referencesZoneId;
		let referencesAnchorPosition;
		let clipboardRequestId = 0;
		let lastStateSequence = 0;
		const clipboardRequests = new Map();

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
			if (event.data.type === 'state') {
				const sequence = Number(event.data.sequence) || 0;
				if (sequence && sequence < lastStateSequence) {
					return;
				}
				lastStateSequence = Math.max(lastStateSequence, sequence);
				setState(event.data.file);
				return;
			}
			if (event.data.type === 'navigationAction') {
				applyNavigationAction(event.data);
				return;
			}
			if (event.data.type === 'references') {
				renderReferences(event.data);
				return;
			}
			if (event.data.type === 'clipboardReadResult' || event.data.type === 'clipboardWriteResult') {
				resolveClipboardRequest(event.data);
			}
		});

		window.addEventListener('resize', function () {
			if (editor) {
				editor.layout();
			}
		});
		window.addEventListener('keydown', onWindowKeyDown);
		window.addEventListener('keyup', onWindowKeyUp);
		window.addEventListener('blur', clearNavigationHover);
		document.addEventListener('pointerdown', stopToolbarPointer, true);
		document.addEventListener('mousedown', stopToolbarPointer, true);
		document.addEventListener('click', onToolbarClick, true);
		document.addEventListener('click', onReferencesClick, true);

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
			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyC, function () { void copySelection(); });
			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyX, function () { void cutSelection(); });
			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV, function () { void pasteSelection(); });
			editor.addCommand(monaco.KeyCode.F12, function () { requestNavigation('goToDefinition'); });
			editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F12, function () { requestNavigation('findReferences'); });
			editor.addAction({
				id: 'cli-diff-copy',
				label: labels.copy,
				contextMenuGroupId: '9_cutcopypaste',
				contextMenuOrder: 1,
				run: copySelection,
			});
			editor.addAction({
				id: 'cli-diff-cut',
				label: labels.cut,
				contextMenuGroupId: '9_cutcopypaste',
				contextMenuOrder: 2,
				run: cutSelection,
			});
			editor.addAction({
				id: 'cli-diff-paste',
				label: labels.paste,
				contextMenuGroupId: '9_cutcopypaste',
				contextMenuOrder: 3,
				run: pasteSelection,
			});
			editor.addAction({
				id: 'cli-diff-go-to-definition',
				label: 'Go to Definition',
				contextMenuGroupId: 'navigation',
				contextMenuOrder: 1,
				run: function () { requestNavigation('goToDefinition'); },
			});
			editor.addAction({
				id: 'cli-diff-find-references',
				label: 'Find References',
				contextMenuGroupId: 'navigation',
				contextMenuOrder: 2,
				run: function () { requestNavigation('findReferences'); },
			});
			editor.onMouseDown(function (event) {
				if (!event.target.position || event.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) {
					return;
				}
				if (event.event.ctrlKey || event.event.metaKey) {
					const wordRange = wordRangeAt(event.target.position);
					if (!wordRange) {
						return;
					}
					if (event.event.preventDefault) {
						event.event.preventDefault();
					}
					requestNavigation('smartNavigate', event.target.position);
				}
			});
			editor.onContextMenu(function (event) {
				const position = contentTextPosition(event);
				if (position) {
					editor.setPosition(position);
				}
			});
			editor.onMouseMove(function (event) {
				const position = contentTextPosition(event);
				lastMousePosition = position;
				if (isNavigationModifierActive(event.event)) {
					updateNavigationHover(position);
				} else {
					clearNavigationHover();
				}
			});
			editor.onMouseLeave(function () {
				lastMousePosition = undefined;
				clearNavigationHover();
			});
			editor.onDidScrollChange(updateActionOffset);
			editor.onDidLayoutChange(updateActionOffset);
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
					'editor.selectionBackground': '#8b949e55',
					'editor.inactiveSelectionBackground': '#8b949e33',
					'editor.selectionHighlightBackground': '#8b949e22',
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
					'editor.selectionBackground': '#8c8c8c44',
					'editor.inactiveSelectionBackground': '#8c8c8c24',
					'editor.selectionHighlightBackground': '#8c8c8c1f',
					'editor.lineHighlightBackground': cssVar('--vscode-editor-lineHighlightBackground') || '#f0f0f0',
				},
			});
		}

		function setState(nextState) {
			if (state?.uri && state.uri !== nextState.uri) {
				hideReferences();
			}
			state = nextState;
			dirty = Boolean(state.dirty);
			pendingMutationKey = undefined;
			if (!ready) {
				return;
			}
			applyState();
		}

		function applyState() {
			if (!editor || !state) {
				statusNode.textContent = labels.noData;
				return;
			}

			updateFooter();

			if (!model) {
				model = monaco.editor.createModel(state.newText, state.languageId || 'plaintext', monaco.Uri.parse('cli-diff-review-current:///' + encodeURIComponent(state.relativePath)));
				editor.setModel(model);
				changeDisposable = model.onDidChangeContent(onModelChanged);
			} else {
				monaco.editor.setModelLanguage(model, state.languageId || 'plaintext');
				if (model.getValue() !== state.newText) {
					applyingState = true;
					model.setValue(state.newText);
					applyingState = false;
				}
			}

			renderInlineDiff();
			revealStatePosition();
		}

		function onModelChanged(event) {
			if (applyingState) {
				return;
			}
			dirty = true;
			vscode.postMessage({
				type: 'applyTextEdits',
				uri: state.uri,
				edits: event.changes.map(function (change) {
					return {
						range: {
							startLine: Math.max(0, change.range.startLineNumber - 1),
							startColumn: Math.max(0, change.range.startColumn - 1),
							endLine: Math.max(0, change.range.endLineNumber - 1),
							endColumn: Math.max(0, change.range.endColumn - 1),
						},
						text: change.text,
					};
				}),
				text: model.getValue(),
			});
			setMutationButtonsDisabled(true);
			updateFooter();
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
						afterLineNumber: Math.max(0, entry.zoneAfterLineNumber),
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
			updateActionOffset();
		}

		function revealStatePosition() {
			if (!editor || !state || typeof state.revealLine !== 'number') {
				return;
			}
			const lineNumber = Math.max(1, state.revealLine + 1);
			const column = Math.max(1, (state.revealColumn ?? 0) + 1);
			editor.revealLineInCenter(lineNumber);
			editor.setPosition({ lineNumber, column });
			editor.focus();
		}

		function updateFooter() {
			if (!state) {
				statusNode.textContent = labels.noData;
				return;
			}
			if (state.skippedReason) {
				statusNode.textContent = 'Skipped: ' + state.skippedReason;
				return;
			}
			const reviewedCount = state.acceptedHunks.length + state.rejectedHunks.length;
			statusNode.textContent = state.pendingHunks.length + ' pending \\u00b7 ' + reviewedCount + ' reviewed';
		}

		function updateActionOffset() {
			if (!editor) {
				return;
			}
			const layout = editor.getLayoutInfo();
			const visibleWidth = layout.contentWidth || layout.width || 0;
			const scrollWidth = editor.getScrollWidth ? editor.getScrollWidth() : visibleWidth;
			const scrollLeft = editor.getScrollLeft() || 0;
			const shift = Math.min(0, scrollLeft + visibleWidth - scrollWidth - 12);
			editorNode.style.setProperty('--cli-action-shift', shift + 'px');
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
					zoneAfterLineNumber: hunk.zoneAfterLineNumber,
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
					zoneAfterLineNumber: hunk.zoneAfterLineNumber,
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
					zoneAfterLineNumber: hunk.zoneAfterLineNumber,
					oldLinesToShow: [],
					state: 'rejected',
					decided: true,
					source: hunk.reviewSource,
				};
			});

			return pending.concat(accepted, rejected).sort(function (left, right) {
				if (left.zoneAfterLineNumber === right.zoneAfterLineNumber) {
					return Number(left.decided) - Number(right.decided);
				}
				return left.zoneAfterLineNumber - right.zoneAfterLineNumber;
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
				? reviewedLabel(entry.source) + ' \\u00b7 ' + kindLabel(entry.kind) + ' ' + entry.oldLines + '->' + entry.newLines + ' lines'
				: kindLabel(entry.kind) + ' ' + entry.oldLines + '->' + entry.newLines + ' lines';
			header.appendChild(summary);

			const actions = document.createElement('div');
			actions.className = 'cli-actions';
			header.appendChild(actions);

			if (!entry.decided) {
				actions.appendChild(createButton(labels.reject, 'reject', entry));
				actions.appendChild(createButton(labels.accept, 'accept', entry));
			} else if (entry.source === 'accept' || entry.source === 'reject') {
				actions.appendChild(createButton(labels.undo, 'restore', entry));
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

		function createButton(label, command, entry) {
			const button = document.createElement('button');
			button.textContent = label;
			button.type = 'button';
			button.dataset.command = command;
			button.dataset.hunkId = entry.id;
			button.className = buttonClass(command);
			button.disabled = Boolean((isMutationCommand(command) && (dirty || pendingMutationKey)) || (isNavigationCommand(command) && hunkEntries.length <= 1));
			return button;
		}

		function stopToolbarPointer(event) {
			if (closestElement(event.target, '.cli-hunk-zone button') || closestElement(event.target, '.cli-references-zone button')) {
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

			if (isNavigationCommand(command) && hunkEntries.length <= 1) {
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
			if (isMutationCommand(command)) {
				const mutationKey = command + '::' + hunkId;
				if (pendingMutationKey) {
					return;
				}
				pendingMutationKey = mutationKey;
				setMutationButtonsDisabled(true);
			}
			if (dirty) {
				pendingMutationKey = undefined;
				setMutationButtonsDisabled(true);
				updateFooter();
				return;
			}
			vscode.postMessage({ type: command, uri: state.uri, hunkId, revision: state.revision });
		}

		function renderReferences(message) {
			if (!editor) {
				return;
			}
			const targets = message.targets || [];
			const anchor = referencesAnchorPosition || editor.getPosition() || { lineNumber: 1, column: 1 };
			const placement = referencesPlacement(anchor);
			const visibleRows = Math.min(Math.max(targets.length, 1), 8);
			const headerHeight = 30;
			const listVerticalPadding = 0;
			const rowHeight = 26;
			const heightInPx = Math.min(320, headerHeight + listVerticalPadding + (visibleRows * rowHeight) + 2);
			const node = createReferencesZone(message, targets, placement);

			editor.changeViewZones(function (accessor) {
				if (referencesZoneId) {
					accessor.removeZone(referencesZoneId);
				}
				const afterLineNumber = placement === 'above'
					? Math.max(0, anchor.lineNumber - 1)
					: Math.max(0, anchor.lineNumber);
				referencesZoneId = accessor.addZone({
					afterLineNumber,
					heightInPx,
					domNode: node,
				});
			});
			editor.revealLineInCenter(anchor.lineNumber);
			editor.layout();
		}

		function createReferencesZone(message, targets, placement) {
			const node = document.createElement('section');
			node.className = 'cli-references-zone ' + placement;
			node.setAttribute('aria-label', 'References');

			const header = document.createElement('div');
			header.className = 'cli-references-header';
			node.appendChild(header);

			const title = document.createElement('span');
			title.className = 'cli-references-title';
			title.textContent = message.title || labels.references;
			header.appendChild(title);

			const count = document.createElement('span');
			count.className = 'cli-references-count';
			count.textContent = targets.length + (targets.length === 1 ? ' result' : ' results');
			header.appendChild(count);

			const close = document.createElement('button');
			close.type = 'button';
			close.dataset.referenceClose = 'true';
			close.textContent = 'Close';
			header.appendChild(close);

			const list = document.createElement('div');
			list.className = 'cli-references-list';
			node.appendChild(list);

			if (targets.length === 0) {
				const empty = document.createElement('div');
				empty.className = 'cli-references-empty';
				empty.textContent = labels.noReferences;
				list.appendChild(empty);
			} else {
				for (const target of targets) {
					list.appendChild(createReferenceItem(target));
				}
			}
			return node;
		}

		function referencesPlacement(anchor) {
			const visibleRanges = editor.getVisibleRanges();
			const visible = visibleRanges.length > 0 ? visibleRanges[0] : undefined;
			if (!visible) {
				return 'below';
			}
			const middle = (visible.startLineNumber + visible.endLineNumber) / 2;
			return anchor.lineNumber > middle ? 'above' : 'below';
		}

		function createReferenceItem(target) {
			const item = document.createElement('button');
			item.type = 'button';
			item.className = 'cli-reference-item';
			item.dataset.uri = target.uri;
			item.dataset.line = String(target.line);
			item.dataset.column = String(target.column);

			const location = document.createElement('span');
			location.className = 'cli-reference-location';
			location.textContent = target.label;
			item.appendChild(location);

			const preview = document.createElement('span');
			preview.className = 'cli-reference-preview';
			preview.textContent = target.preview || target.description || '';
			item.appendChild(preview);

			const badge = document.createElement('span');
			badge.className = 'cli-reference-badge' + (target.reviewable ? ' review' : '');
			badge.textContent = target.currentFile || target.reviewable ? 'Review' : 'Editor';
			item.appendChild(badge);

			return item;
		}

		function onReferencesClick(event) {
			if (closestElement(event.target, '[data-reference-close]')) {
				event.preventDefault();
				event.stopPropagation();
				hideReferences();
				return;
			}

			const item = closestElement(event.target, '.cli-reference-item[data-uri]');
			if (!item) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			vscode.postMessage({
				type: 'openNavigationTarget',
				uri: item.dataset.uri,
				line: Number(item.dataset.line) || 0,
				column: Number(item.dataset.column) || 0,
			});
		}

		function hideReferences() {
			if (!editor || !referencesZoneId) {
				referencesZoneId = undefined;
				return;
			}
			editor.changeViewZones(function (accessor) {
				if (referencesZoneId) {
					accessor.removeZone(referencesZoneId);
				}
				referencesZoneId = undefined;
			});
			editor.layout();
		}

		function requestNavigation(type, position) {
			if (!state || !model || !editor) {
				return;
			}
			const target = position || editor.getPosition();
			if (!target) {
				return;
			}
			if (type === 'findReferences' || type === 'smartNavigate') {
				referencesAnchorPosition = target;
			}
			vscode.postMessage({
				type,
				uri: state.uri,
				line: Math.max(0, target.lineNumber - 1),
				column: Math.max(0, target.column - 1),
			});
		}

		function requestNavigationAction(position) {
			if (!state || !model) {
				return;
			}
			const target = position || editor?.getPosition();
			if (!target) {
				return;
			}
			const requestId = ++navigationHoverRequestId;
			window.clearTimeout(navigationHoverTimer);
			navigationHoverTimer = window.setTimeout(function () {
				vscode.postMessage({
					type: 'resolveNavigationAction',
					uri: state.uri,
					line: Math.max(0, target.lineNumber - 1),
					column: Math.max(0, target.column - 1),
					requestId,
				});
			}, 180);
		}

		function applyNavigationAction(message) {
			if (message.requestId !== navigationHoverRequestId) {
				return;
			}
			navigationHoverAction = message.action || 'goToDefinition';
			applyNavigationHoverDecoration(message.label || navigationActionLabel(navigationHoverAction));
		}

		function onWindowKeyDown(event) {
			if (event.key === 'Control' || event.key === 'Meta') {
				navigationModifierDown = true;
				updateNavigationHover(lastMousePosition);
			}
		}

		function onWindowKeyUp(event) {
			if (event.key === 'Control' || event.key === 'Meta') {
				navigationModifierDown = Boolean(event.ctrlKey || event.metaKey);
				if (navigationModifierDown) {
					updateNavigationHover(lastMousePosition);
				} else {
					clearNavigationHover(true);
				}
			}
		}

		function isNavigationModifierActive(event) {
			return Boolean(navigationModifierDown || event?.ctrlKey || event?.metaKey);
		}

		function contentTextPosition(event) {
			if (!event.target.position || event.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) {
				return undefined;
			}
			return event.target.position;
		}

		function wordRangeAt(position) {
			if (!model || !position) {
				return undefined;
			}
			const word = model.getWordAtPosition(position);
			if (!word) {
				return undefined;
			}
			return new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
		}

		function updateNavigationHover(position) {
			if (!editor || !state || !position) {
				clearNavigationHover();
				return;
			}
			const range = wordRangeAt(position);
			if (!range) {
				clearNavigationHover();
				return;
			}
			const key = state.uri + ':' + range.startLineNumber + ':' + range.startColumn + ':' + range.endColumn;
			if (key !== navigationHoverKey) {
				navigationHoverKey = key;
				navigationHoverRange = range;
				navigationHoverAction = 'goToDefinition';
				requestNavigationAction(position);
			} else {
				navigationHoverRange = range;
			}
			applyNavigationHoverDecoration(navigationActionLabel(navigationHoverAction));
		}

		function applyNavigationHoverDecoration(label) {
			if (!editor || !navigationHoverRange) {
				return;
			}
			linkDecorationIds = editor.deltaDecorations(linkDecorationIds, [{
				range: navigationHoverRange,
				options: {
					inlineClassName: 'cli-link-hover',
					hoverMessage: { value: label },
				},
			}]);
		}

		function navigationActionLabel(action) {
			return action === 'findReferences' ? labels.findReferences : labels.goToDefinition;
		}

		function clearNavigationHover(resetModifier) {
			window.clearTimeout(navigationHoverTimer);
			if (editor && linkDecorationIds.length > 0) {
				linkDecorationIds = editor.deltaDecorations(linkDecorationIds, []);
			} else {
				linkDecorationIds = [];
			}
			navigationHoverKey = undefined;
			navigationHoverRange = undefined;
			navigationHoverAction = 'goToDefinition';
			if (resetModifier) {
				navigationModifierDown = false;
			}
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

		function copySelection() {
			if (!model || !editor) {
				return Promise.resolve();
			}
			const text = selectedText();
			if (!text) {
				return Promise.resolve();
			}
			return writeClipboard(text);
		}

		async function cutSelection() {
			if (!model || !editor) {
				return;
			}
			const selections = editor.getSelections() || [];
			if (selections.length === 0 || selections.every(function (selection) { return selection.isEmpty(); })) {
				return;
			}
			await writeClipboard(selectedText());
			editor.executeEdits('clipboard', selections.map(function (selection) {
				return { range: selection, text: '', forceMoveMarkers: true };
			}));
			editor.pushUndoStop();
		}

		async function pasteSelection() {
			if (!model || !editor) {
				return;
			}
			const text = await readClipboard();
			if (!text) {
				return;
			}
			const selections = editor.getSelections() || [editor.getSelection()];
			editor.executeEdits('clipboard', selections.filter(Boolean).map(function (selection) {
				return { range: selection, text, forceMoveMarkers: true };
			}));
			editor.pushUndoStop();
		}

		function selectedText() {
			if (!model || !editor) {
				return '';
			}
			const selections = editor.getSelections() || [];
			if (selections.length === 0 || selections.every(function (selection) { return selection.isEmpty(); })) {
				return '';
			}
			return selections.map(function (selection) {
				return model.getValueInRange(selection);
			}).join(model.getEOL());
		}

		function readClipboard() {
			return requestClipboard('clipboardRead').then(function (message) {
				return message.text || '';
			});
		}

		function writeClipboard(text) {
			return requestClipboard('clipboardWrite', { text });
		}

		function requestClipboard(type, payload) {
			const requestId = ++clipboardRequestId;
			return new Promise(function (resolve) {
				clipboardRequests.set(requestId, resolve);
				vscode.postMessage(Object.assign({ type, requestId }, payload || {}));
			});
		}

		function resolveClipboardRequest(message) {
			const resolve = clipboardRequests.get(message.requestId);
			if (!resolve) {
				return;
			}
			clipboardRequests.delete(message.requestId);
			resolve(message);
		}

		function saveCurrent() {
			if (!state || !model) {
				return;
			}
			vscode.postMessage({
				type: 'saveCurrentDocument',
				uri: state.uri,
			});
			updateFooter();
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

		function kindLabel(kind) {
			if (kind === 'add') {
				return labels.add;
			}
			if (kind === 'delete') {
				return labels.delete;
			}
			return labels.modify;
		}

		function buttonClass(command) {
			if (command === 'reject') {
				return 'action-reject';
			}
			if (command === 'accept') {
				return 'action-accept';
			}
			if (command === 'restore') {
				return 'action-undo';
			}
			return 'action-nav';
		}

		function isMutationCommand(command) {
			return command === 'accept' || command === 'reject' || command === 'restore';
		}

		function isNavigationCommand(command) {
			return command === 'previous' || command === 'next';
		}

		function setMutationButtonsDisabled(disabled) {
			for (const button of document.querySelectorAll('button[data-command]')) {
				if (isMutationCommand(button.dataset.command)) {
					button.disabled = disabled;
				}
			}
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
