import * as path from 'path';
import * as vscode from 'vscode';
import type { LlmProvider } from './llm/config';
import { ReviewFileState, ReviewSession, uriKey } from './types';

type DashboardMessage =
	| { type: 'ready' }
	| { type: 'refresh' }
	| { type: 'open'; uri: string }
	| { type: 'acceptFile'; uri: string }
	| { type: 'rejectFile'; uri: string }
	| { type: 'undoFile'; uri: string }
	| { type: 'saveLlmConfig'; provider: LlmProvider; baseUrl: string; model: string; apiKey: string }
	| { type: 'initializeWiki' }
	| { type: 'cancelWikiInitialization' };

export interface ReviewDashboardFile {
	uri: string;
	relativePath: string;
	fileExtension: string;
	description: string;
	statusLabel: string;
	statusKind: 'modified' | 'untracked' | 'deleted' | 'skipped';
	pendingCount: number;
	reviewedCount: number;
	skippedReason?: string;
	dirty: boolean;
	active: boolean;
	acceptDisabled: boolean;
	rejectDisabled: boolean;
	undoDisabled: boolean;
}

export interface ReviewDashboardPayload {
	currentReviewUri?: string;
	currentReviewLabel?: string;
	changeSignature: string;
	files: ReviewDashboardFile[];
	llmWiki?: LlmWikiDashboardState;
}

export type LlmWikiStatus = 'unconfigured' | 'idle' | 'initializing' | 'initialized' | 'paused' | 'failed';

export interface LlmWikiDashboardState {
	configured: boolean;
	provider: LlmProvider;
	baseUrl: string;
	model: string;
	hasApiKey: boolean;
	status: LlmWikiStatus;
	wikiExists: boolean;
	workspaceAvailable: boolean;
	progress?: string;
	error?: string;
}

export class ReviewDashboardProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	public static readonly viewType = 'cli-diff.dashboard';

	private view: vscode.WebviewView | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	public constructor(
		private readonly getPayload: () => ReviewDashboardPayload,
		private readonly executeCommand = vscode.commands.executeCommand,
	) {}

	public dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	public resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..', 'resources')],
		};
		view.webview.html = this.renderShell(view.webview);
		this.disposables.push(view.webview.onDidReceiveMessage((message: DashboardMessage) => {
			void this.handleMessage(message);
		}));
		this.postState();
	}

	public refresh(): void {
		this.postState();
	}

	private postState(): void {
		if (!this.view) {
			return;
		}
		const payload = this.getPayload();
		this.view.title = dashboardTitleFile(payload.currentReviewLabel);
		void this.view.webview.postMessage({ type: 'state', payload });
	}

	private async handleMessage(message: DashboardMessage): Promise<void> {
		if (message.type === 'ready') {
			this.postState();
			return;
		}
		if (message.type === 'refresh') {
			await this.executeCommand('cli-diff.refresh');
			this.postState();
			return;
		}
		if (message.type === 'open') {
			await this.executeCommand('cli-diff.openReviewView', message.uri);
			this.postState();
			return;
		}
		if (message.type === 'acceptFile') {
			await this.executeCommand('cli-diff.acceptFile', message.uri);
			this.postState();
			return;
		}
		if (message.type === 'rejectFile') {
			await this.executeCommand('cli-diff.rejectFile', message.uri);
			this.postState();
			return;
		}
		if (message.type === 'undoFile') {
			await this.executeCommand('cli-diff.undoFile', message.uri);
			this.postState();
			return;
		}
		if (message.type === 'saveLlmConfig') {
			await this.executeCommand('cli-diff.saveLlmWikiConfig', {
				provider: message.provider,
				baseUrl: message.baseUrl,
				model: message.model,
				apiKey: message.apiKey,
			});
			this.postState();
			return;
		}
		if (message.type === 'initializeWiki') {
			await this.executeCommand('cli-diff.initializeLlmWiki');
			this.postState();
			return;
		}
		if (message.type === 'cancelWikiInitialization') {
			await this.executeCommand('cli-diff.cancelLlmWikiInitialization');
			this.postState();
		}
	}

	private renderShell(webview: vscode.Webview): string {
		const nonce = String(Date.now());
		const iconFile = vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..', 'resources', 'icon.svg');
		const iconUri = typeof webview.asWebviewUri === 'function' ? webview.asWebviewUri(iconFile).toString() : '';
		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		:root {
			color-scheme: light dark;
			--tree-header-bg: var(--vscode-sideBarSectionHeader-background, var(--vscode-sideBar-background));
			--tree-border: var(--vscode-sideBarSectionHeader-border, var(--vscode-sideBar-border));
			--row-hover: var(--vscode-list-hoverBackground);
			--row-active: var(--vscode-list-inactiveSelectionBackground);
			--muted: var(--vscode-descriptionForeground);
			--accent: var(--vscode-focusBorder);
			--modified: var(--vscode-gitDecoration-modifiedResourceForeground);
			--untracked: var(--vscode-gitDecoration-untrackedResourceForeground);
			--deleted: var(--vscode-gitDecoration-deletedResourceForeground);
			--skipped: var(--vscode-descriptionForeground);
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			min-height: 100vh;
			color: var(--vscode-sideBar-foreground);
			background: var(--vscode-sideBar-background);
			font: var(--vscode-font-size) var(--vscode-font-family);
		}
		button {
			font: inherit;
			color: inherit;
			background: transparent;
			border: 1px solid transparent;
			border-radius: 3px;
			padding: 0;
			cursor: pointer;
		}
		button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
		button:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
		button:disabled { opacity: .45; cursor: default; }
		.shell {
			min-height: 100vh;
			display: flex;
			flex-direction: column;
			padding: 0;
		}
		.wiki-panel {
			flex: 1 1 auto;
			min-height: 168px;
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 12px 8px;
			color: var(--vscode-sideBar-foreground);
		}
		.wiki-config,
		.wiki-main {
			width: 100%;
			max-width: 260px;
			display: flex;
			flex-direction: column;
			align-items: stretch;
			gap: 7px;
		}
		.wiki-config[hidden],
		.wiki-main[hidden],
		.model-pill[hidden],
		.wiki-logo[hidden] { display: none; }
		.wiki-field {
			display: flex;
			flex-direction: column;
			gap: 3px;
		}
		.wiki-field label {
			color: var(--muted);
			font-size: 11px;
		}
		.wiki-field input,
		.wiki-field select {
			width: 100%;
			height: 24px;
			border: 1px solid var(--vscode-input-border, transparent);
			border-radius: 3px;
			padding: 2px 6px;
			color: var(--vscode-input-foreground);
			background: var(--vscode-input-background);
			font: inherit;
		}
		.wiki-field input:focus,
		.wiki-field select:focus {
			outline: 1px solid var(--accent);
			outline-offset: -1px;
		}
		.wiki-action,
		.wiki-save {
			min-height: 26px;
			padding: 3px 8px;
			border-color: var(--vscode-button-border, transparent);
			border-radius: 6px;
			color: var(--vscode-button-foreground);
			background: var(--vscode-button-background);
		}
		.wiki-action:hover:not(:disabled),
		.wiki-save:hover:not(:disabled) {
			background: var(--vscode-button-hoverBackground);
		}
		.wiki-action.secondary {
			color: var(--vscode-sideBar-foreground);
			background: transparent;
			border-color: var(--tree-border);
		}
		.wiki-logo {
			width: 72px;
			height: 72px;
			align-self: center;
			opacity: .82;
		}
		.wiki-status {
			min-height: 16px;
			color: var(--muted);
			text-align: center;
			line-height: 1.35;
			overflow-wrap: anywhere;
		}
		.model-pill {
			max-width: 132px;
			margin-right: 3px;
			padding: 1px 5px;
			border: 1px solid var(--tree-border);
			border-radius: 6px;
			color: var(--muted);
			font-size: 10px;
			font-weight: 500;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.review-tree {
			flex: 0 0 auto;
			margin: 0;
			background: var(--vscode-sideBar-background);
			overflow: hidden;
			border: 1px solid var(--tree-border);
			border-radius: 6px;
		}
		.tree-header {
			height: 22px;
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 0 2px 0 3px;
			background: var(--tree-header-bg);
			color: var(--vscode-sideBarTitle-foreground);
			font-size: 11px;
			font-weight: 700;
		}
		.header-left {
			min-width: 0;
			display: flex;
			align-items: center;
			gap: 2px;
		}
		.header-toggle {
			min-width: 0;
			height: 20px;
			display: flex;
			align-items: center;
			gap: 2px;
			color: inherit;
		}
		.chevron {
			width: 12px;
			height: 12px;
			position: relative;
			flex: 0 0 auto;
		}
		.chevron::before {
			content: "";
			position: absolute;
			left: 3px;
			top: 3px;
			width: 5px;
			height: 5px;
			border-right: 1.5px solid currentColor;
			border-bottom: 1.5px solid currentColor;
			transform: rotate(45deg);
		}
		.review-tree.collapsed .chevron::before {
			left: 2px;
			top: 4px;
			transform: rotate(-45deg);
		}
		.tree-title {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.header-actions {
			display: flex;
			align-items: center;
			height: 20px;
		}
		.list {
			max-height: min(48vh, 420px);
			overflow: auto;
		}
		.list[hidden] { display: none; }
		.empty {
			padding: 8px 18px;
			color: var(--muted);
		}
		.file-row {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 4px;
			align-items: center;
			height: 22px;
			padding: 0 4px 0 6px;
			color: var(--vscode-sideBar-foreground);
			cursor: pointer;
			user-select: none;
		}
		.file-row:hover { background: var(--row-hover); }
		.file-row.active { background: var(--row-active); }
		.file-main {
			min-width: 0;
			display: flex;
			align-items: center;
			gap: 4px;
			overflow: hidden;
		}
		.file-icon {
			flex: 0 0 auto;
			min-width: 16px;
			max-width: 22px;
			color: var(--vscode-symbolIcon-fileForeground, var(--vscode-icon-foreground));
			font-size: 9px;
			font-weight: 700;
			letter-spacing: 0;
			text-transform: uppercase;
			text-align: center;
		}
		.path {
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.description {
			flex: 0 0 auto;
			color: var(--muted);
			white-space: nowrap;
		}
		.status {
			min-width: 12px;
			text-align: right;
			font-weight: 700;
		}
		.modified { color: var(--modified); }
		.untracked { color: var(--untracked); }
		.deleted { color: var(--deleted); }
		.skipped { color: var(--skipped); }
		.actions {
			display: none;
			align-items: center;
			gap: 1px;
			height: 20px;
		}
		.file-row:hover .status,
		.file-row.active .status { display: none; }
		.file-row:hover .actions,
		.file-row.active .actions { display: flex; }
		.icon-button,
		.refresh-button {
			width: 20px;
			height: 20px;
			padding: 0;
			display: inline-grid;
			place-items: center;
		}
		.icon-button svg,
		.refresh-button svg {
			width: 15px;
			height: 15px;
			stroke: currentColor;
			fill: none;
			stroke-width: 1.7;
			stroke-linecap: round;
			stroke-linejoin: round;
		}
	</style>
</head>
<body>
	<div class="shell">
		<section class="wiki-panel" aria-label="LLM Code Wiki">
			<form class="wiki-config" id="wikiConfig">
				<div class="wiki-field">
					<label for="llmProvider">Provider</label>
					<select id="llmProvider">
						<option value="openai">OpenAI-compatible</option>
						<option value="anthropic">Anthropic</option>
					</select>
				</div>
				<div class="wiki-field">
					<label for="llmBaseUrl">Base URL</label>
					<input id="llmBaseUrl" type="url" autocomplete="off" placeholder="https://api.openai.com/v1">
				</div>
				<div class="wiki-field">
					<label for="llmModel">Model</label>
					<input id="llmModel" type="text" autocomplete="off" placeholder="gpt-4.1">
				</div>
				<div class="wiki-field">
					<label for="llmApiKey">API Key</label>
					<input id="llmApiKey" type="password" autocomplete="off" placeholder="sk-...">
				</div>
				<button class="wiki-save" id="saveLlmConfig" type="submit">Save</button>
			</form>
			<div class="wiki-main" id="wikiMain" hidden>
				<img class="wiki-logo" id="wikiLogo" src="${iconUri}" alt="">
				<div class="wiki-status" id="wikiStatus"></div>
				<button class="wiki-action" id="wikiAction" type="button">Initialize LLM Code Wiki</button>
			</div>
		</section>
		<section class="review-tree" aria-label="Cli Diff Review">
			<header class="tree-header">
				<div class="header-left">
					<button class="header-toggle" id="toggle" aria-expanded="true" title="Toggle Cli Diff Review">
						<span class="chevron" aria-hidden="true"></span>
						<span class="tree-title">Cli Diff Review</span>
					</button>
				</div>
				<div class="header-actions">
					<span class="model-pill" id="modelPill" hidden></span>
					<button class="refresh-button" id="refresh" title="Refresh" aria-label="Refresh">
						<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8A5 5 0 1 1 11.5 4.5"/><path d="M11.5 2.5V4.5H13.5"/></svg>
					</button>
				</div>
			</header>
			<div class="list" id="list"></div>
		</section>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const tree = document.querySelector('.review-tree');
		const toggle = document.getElementById('toggle');
		const list = document.getElementById('list');
		const modelPill = document.getElementById('modelPill');
		const wikiConfig = document.getElementById('wikiConfig');
		const wikiMain = document.getElementById('wikiMain');
		const wikiLogo = document.getElementById('wikiLogo');
		const wikiStatus = document.getElementById('wikiStatus');
		const wikiAction = document.getElementById('wikiAction');
		const llmProvider = document.getElementById('llmProvider');
		const llmBaseUrl = document.getElementById('llmBaseUrl');
		const llmModel = document.getElementById('llmModel');
		const llmApiKey = document.getElementById('llmApiKey');
		document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
		wikiConfig.addEventListener('submit', (event) => {
			event.preventDefault();
			vscode.postMessage({
				type: 'saveLlmConfig',
				provider: llmProvider.value,
				baseUrl: llmBaseUrl.value,
				model: llmModel.value,
				apiKey: llmApiKey.value,
			});
		});
		wikiAction.addEventListener('click', () => {
			if (lastWikiState?.status === 'initializing') {
				vscode.postMessage({ type: 'cancelWikiInitialization' });
				return;
			}
			vscode.postMessage({ type: 'initializeWiki' });
		});
		let expanded = true;
		let lastChangeSignature;
		let lastWikiState;
		toggle.addEventListener('click', () => setExpanded(!expanded));
		toggle.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				setExpanded(!expanded);
			}
		});
		const icons = {
			acceptFile: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5L6.5 11.5L12.5 4.5"/></svg>',
			rejectFile: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5L11.5 11.5"/><path d="M11.5 4.5L4.5 11.5"/></svg>',
			undoFile: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 5.5H3.5V3.5"/><path d="M3.8 5.4A5 5 0 1 1 4.9 12"/></svg>',
		};
		window.addEventListener('message', (event) => {
			if (event.data?.type !== 'state') {
				return;
			}
			render(event.data.payload || { files: [] });
		});
		vscode.postMessage({ type: 'ready' });

		function render(payload) {
			const files = payload.files || [];
			const changeSignature = payload.changeSignature || '';
			if (lastChangeSignature !== undefined && lastChangeSignature !== changeSignature) {
				setExpanded(true);
			}
			lastChangeSignature = changeSignature;
			renderWiki(payload.llmWiki || emptyWikiState());
			list.replaceChildren();
			if (files.length === 0) {
				const empty = document.createElement('div');
				empty.className = 'empty';
				empty.textContent = 'No changes';
				list.appendChild(empty);
				return;
			}
			for (const file of files) {
				list.appendChild(fileRow(file));
			}
		}

		function renderWiki(wiki) {
			lastWikiState = wiki;
			llmProvider.value = wiki.provider || 'openai';
			llmBaseUrl.value = wiki.baseUrl || '';
			llmModel.value = wiki.model || '';
			modelPill.hidden = !wiki.configured || !wiki.model;
			modelPill.textContent = wiki.model || '';
			wikiConfig.hidden = Boolean(wiki.configured);
			wikiMain.hidden = !wiki.configured;
			if (!wiki.configured) {
				return;
			}

			const initialized = wiki.status === 'initialized' || wiki.wikiExists;
			const initializing = wiki.status === 'initializing';
			wikiLogo.hidden = initializing;
			wikiAction.classList.toggle('secondary', initializing);
			wikiAction.disabled = (!wiki.workspaceAvailable && !initializing) || initialized;
			wikiAction.textContent = initializing
				? 'Cancel initialization'
				: initialized ? 'LLM Code Wiki initialized' : 'Initialize LLM Code Wiki';
			wikiStatus.textContent = wikiStatusText(wiki, initialized, initializing);
		}

		function wikiStatusText(wiki, initialized, initializing) {
			if (!wiki.workspaceAvailable && !initializing) {
				return 'Open a workspace folder';
			}
			if (initializing) {
				return wiki.progress || 'Initializing .wiki';
			}
			if (initialized) {
				return '.wiki initialized';
			}
			if (wiki.status === 'failed') {
				return wiki.error || 'Initialization failed';
			}
			if (wiki.status === 'paused') {
				return wiki.progress || 'Initialization paused';
			}
			return wiki.progress || 'Ready';
		}

		function emptyWikiState() {
			return {
				configured: false,
				provider: 'openai',
				baseUrl: '',
				model: '',
				hasApiKey: false,
				status: 'unconfigured',
				wikiExists: false,
				workspaceAvailable: false,
			};
		}

		function fileRow(file) {
			const row = document.createElement('div');
			row.className = 'file-row' + (file.active ? ' active' : '');
			row.tabIndex = 0;
			row.title = file.skippedReason ? file.relativePath + '\\n' + file.skippedReason : file.relativePath;
			row.addEventListener('click', () => vscode.postMessage({ type: 'open', uri: file.uri }));
			row.addEventListener('keydown', (event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					vscode.postMessage({ type: 'open', uri: file.uri });
				}
			});

			const main = document.createElement('div');
			main.className = 'file-main';
			row.appendChild(main);

			const icon = document.createElement('span');
			icon.className = 'file-icon';
			icon.textContent = file.fileExtension || '';
			main.appendChild(icon);

			const filePath = document.createElement('div');
			filePath.className = 'path ' + file.statusKind;
			filePath.textContent = file.relativePath;
			filePath.title = file.relativePath;
			main.appendChild(filePath);

			const description = document.createElement('span');
			description.className = 'description';
			description.textContent = file.description;
			description.title = file.description;
			main.appendChild(description);

			const status = document.createElement('span');
			status.className = 'status ' + file.statusKind;
			status.textContent = file.statusLabel;
			row.appendChild(status);

			const actions = document.createElement('div');
			actions.className = 'actions';
			row.appendChild(actions);
			actions.appendChild(actionButton('acceptFile', file.uri, file.acceptDisabled, 'Accept file'));
			actions.appendChild(actionButton('rejectFile', file.uri, file.rejectDisabled, 'Reject file'));
			actions.appendChild(actionButton('undoFile', file.uri, file.undoDisabled, 'Undo file'));
			return row;
		}

		function actionButton(type, uri, disabled, title) {
			const button = document.createElement('button');
			button.className = 'icon-button';
			button.title = title;
			button.setAttribute('aria-label', title);
			button.innerHTML = icons[type] || '';
			button.disabled = Boolean(disabled);
			button.addEventListener('click', (event) => {
				event.stopPropagation();
				vscode.postMessage({ type, uri });
			});
			return button;
		}

		function setExpanded(nextExpanded) {
			expanded = Boolean(nextExpanded);
			toggle.setAttribute('aria-expanded', String(expanded));
			list.hidden = !expanded;
			tree.classList.toggle('collapsed', !expanded);
		}
	</script>
</body>
</html>`;
	}
}

export function buildReviewDashboardPayload(
	session: ReviewSession | undefined,
	currentReviewUri: vscode.Uri | undefined,
	isDirty: (uri: vscode.Uri) => boolean,
	llmWiki: LlmWikiDashboardState = defaultLlmWikiDashboardState(),
): ReviewDashboardPayload {
	const currentKey = currentReviewUri ? uriKey(currentReviewUri) : undefined;
	const files = session
		? [...session.files.values()]
			.filter((file) => file.hunks.length > 0 || file.acceptedHunks.length > 0 || file.rejectedHunks.length > 0 || file.skippedReason)
			.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
			.map((file) => {
				const pendingCount = file.hunks.length;
				const reviewedCount = file.acceptedHunks.length + file.rejectedHunks.length;
				const dirty = isDirty(file.uri);
				const mutationDisabled = dirty || Boolean(file.skippedReason);
				const status = dashboardStatus(file);
				return {
					uri: file.uri.toString(),
					relativePath: file.relativePath,
					fileExtension: dashboardExtension(file.relativePath),
					description: dashboardDescription(pendingCount, reviewedCount, dirty, file.skippedReason),
					statusLabel: status.label,
					statusKind: status.kind,
					pendingCount,
					reviewedCount,
					skippedReason: file.skippedReason,
					dirty,
					active: currentKey === uriKey(file.uri),
					acceptDisabled: mutationDisabled || pendingCount === 0,
					rejectDisabled: mutationDisabled || pendingCount === 0,
					undoDisabled: mutationDisabled || reviewedCount === 0,
				};
			})
		: [];
	const currentFile = currentKey && session?.files.get(currentKey);
	const currentReviewLabel = currentFile
		? path.posix.basename(currentFile.relativePath)
		: currentReviewUri ? path.basename(currentReviewUri.fsPath) : undefined;
	const changeSignature = files.map((file) => [
		file.uri,
		file.pendingCount,
		file.reviewedCount,
		file.skippedReason ?? '',
		file.dirty ? 'dirty' : 'clean',
		file.statusLabel,
	].join(':')).join('\n');
	return {
		currentReviewUri: currentReviewUri?.toString(),
		currentReviewLabel,
		changeSignature,
		files,
		llmWiki,
	};
}

export function defaultLlmWikiDashboardState(): LlmWikiDashboardState {
	return {
		configured: false,
		provider: 'openai',
		baseUrl: '',
		model: '',
		hasApiKey: false,
		status: 'unconfigured',
		wikiExists: false,
		workspaceAvailable: Boolean(vscode.workspace.workspaceFolders?.length),
	};
}

function dashboardDescription(pendingCount: number, reviewedCount: number, dirty: boolean, skippedReason?: string): string {
	if (skippedReason) {
		return 'skipped';
	}
	const parts: string[] = [];
	if (pendingCount > 0) {
		parts.push(`${pendingCount} pending`);
	}
	if (reviewedCount > 0) {
		parts.push(`${reviewedCount} reviewed`);
	}
	if (dirty) {
		parts.push('dirty');
	}
	return parts.join(', ');
}

function dashboardTitleFile(currentReviewLabel?: string): string {
	return currentReviewLabel ?? '';
}

function dashboardExtension(relativePath: string): string {
	const extension = path.posix.extname(relativePath).replace(/^\./, '');
	return extension.slice(0, 3);
}

function dashboardStatus(file: ReviewFileState): { label: string; kind: ReviewDashboardFile['statusKind'] } {
	if (file.skippedReason) {
		return { label: 'S', kind: 'skipped' };
	}
	if (!file.currentExists) {
		return { label: 'D', kind: 'deleted' };
	}
	if (!file.baselineExists) {
		return { label: 'U', kind: 'untracked' };
	}
	return { label: 'M', kind: 'modified' };
}
