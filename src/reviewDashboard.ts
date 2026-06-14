import * as path from 'path';
import * as vscode from 'vscode';
import type { AiReviewChunkSuggestion, AiReviewFileResult, AiReviewFinding } from './agent/codeReview';
import type { AgentTraceDetail, AgentTraceEventKind, AgentTraceStatus } from './agent/runtime';
import type { LlmProvider, LlmThinkingMode } from './llm/config';
import { ReviewFileState, ReviewSession, uriKey } from './types';

type DashboardMessage =
	| { type: 'ready' }
	| { type: 'refresh' }
	| { type: 'open'; uri: string }
	| { type: 'acceptFile'; uri: string }
	| { type: 'rejectFile'; uri: string }
	| { type: 'undoFile'; uri: string }
	| { type: 'acceptAll' }
	| { type: 'rejectAll' }
	| { type: 'undoAll' }
	| {
		type: 'saveLlmConfig';
		provider: LlmProvider;
		baseUrl: string;
		model: string;
		apiKey: string;
		jsonOutputEnabled: boolean;
		thinkingMode: LlmThinkingMode;
		strictTools: boolean;
	}
	| { type: 'initializeWiki' }
	| { type: 'updateWiki' }
	| { type: 'generateAiReview' }
	| { type: 'openWikiIndex' }
	| { type: 'openExtensionSettings' }
	| { type: 'openFinding'; uri: string; hunkId: string }
	| { type: 'openChunk'; uri: string; hunkId: string }
	| { type: 'applyAiSuggestion'; uri: string; hunkId: string; suggestionId: string }
	| { type: 'undoAiSuggestion'; uri: string; hunkId: string; suggestionId: string }
	| { type: 'cancelAgent' };

export interface ReviewDashboardChunk {
	hunkId: string;
	kind: string;
	line: number;
	oldLines: number;
	newLines: number;
	findings: AiReviewFinding[];
	suggestions: AiReviewChunkSuggestion[];
	appliedSuggestion?: {
		suggestionId: string;
		replacementText: string;
	};
	reviewStatus?: 'pending' | 'reviewed';
}

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
	chunks: ReviewDashboardChunk[];
	aiReviewResult?: AiReviewFileResult;
}

export interface ReviewDashboardPayload {
	currentReviewUri?: string;
	currentReviewLabel?: string;
	changeSignature: string;
	files: ReviewDashboardFile[];
	llmWiki?: LlmWikiDashboardState;
}

export type LlmWikiStatus = 'unconfigured' | 'idle' | 'initializing' | 'updating' | 'reviewing' | 'initialized' | 'paused' | 'failed';

export interface LlmWikiRunLogEntry {
	id: string;
	sequence: number;
	timestamp: string;
	source?: 'wiki' | 'review';
	fileUri?: string;
	relativePath?: string;
	fileIndex?: number;
	fileCount?: number;
	kind: AgentTraceEventKind;
	title: string;
	summary: string;
	round?: number;
	status: AgentTraceStatus;
	details: AgentTraceDetail[];
}

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
	pendingSourceCount: number;
	wikiNeedsUpdate: boolean;
	findings: AiReviewFinding[];
	jsonOutputEnabled: boolean;
	thinkingMode: LlmThinkingMode;
	strictTools: boolean;
	runLog: LlmWikiRunLogEntry[];
	runLogSource?: 'wiki' | 'review';
	reviewFindings: AiReviewFinding[];
	reviewSuggestions: AiReviewChunkSuggestion[];
	aiReviewFileResults: AiReviewFileResult[];
	aiReviewStatus: 'none' | 'partial' | 'complete';
	aiReviewCompletedFileCount: number;
	aiReviewTotalFileCount: number;
	aiReviewError?: string;
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
		if (message.type === 'acceptAll') {
			await this.executeCommand('cli-diff.acceptAll');
			this.postState();
			return;
		}
		if (message.type === 'rejectAll') {
			await this.executeCommand('cli-diff.rejectAll');
			this.postState();
			return;
		}
		if (message.type === 'undoAll') {
			await this.executeCommand('cli-diff.undoAll');
			this.postState();
			return;
		}
		if (message.type === 'saveLlmConfig') {
			await this.executeCommand('cli-diff.saveLlmWikiConfig', {
				provider: message.provider,
				baseUrl: message.baseUrl,
				model: message.model,
				apiKey: message.apiKey,
				jsonOutputEnabled: message.jsonOutputEnabled,
				thinkingMode: message.thinkingMode,
				strictTools: message.strictTools,
			});
			this.postState();
			return;
		}
		if (message.type === 'initializeWiki') {
			await this.executeCommand('cli-diff.initializeLlmWiki');
			this.postState();
			return;
		}
		if (message.type === 'updateWiki') {
			await this.executeCommand('cli-diff.updateLlmWiki');
			this.postState();
			return;
		}
		if (message.type === 'generateAiReview') {
			await this.executeCommand('cli-diff.generateAiReview');
			this.postState();
			return;
		}
		if (message.type === 'openWikiIndex') {
			await this.executeCommand('cli-diff.openWikiIndex');
			this.postState();
			return;
		}
		if (message.type === 'openExtensionSettings') {
			await this.executeCommand('workbench.action.openSettings', '@ext:local.cli-diff-review');
			this.postState();
			return;
		}
		if (message.type === 'openFinding') {
			await this.executeCommand('cli-diff.openAiReviewFinding', message.uri, message.hunkId);
			this.postState();
			return;
		}
		if (message.type === 'openChunk') {
			await this.executeCommand('cli-diff.openAiReviewFinding', message.uri, message.hunkId);
			return;
		}
		if (message.type === 'applyAiSuggestion') {
			await this.executeCommand('cli-diff.applyAiSuggestion', message.uri, message.hunkId, message.suggestionId);
			this.postState();
			return;
		}
		if (message.type === 'undoAiSuggestion') {
			await this.executeCommand('cli-diff.undoAiSuggestion', message.uri, message.hunkId, message.suggestionId);
			this.postState();
			return;
		}
		if (message.type === 'cancelAgent') {
			await this.executeCommand('cli-diff.cancelAgent');
			this.postState();
		}
	}

	private renderShell(webview: vscode.Webview): string {
		const nonce = String(Date.now());
		const iconFile = vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..', 'resources', 'logo.svg');
		const iconUri = typeof webview.asWebviewUri === 'function' ? webview.asWebviewUri(iconFile).toString() : '';
		const settingIconFile = vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..', 'resources', 'setting.svg');
		const settingIconUri = typeof webview.asWebviewUri === 'function' ? webview.asWebviewUri(settingIconFile).toString() : '';
		const homeIconFile = vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..', 'resources', 'home.svg');
		const homeIconUri = typeof webview.asWebviewUri === 'function' ? webview.asWebviewUri(homeIconFile).toString() : '';
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
			--modified: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-editorInfo-foreground, #58a6ff));
			--untracked: var(--vscode-gitDecoration-untrackedResourceForeground, var(--vscode-testing-iconPassed, #3fb950));
			--deleted: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-errorForeground, #f85149));
			--skipped: var(--vscode-descriptionForeground);
		}
		* { box-sizing: border-box; }
		html {
			height: 100%;
			overflow: hidden;
		}
		body {
			margin: 0;
			height: 100vh;
			overflow: hidden;
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
			height: 100vh;
			min-height: 0;
			display: flex;
			flex-direction: column;
			overflow: hidden;
			padding: 0;
		}
		.page-header {
			flex: 0 0 auto;
			min-height: 26px;
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 4px 8px 0;
		}
		.page-actions {
			position: relative;
			display: flex;
			align-items: center;
			gap: 2px;
			margin-left: auto;
		}
		.home-button,
		.settings-button,
		.page-close {
			width: 22px;
			height: 22px;
			display: inline-grid;
			place-items: center;
		}
		.home-button img,
		.settings-button svg,
		.page-close svg {
			width: 15px;
			height: 15px;
			stroke: currentColor;
			fill: none;
			stroke-width: 1.7;
			stroke-linecap: round;
			stroke-linejoin: round;
		}
		.home-button img,
		.settings-button img {
			width: 15px;
			height: 15px;
			display: block;
		}
		.settings-menu {
			position: absolute;
			z-index: 10;
			top: 25px;
			right: 0;
			width: min(230px, calc(100vw - 16px));
			padding: 3px;
			border: 1px solid var(--vscode-menu-border, var(--tree-border));
			border-radius: 6px;
			color: var(--vscode-menu-foreground, var(--vscode-sideBar-foreground));
			background: var(--vscode-menu-background, var(--vscode-sideBar-background));
			box-shadow: 0 2px 8px var(--vscode-widget-shadow);
		}
		.settings-menu[hidden] { display: none; }
		.settings-menu-item {
			width: 100%;
			min-height: 28px;
			display: flex;
			flex-direction: column;
			align-items: flex-start;
			justify-content: center;
			gap: 1px;
			padding: 4px 6px;
			text-align: left;
		}
		.settings-menu-item:hover:not(:disabled) {
			color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
			background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
		}
		.settings-menu-item:disabled { opacity: 1; }
		.settings-menu-item:disabled .settings-menu-title { color: var(--vscode-disabledForeground, var(--muted)); }
		.settings-menu-title {
			font-size: 11px;
			line-height: 1.25;
		}
		.settings-menu-reason {
			color: var(--muted);
			font-size: 9px;
			line-height: 1.2;
		}
		.settings-menu-reason:empty { display: none; }
		.settings-menu-divider {
			height: 1px;
			margin: 3px 4px;
			background: var(--vscode-menu-separatorBackground, var(--tree-border));
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
		.wiki-panel.has-run-log,
		.wiki-panel.has-review-detail {
			min-height: 0;
			align-items: stretch;
			justify-content: stretch;
			overflow: hidden;
		}
		.wiki-config {
			width: 100%;
			max-width: 260px;
			display: flex;
			flex-direction: column;
			align-items: stretch;
			gap: 7px;
		}
		.wiki-main {
			width: 100%;
			max-width: 260px;
			display: flex;
			flex-direction: column;
			align-items: stretch;
			gap: 7px;
		}
		.wiki-main.has-run-log,
		.wiki-main.has-review-detail {
			flex: 1 1 auto;
			width: 100%;
			max-width: none;
			min-height: 0;
			align-self: stretch;
			overflow: hidden;
		}
		.wiki-config[hidden],
		.wiki-main[hidden],
		.model-pill[hidden],
		.home-button[hidden],
		.page-close[hidden],
		.wiki-logo[hidden],
		.wiki-action[hidden],
		.wiki-run-list[hidden],
		.review-file-detail[hidden],
		.findings[hidden] { display: none; }
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
		.wiki-check {
			min-height: 22px;
			display: flex;
			align-items: center;
			gap: 6px;
			color: var(--muted);
			font-size: 11px;
		}
		.wiki-check input { margin: 0; accent-color: var(--vscode-checkbox-selectBackground); }
		.provider-capability[hidden] { display: none; }
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
		.wiki-main.has-run-log .wiki-action,
		.wiki-main.has-review-detail .wiki-action {
			flex: 0 0 auto;
		}
		.wiki-logo {
			width: 72px;
			height: 72px;
			align-self: center;
			opacity: .82;
		}
		.wiki-status {
			flex: 0 0 auto;
			min-height: 16px;
			color: var(--muted);
			text-align: center;
			line-height: 1.35;
			overflow-wrap: anywhere;
		}
		.wiki-run-list {
			display: flex;
			flex-direction: column;
			gap: 4px;
			max-height: min(46vh, 380px);
			overflow: auto;
		}
		.wiki-main.has-run-log .wiki-run-list,
		.wiki-main.has-review-detail .review-file-detail {
			flex: 1 1 auto;
			width: 100%;
			min-height: 0;
			max-height: none;
			overflow: auto;
		}
		.wiki-run-item {
			border: 1px solid var(--tree-border);
			border-radius: 4px;
			background: var(--vscode-sideBar-background);
		}
		.wiki-run-item[open] {
			background: var(--vscode-list-hoverBackground, var(--vscode-sideBar-background));
		}
		.wiki-run-summary {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 5px;
			padding: 5px 6px;
			cursor: pointer;
			list-style: none;
		}
		.wiki-run-summary::-webkit-details-marker { display: none; }
		.wiki-run-main {
			min-width: 0;
			display: flex;
			flex-direction: column;
			gap: 2px;
		}
		.wiki-run-title {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			font-size: 12px;
			font-weight: 600;
		}
		.wiki-run-meta {
			color: var(--muted);
			font-size: 10px;
			line-height: 1.2;
			overflow-wrap: anywhere;
		}
		.wiki-run-status {
			align-self: start;
			min-width: 36px;
			padding-top: 1px;
			font-size: 10px;
			font-weight: 700;
			text-align: right;
			text-transform: uppercase;
		}
		.wiki-run-status.success { color: var(--vscode-testing-iconPassed, var(--vscode-gitDecoration-untrackedResourceForeground)); }
		.wiki-run-status.error { color: var(--vscode-errorForeground); }
		.wiki-run-status.running { color: var(--vscode-progressBar-background, var(--vscode-focusBorder)); }
		.wiki-run-status.info { color: var(--muted); }
		.wiki-run-round {
			border: 1px solid var(--tree-border);
			border-radius: 4px;
			background: var(--vscode-sideBar-background);
		}
		.wiki-run-round[open] {
			background: var(--vscode-list-hoverBackground, var(--vscode-sideBar-background));
		}
		.wiki-run-round-summary {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 5px;
			padding: 5px 6px;
			cursor: pointer;
			list-style: none;
		}
		.wiki-run-round-summary::-webkit-details-marker { display: none; }
		.wiki-run-round-items {
			display: flex;
			flex-direction: column;
			gap: 3px;
			margin: 0 4px 5px 7px;
			padding-left: 7px;
			border-left: 1px solid var(--tree-border);
		}
		.wiki-run-round-items .wiki-run-item {
			border-color: transparent;
			background: transparent;
		}
		.wiki-run-round-items .wiki-run-item[open] {
			border-color: var(--tree-border);
			background: var(--vscode-sideBar-background);
		}
		.wiki-run-file {
			border: 1px solid var(--tree-border);
			border-radius: 4px;
			background: var(--vscode-sideBar-background);
		}
		.wiki-run-file[open] {
			background: var(--vscode-list-hoverBackground, var(--vscode-sideBar-background));
		}
		.wiki-run-file-summary {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 5px;
			padding: 5px 6px;
			cursor: pointer;
			list-style: none;
		}
		.wiki-run-file-summary::-webkit-details-marker { display: none; }
		.wiki-run-file-items {
			display: flex;
			flex-direction: column;
			gap: 4px;
			margin: 0 4px 5px 7px;
			padding-left: 7px;
			border-left: 1px solid var(--tree-border);
		}
		.wiki-run-details {
			display: flex;
			flex-direction: column;
			gap: 5px;
			padding: 0 6px 6px;
		}
		.wiki-run-detail-label {
			display: block;
			margin: 0 0 2px;
			color: var(--muted);
			font-size: 10px;
			font-weight: 600;
		}
		.wiki-run-detail pre {
			max-height: 220px;
			margin: 0;
			overflow: auto;
			white-space: pre-wrap;
			overflow-wrap: anywhere;
			padding: 5px;
			border: 1px solid var(--tree-border);
			border-radius: 3px;
			color: var(--vscode-editor-foreground, var(--vscode-sideBar-foreground));
			background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background, transparent));
			font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
			font-size: 11px;
			line-height: 1.35;
		}
		.findings {
			display: flex;
			flex-direction: column;
			gap: 3px;
			max-height: min(42vh, 360px);
			overflow: auto;
		}
		.finding {
			display: grid;
			grid-template-columns: 7px minmax(0, 1fr);
			gap: 6px;
			padding: 5px 6px;
			border: 1px solid var(--tree-border);
			border-radius: 3px;
			text-align: left;
		}
		.finding-marker { width: 7px; height: 7px; margin-top: 4px; border-radius: 50%; background: var(--muted); }
		.finding.critical .finding-marker { background: var(--vscode-errorForeground); }
		.finding.warning .finding-marker { background: var(--vscode-editorWarning-foreground); }
		.finding.suggestion .finding-marker { background: var(--vscode-editorInfo-foreground); }
		.finding-title { display: block; font-weight: 600; overflow-wrap: anywhere; }
		.finding-detail { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; line-height: 1.3; overflow-wrap: anywhere; }
		.review-file-detail {
			display: flex;
			flex-direction: column;
			gap: 5px;
			overflow: auto;
		}
		.review-file-heading {
			flex: 0 0 auto;
			display: flex;
			flex-direction: column;
			gap: 2px;
			padding: 0 1px 3px;
		}
		.review-file-title {
			font-size: 12px;
			font-weight: 700;
			overflow-wrap: anywhere;
		}
		.review-file-meta {
			color: var(--muted);
			font-size: 10px;
			line-height: 1.3;
		}
		.review-file-result {
			padding: 5px 6px;
			border: 1px solid var(--tree-border);
			border-radius: 4px;
			color: var(--muted);
			font-size: 11px;
			line-height: 1.35;
			background: color-mix(in srgb, var(--vscode-sideBar-background) 90%, var(--vscode-editorInfo-foreground) 10%);
			overflow-wrap: anywhere;
		}
		.review-chunk {
			border: 1px solid var(--tree-border);
			border-left-width: 3px;
			border-radius: 4px;
			background: var(--vscode-sideBar-background);
		}
		.review-chunk.add {
			border-left-color: var(--untracked);
			background: color-mix(in srgb, var(--vscode-sideBar-background) 92%, var(--untracked) 8%);
		}
		.review-chunk.delete {
			border-left-color: var(--deleted);
			background: color-mix(in srgb, var(--vscode-sideBar-background) 92%, var(--deleted) 8%);
		}
		.review-chunk.modify {
			border-left-color: var(--modified);
			background: color-mix(in srgb, var(--vscode-sideBar-background) 92%, var(--modified) 8%);
		}
		.review-chunk.has-findings,
		.review-chunk.has-suggestion {
			box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 65%, transparent);
		}
		.review-chunk[open] {
			background: var(--vscode-list-hoverBackground, var(--vscode-sideBar-background));
		}
		.review-chunk.add[open] {
			background: color-mix(in srgb, var(--vscode-sideBar-background) 86%, var(--untracked) 14%);
		}
		.review-chunk.delete[open] {
			background: color-mix(in srgb, var(--vscode-sideBar-background) 86%, var(--deleted) 14%);
		}
		.review-chunk.modify[open] {
			background: color-mix(in srgb, var(--vscode-sideBar-background) 86%, var(--modified) 14%);
		}
		.review-chunk-summary {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 6px;
			padding: 5px 6px;
			cursor: pointer;
			list-style: none;
		}
		.review-chunk-summary::-webkit-details-marker { display: none; }
		.review-chunk-body {
			display: flex;
			flex-direction: column;
			gap: 5px;
			padding: 0 6px 6px;
		}
		.review-finding {
			display: grid;
			grid-template-columns: 7px minmax(0, 1fr);
			gap: 6px;
			padding: 5px;
			border: 1px solid var(--tree-border);
			border-radius: 3px;
			text-align: left;
			background: transparent;
		}
		.review-finding-marker {
			width: 7px;
			height: 7px;
			margin-top: 4px;
			border-radius: 50%;
			background: var(--muted);
		}
		.review-finding.critical .review-finding-marker { background: var(--vscode-errorForeground); }
		.review-finding.warning .review-finding-marker { background: var(--vscode-editorWarning-foreground); }
		.review-finding.suggestion .review-finding-marker { background: var(--vscode-editorInfo-foreground); }
		.review-finding-title {
			display: block;
			font-size: 12px;
			font-weight: 600;
			overflow-wrap: anywhere;
		}
		.review-finding-text {
			display: block;
			margin-top: 3px;
			color: var(--vscode-sideBar-foreground);
			font-size: 11px;
			line-height: 1.35;
			overflow-wrap: anywhere;
		}
		.review-suggestion {
			border: 1px solid color-mix(in srgb, var(--vscode-editorInfo-foreground) 42%, transparent);
			border-radius: 4px;
			background: color-mix(in srgb, var(--vscode-sideBar-background) 82%, var(--vscode-editorInfo-foreground) 18%);
			overflow: hidden;
		}
		.review-suggestion-header {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 5px 6px;
			border-bottom: 1px solid color-mix(in srgb, var(--vscode-editorInfo-foreground) 26%, transparent);
		}
		.review-suggestion-title {
			flex: 1 1 auto;
			min-width: 0;
			font-size: 11px;
			font-weight: 700;
			color: var(--vscode-editorInfo-foreground);
			overflow-wrap: anywhere;
		}
		.review-suggestion-action {
			flex: 0 0 auto;
			padding: 1px 7px;
			border: 1px solid color-mix(in srgb, var(--vscode-editorInfo-foreground) 48%, transparent);
			border-radius: 4px;
			color: var(--vscode-editorInfo-foreground);
			background: color-mix(in srgb, var(--vscode-sideBar-background) 76%, var(--vscode-editorInfo-foreground) 24%);
			font-size: 11px;
		}
		.review-suggestion-pre {
			max-height: 160px;
			margin: 0;
			padding: 6px;
			overflow: auto;
			white-space: pre-wrap;
			overflow-wrap: anywhere;
			font-family: var(--vscode-editor-font-family);
			font-size: 11px;
			line-height: 1.35;
		}
		.review-suggestion-rationale {
			padding: 0 6px 6px;
			color: var(--muted);
			font-size: 11px;
			line-height: 1.35;
			overflow-wrap: anywhere;
		}
		.review-empty {
			padding: 5px 6px;
			color: var(--muted);
			font-size: 11px;
			line-height: 1.35;
		}
		.model-pill {
			max-width: 132px;
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
			max-height: min(48vh, 420px);
			display: flex;
			flex-direction: column;
			margin: 0;
			background: var(--vscode-sideBar-background);
			overflow: hidden;
			border: 1px solid var(--tree-border);
			border-radius: 6px;
		}
		.tree-header {
			flex: 0 0 auto;
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
			flex: 1 1 auto;
			min-height: 0;
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
		<header class="page-header" id="pageHeader">
			<button class="model-pill" id="modelPill" type="button" title="Configure LLM" hidden></button>
			<div class="page-actions">
				<button class="home-button" id="homeButton" type="button" title="Back to review overview" aria-label="Back to review overview" hidden>
					<img src="${homeIconUri}" alt="" aria-hidden="true">
				</button>
				<button class="page-close" id="closeConfig" type="button" title="Close configuration" aria-label="Close configuration" hidden>
					<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4L12 12"/><path d="M12 4L4 12"/></svg>
				</button>
				<button class="settings-button" id="settingsButton" type="button" title="Actions and settings" aria-label="Actions and settings" aria-controls="settingsMenu" aria-expanded="false">
					<img src="${settingIconUri}" alt="" aria-hidden="true">
				</button>
				<div class="settings-menu" id="settingsMenu" role="menu" hidden>
					<button class="settings-menu-item" type="button" role="menuitem" data-menu-action="initializeWiki">
						<span class="settings-menu-title">Initialize LLM Code Wiki</span>
						<span class="settings-menu-reason"></span>
					</button>
					<button class="settings-menu-item" type="button" role="menuitem" data-menu-action="updateWiki">
						<span class="settings-menu-title">Update LLM Code Wiki</span>
						<span class="settings-menu-reason"></span>
					</button>
					<button class="settings-menu-item" type="button" role="menuitem" data-menu-action="generateAiReview">
						<span class="settings-menu-title">Generate AI review</span>
						<span class="settings-menu-reason"></span>
					</button>
					<div class="settings-menu-divider" role="separator"></div>
					<button class="settings-menu-item" type="button" role="menuitem" data-menu-action="openWikiIndex">
						<span class="settings-menu-title">Open Wiki home</span>
						<span class="settings-menu-reason"></span>
					</button>
					<button class="settings-menu-item" type="button" role="menuitem" data-menu-action="openExtensionSettings">
						<span class="settings-menu-title">Open extension settings</span>
						<span class="settings-menu-reason"></span>
					</button>
				</div>
			</div>
		</header>
		<section class="wiki-panel" aria-label="LLM Code Wiki">
			<form class="wiki-config" id="wikiConfig">
				<div class="wiki-field">
					<label for="llmProvider">Provider</label>
					<select id="llmProvider">
						<option value="openai">OpenAI-compatible</option>
						<option value="anthropic">Anthropic</option>
						<option value="deepseek">DeepSeek</option>
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
					<input id="llmApiKey" type="password" autocomplete="off" placeholder="Leave blank to keep current key">
				</div>
				<label class="wiki-check provider-capability" id="jsonOutputField">
					<input id="llmJsonOutput" type="checkbox">
					<span>JSON Output</span>
				</label>
				<div class="wiki-field provider-capability" id="thinkingModeField" hidden>
					<label for="llmThinkingMode">Thinking</label>
					<select id="llmThinkingMode">
						<option value="disabled">Disabled</option>
						<option value="high">High</option>
						<option value="max">Max</option>
					</select>
				</div>
				<label class="wiki-check provider-capability" id="strictToolsField" hidden>
					<input id="llmStrictTools" type="checkbox">
					<span>Strict Tools (Beta)</span>
				</label>
				<button class="wiki-save" id="saveLlmConfig" type="submit">Save</button>
			</form>
			<div class="wiki-main" id="wikiMain" hidden>
				<img class="wiki-logo" id="wikiLogo" src="${iconUri}" alt="">
				<div class="findings" id="findings" hidden></div>
				<div class="review-file-detail" id="reviewFileDetail" hidden></div>
				<div class="wiki-run-list" id="wikiRunList" hidden></div>
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
					<button class="refresh-button bulk-action-button" id="acceptAll" type="button" title="Accept all pending changes" aria-label="Accept all pending changes">
						<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5L6.5 11.5L12.5 4.5"/></svg>
					</button>
					<button class="refresh-button bulk-action-button" id="rejectAll" type="button" title="Reject all pending changes" aria-label="Reject all pending changes">
						<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5L11.5 11.5"/><path d="M11.5 4.5L4.5 11.5"/></svg>
					</button>
					<button class="refresh-button bulk-action-button" id="undoAll" type="button" title="Undo all reviewed changes" aria-label="Undo all reviewed changes">
						<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 5.5H3.5V3.5"/><path d="M3.8 5.4A5 5 0 1 1 4.9 12"/></svg>
					</button>
					<button class="refresh-button" id="refresh" type="button" title="Refresh" aria-label="Refresh">
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
		const wikiPanel = document.querySelector('.wiki-panel');
		const toggle = document.getElementById('toggle');
		const list = document.getElementById('list');
		const modelPill = document.getElementById('modelPill');
		const homeButton = document.getElementById('homeButton');
		const closeConfig = document.getElementById('closeConfig');
		const settingsButton = document.getElementById('settingsButton');
		const settingsMenu = document.getElementById('settingsMenu');
		const settingsMenuItems = [...settingsMenu.querySelectorAll('[data-menu-action]')];
		const wikiConfig = document.getElementById('wikiConfig');
		const wikiMain = document.getElementById('wikiMain');
		const wikiLogo = document.getElementById('wikiLogo');
		const findings = document.getElementById('findings');
		const reviewFileDetail = document.getElementById('reviewFileDetail');
		const wikiRunList = document.getElementById('wikiRunList');
		const wikiStatus = document.getElementById('wikiStatus');
		const wikiAction = document.getElementById('wikiAction');
		const llmProvider = document.getElementById('llmProvider');
		const llmBaseUrl = document.getElementById('llmBaseUrl');
		const llmModel = document.getElementById('llmModel');
		const llmApiKey = document.getElementById('llmApiKey');
		const llmJsonOutput = document.getElementById('llmJsonOutput');
		const llmThinkingMode = document.getElementById('llmThinkingMode');
		const llmStrictTools = document.getElementById('llmStrictTools');
		const jsonOutputField = document.getElementById('jsonOutputField');
		const thinkingModeField = document.getElementById('thinkingModeField');
		const strictToolsField = document.getElementById('strictToolsField');
		const acceptAllButton = document.getElementById('acceptAll');
		const rejectAllButton = document.getElementById('rejectAll');
		const undoAllButton = document.getElementById('undoAll');
		let editingConfig = false;
		let apiKeyPlaceholderActive = false;
		acceptAllButton.addEventListener('click', () => vscode.postMessage({ type: 'acceptAll' }));
		rejectAllButton.addEventListener('click', () => vscode.postMessage({ type: 'rejectAll' }));
		undoAllButton.addEventListener('click', () => vscode.postMessage({ type: 'undoAll' }));
		document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
		modelPill.addEventListener('click', () => {
			editingConfig = true;
			populateConfig(lastWikiState || emptyWikiState());
			renderWiki(lastWikiState || emptyWikiState());
		});
		homeButton.addEventListener('click', () => {
			reviewDetailUri = undefined;
			renderWiki(lastWikiState || emptyWikiState());
		});
		closeConfig.addEventListener('click', closeConfigEditor);
		settingsButton.addEventListener('click', (event) => {
			event.stopPropagation();
			setSettingsMenuOpen(settingsMenu.hidden);
		});
		document.addEventListener('click', (event) => {
			if (!event.target.closest('.page-actions')) {
				setSettingsMenuOpen(false);
			}
		});
		for (const item of settingsMenuItems) {
			item.addEventListener('click', () => {
				if (item.disabled) {
					return;
				}
				setSettingsMenuOpen(false);
				vscode.postMessage({ type: item.dataset.menuAction });
			});
		}
		llmProvider.addEventListener('change', () => {
			editingConfig = true;
			applyProviderCapabilities(true);
		});
		for (const field of [llmBaseUrl, llmModel, llmJsonOutput, llmThinkingMode, llmStrictTools]) {
			field.addEventListener('input', () => {
				editingConfig = true;
			});
		}
		llmApiKey.addEventListener('focus', () => {
			if (apiKeyPlaceholderActive) {
				llmApiKey.value = '';
				apiKeyPlaceholderActive = false;
			}
		});
		llmApiKey.addEventListener('input', () => {
			editingConfig = true;
			apiKeyPlaceholderActive = false;
		});
		llmApiKey.addEventListener('blur', () => {
			if (!llmApiKey.value && lastWikiState?.hasApiKey) {
				showStoredApiKey();
			}
		});
		wikiConfig.addEventListener('submit', (event) => {
			event.preventDefault();
			editingConfig = false;
			vscode.postMessage({
				type: 'saveLlmConfig',
				provider: llmProvider.value,
				baseUrl: llmBaseUrl.value,
				model: llmModel.value,
				apiKey: apiKeyPlaceholderActive ? '' : llmApiKey.value,
				jsonOutputEnabled: llmJsonOutput.checked,
				thinkingMode: llmThinkingMode.value,
				strictTools: llmStrictTools.checked,
			});
		});
		wikiAction.addEventListener('click', () => {
			if (isAgentRunning(lastWikiState?.status)) {
				vscode.postMessage({ type: 'cancelAgent' });
				return;
			}
			vscode.postMessage({ type: wikiAction.dataset.action || 'initializeWiki' });
		});
		let expanded = true;
		let lastChangeSignature;
		let lastWikiState;
		let lastFiles = [];
		let reviewDetailUri;
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
		window.addEventListener('keydown', (event) => {
			if (event.key !== 'Escape') {
				return;
			}
			if (!settingsMenu.hidden) {
				setSettingsMenuOpen(false);
			} else if (editingConfig && lastWikiState?.configured) {
				closeConfigEditor();
			}
		});
		vscode.postMessage({ type: 'ready' });

		function render(payload) {
			const files = payload.files || [];
			lastFiles = files;
			updateBulkActionButtons(files);
			if (reviewDetailUri && !files.some((file) => file.uri === reviewDetailUri)) {
				reviewDetailUri = undefined;
			}
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

		function updateBulkActionButtons(files) {
			const pendingCount = files.reduce((sum, file) => sum + (file.pendingCount || 0), 0);
			const reviewedCount = files.reduce((sum, file) => sum + (file.reviewedCount || 0), 0);
			acceptAllButton.disabled = pendingCount === 0;
			rejectAllButton.disabled = pendingCount === 0;
			undoAllButton.disabled = reviewedCount === 0;
		}

		function renderWiki(wiki) {
			lastWikiState = wiki;
			if (!editingConfig) {
				populateConfig(wiki);
			}
			modelPill.hidden = !wiki.configured || !wiki.model;
			modelPill.textContent = wiki.model || '';
			closeConfig.hidden = !wiki.configured || !editingConfig;
			wikiConfig.hidden = Boolean(wiki.configured) && !editingConfig;
			wikiMain.hidden = !wiki.configured || editingConfig;
			const runLog = wiki.runLog || [];
			const reviewDetailFile = reviewDetailUri ? lastFiles.find((file) => file.uri === reviewDetailUri) : undefined;
			const hasRunLog = runLog.length > 0 && Boolean(wiki.configured) && !editingConfig;
			const hasReviewDetail = Boolean(reviewDetailFile) && Boolean(wiki.configured) && !editingConfig;
			wikiPanel?.classList.toggle('has-run-log', hasRunLog);
			wikiPanel?.classList.toggle('has-review-detail', hasReviewDetail);
			wikiMain.classList.toggle('has-run-log', hasRunLog);
			wikiMain.classList.toggle('has-review-detail', hasReviewDetail);
			homeButton.hidden = !hasReviewDetail;
			renderSettingsMenu(wiki);
			if (!wiki.configured) {
				return;
			}

			const initialized = wiki.status === 'initialized';
			const running = isAgentRunning(wiki.status);
			const currentFindings = wiki.findings || [];
			renderFindings(hasReviewDetail || hasRunLog ? [] : currentFindings);
			renderReviewFileDetail(reviewDetailFile);
			renderRunLog(hasReviewDetail ? [] : runLog, wiki.runLogSource);
			wikiLogo.hidden = running || currentFindings.length > 0 || hasRunLog || hasReviewDetail;
			wikiAction.classList.toggle('secondary', running);
			wikiAction.hidden = false;
			wikiAction.disabled = !wiki.workspaceAvailable && !running;
			if (running) {
				wikiAction.dataset.action = 'cancelAgent';
				wikiAction.textContent = 'Cancel Agent';
			} else if ((wiki.pendingSourceCount || 0) > 0) {
				wikiAction.dataset.action = 'generateAiReview';
				wikiAction.textContent = aiReviewActionLabel(wiki);
			} else if (wiki.wikiNeedsUpdate) {
				wikiAction.dataset.action = 'updateWiki';
				wikiAction.textContent = 'Update LLM Code Wiki';
			} else if (!initialized) {
				wikiAction.dataset.action = 'initializeWiki';
				wikiAction.textContent = 'Initialize LLM Code Wiki';
			} else {
				wikiAction.hidden = true;
			}
			wikiStatus.textContent = wikiStatusText(wiki, initialized, running);
		}

		function renderSettingsMenu(wiki) {
			const running = isAgentRunning(wiki.status);
			const initialized = wiki.status === 'initialized';
			const initializeLabel = wiki.status === 'paused'
				? 'Resume Wiki Initialization'
				: wiki.status === 'failed' ? 'Retry Wiki Initialization' : 'Initialize LLM Code Wiki';
			setMenuAction('initializeWiki', initializeLabel, running || !wiki.configured || !wiki.workspaceAvailable || initialized,
				running ? 'Agent is running'
					: !wiki.configured ? 'Configure LLM first'
						: !wiki.workspaceAvailable ? 'Open a workspace folder'
							: initialized ? 'Wiki already initialized' : '');
			setMenuAction('updateWiki', 'Update LLM Code Wiki',
				running || !wiki.configured || !wiki.workspaceAvailable || !initialized || !wiki.wikiNeedsUpdate,
				running ? 'Agent is running'
					: !wiki.configured ? 'Configure LLM first'
						: !wiki.workspaceAvailable ? 'Open a workspace folder'
							: !initialized ? 'Initialize Wiki first' : 'Wiki is up to date');
			setMenuAction('generateAiReview', aiReviewActionLabel(wiki),
				running || !wiki.configured || !wiki.workspaceAvailable || (wiki.pendingSourceCount || 0) === 0,
				running ? 'Agent is running'
					: !wiki.configured ? 'Configure LLM first'
						: !wiki.workspaceAvailable ? 'Open a workspace folder' : 'No pending source changes');
			setMenuAction('openWikiIndex', 'Open Wiki home', !initialized, initialized ? '' : 'Initialize Wiki first');
			setMenuAction('openExtensionSettings', 'Open extension settings', false, '');
		}

		function setMenuAction(action, label, disabled, reason) {
			const item = settingsMenuItems.find((candidate) => candidate.dataset.menuAction === action);
			if (!item) {
				return;
			}
			item.disabled = Boolean(disabled);
			item.querySelector('.settings-menu-title').textContent = label;
			item.querySelector('.settings-menu-reason').textContent = disabled ? reason : '';
		}

		function aiReviewActionLabel(wiki) {
			if (wiki.aiReviewStatus === 'complete') {
				return 'Regenerate AI review';
			}
			if (wiki.aiReviewStatus === 'partial') {
				return wiki.aiReviewError ? 'Retry AI review' : 'Continue AI review';
			}
			return 'Generate AI review';
		}

		function setSettingsMenuOpen(open) {
			settingsMenu.hidden = !open;
			settingsButton.setAttribute('aria-expanded', String(open));
		}

		function populateConfig(wiki) {
			llmProvider.value = wiki.provider || 'openai';
			llmBaseUrl.value = wiki.baseUrl || '';
			llmModel.value = wiki.model || '';
			llmJsonOutput.checked = Boolean(wiki.jsonOutputEnabled);
			llmThinkingMode.value = wiki.thinkingMode || 'disabled';
			llmStrictTools.checked = Boolean(wiki.strictTools);
			if (wiki.hasApiKey) {
				showStoredApiKey();
			} else {
				llmApiKey.value = '';
				apiKeyPlaceholderActive = false;
			}
			applyProviderCapabilities(false);
		}

		function showStoredApiKey() {
			llmApiKey.value = '********';
			apiKeyPlaceholderActive = true;
		}

		function closeConfigEditor() {
			editingConfig = false;
			renderWiki(lastWikiState || emptyWikiState());
		}

		function wikiStatusText(wiki, initialized, running) {
			if (!wiki.workspaceAvailable && !running) {
				return 'Open a workspace folder';
			}
			if (running) {
				return wiki.progress || 'Agent running';
			}
			if ((wiki.findings || []).length > 0) {
				return (wiki.findings || []).length + ' findings for current file';
			}
			if (wiki.aiReviewStatus === 'partial') {
				const completed = wiki.aiReviewCompletedFileCount || 0;
				const total = wiki.aiReviewTotalFileCount || 0;
				return wiki.aiReviewError
					? 'AI review failed after ' + completed + '/' + total + ' files'
					: 'AI review partial: ' + completed + '/' + total + ' files';
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

		function renderFindings(items) {
			findings.replaceChildren();
			findings.hidden = items.length === 0;
			for (const item of items) {
				const button = document.createElement('button');
				button.className = 'finding ' + item.severity;
				button.title = item.explanation + '\\n\\n' + item.recommendation;
				button.addEventListener('click', () => vscode.postMessage({ type: 'openFinding', uri: item.uri, hunkId: item.hunkId }));
				const marker = document.createElement('span');
				marker.className = 'finding-marker';
				button.appendChild(marker);
				const body = document.createElement('span');
				const title = document.createElement('span');
				title.className = 'finding-title';
				title.textContent = item.title;
				const detail = document.createElement('span');
				detail.className = 'finding-detail';
				detail.textContent = item.severity + ' · line ' + (item.line + 1);
				body.append(title, detail);
				button.appendChild(body);
				findings.appendChild(button);
			}
		}

		function renderReviewFileDetail(file) {
			reviewFileDetail.replaceChildren();
			reviewFileDetail.hidden = !file;
			if (!file) {
				return;
			}

			const heading = document.createElement('div');
			heading.className = 'review-file-heading';
			const title = document.createElement('div');
			title.className = 'review-file-title';
			title.textContent = file.relativePath;
			const totalFindings = file.chunks.reduce((total, chunk) => total + (chunk.findings || []).length, 0);
			const meta = document.createElement('div');
			meta.className = 'review-file-meta';
			meta.textContent = file.chunks.length + ' chunks | ' + totalFindings + ' findings';
			heading.append(title, meta);
			reviewFileDetail.appendChild(heading);
			if (file.aiReviewResult) {
				const result = document.createElement('div');
				result.className = 'review-file-result';
				result.textContent = file.aiReviewResult.summary || (file.aiReviewResult.status === 'error' ? file.aiReviewResult.error : '');
				reviewFileDetail.appendChild(result);
			}

			if (file.chunks.length === 0) {
				const empty = document.createElement('div');
				empty.className = 'review-empty';
				empty.textContent = 'No pending chunks for this file.';
				reviewFileDetail.appendChild(empty);
				return;
			}

			for (const chunk of file.chunks) {
				reviewFileDetail.appendChild(renderReviewChunk(file, chunk));
			}
		}

		function renderReviewChunk(file, chunk) {
			const details = document.createElement('details');
			const findings = chunk.findings || [];
			const suggestions = chunk.suggestions || [];
			const kindClass = ['add', 'delete', 'modify'].includes(chunk.kind) ? chunk.kind : 'modify';
			details.className = 'review-chunk ' + kindClass
				+ (findings.length > 0 ? ' has-findings' : ' no-findings')
				+ (suggestions.length > 0 ? ' has-suggestion' : '');
			if (findings.length > 0 || suggestions.length > 0) {
				details.open = true;
				details.setAttribute('open', '');
			}

			const summary = document.createElement('summary');
			summary.className = 'review-chunk-summary';
			summary.addEventListener('click', () => vscode.postMessage({ type: 'openChunk', uri: file.uri, hunkId: chunk.hunkId }));
			const main = document.createElement('span');
			main.className = 'wiki-run-main';
			const title = document.createElement('span');
			title.className = 'wiki-run-title';
			title.textContent = (chunk.reviewStatus === 'reviewed' ? 'reviewed ' : '') + chunk.kind + ' ' + chunk.oldLines + '->' + chunk.newLines + ' lines';
			const meta = document.createElement('span');
			meta.className = 'wiki-run-meta';
			meta.textContent = 'line ' + (chunk.line + 1) + ' | ' + (findings.length || 'No') + ' findings'
				+ (suggestions.length > 0 ? ' | ' + suggestions.length + ' suggestion' + (suggestions.length === 1 ? '' : 's') : '');
			main.append(title, meta);
			const status = document.createElement('span');
			status.className = 'wiki-run-status ' + (findings.length > 0 ? 'success' : 'info');
			status.textContent = findings.length > 0 ? String(findings.length) : '0';
			summary.append(main, status);
			details.appendChild(summary);

			const body = document.createElement('div');
			body.className = 'review-chunk-body';

			for (const suggestion of suggestions) {
				body.appendChild(renderReviewChunkSuggestion(file, chunk, suggestion));
			}

			if (findings.length === 0) {
				const empty = document.createElement('div');
				empty.className = 'review-empty';
				empty.textContent = 'No findings for this chunk.';
				body.appendChild(empty);
			} else {
				for (const finding of findings) {
					body.appendChild(renderReviewChunkFinding(file, finding));
				}
			}
			details.appendChild(body);
			return details;
		}

		function renderReviewChunkSuggestion(file, chunk, suggestion) {
			const applied = chunk.appliedSuggestion && chunk.appliedSuggestion.suggestionId === suggestion.id;
			const wrapper = document.createElement('div');
			wrapper.className = 'review-suggestion' + (applied ? ' applied' : '');
			const header = document.createElement('div');
			header.className = 'review-suggestion-header';
			const title = document.createElement('div');
			title.className = 'review-suggestion-title';
			title.textContent = applied ? 'AI suggestion applied' : 'AI suggestion';
			const action = document.createElement('button');
			action.type = 'button';
			action.className = 'review-suggestion-action';
			action.textContent = applied ? 'Undo' : 'Accept';
			action.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				vscode.postMessage({
					type: applied ? 'undoAiSuggestion' : 'applyAiSuggestion',
					uri: file.uri,
					hunkId: chunk.hunkId,
					suggestionId: suggestion.id,
				});
			});
			header.append(title, action);
			wrapper.appendChild(header);
			const pre = document.createElement('pre');
			pre.className = 'review-suggestion-pre';
			pre.textContent = suggestion.replacementText;
			wrapper.appendChild(pre);
			if (suggestion.rationale) {
				const rationale = document.createElement('div');
				rationale.className = 'review-suggestion-rationale';
				rationale.textContent = suggestion.rationale;
				wrapper.appendChild(rationale);
			}
			return wrapper;
		}

		function renderReviewChunkFinding(file, finding) {
			const button = document.createElement('button');
			button.className = 'review-finding ' + finding.severity;
			button.title = finding.explanation + '\\n\\n' + finding.recommendation;
			button.addEventListener('click', () => vscode.postMessage({ type: 'openFinding', uri: file.uri, hunkId: finding.hunkId }));
			const marker = document.createElement('span');
			marker.className = 'review-finding-marker';
			button.appendChild(marker);
			const body = document.createElement('span');
			const title = document.createElement('span');
			title.className = 'review-finding-title';
			title.textContent = finding.severity + ': ' + finding.title;
			const explanation = document.createElement('span');
			explanation.className = 'review-finding-text';
			explanation.textContent = finding.explanation;
			const recommendation = document.createElement('span');
			recommendation.className = 'review-finding-text';
			recommendation.textContent = finding.recommendation;
			body.append(title, explanation, recommendation);
			button.appendChild(body);
			return button;
		}

		function renderRunLog(items, source) {
			wikiRunList.replaceChildren();
			wikiRunList.hidden = items.length === 0;
			const blocks = source === 'review' || items.some((item) => item.source === 'review' || item.fileUri)
				? groupRunLogByFile(items)
				: groupRunLog(items);
			for (const block of blocks) {
				wikiRunList.appendChild(block.type === 'round'
					? renderRunLogRound(block)
					: block.type === 'file'
						? renderRunLogFile(block)
					: renderRunLogEntry(block.item));
			}
		}

		function groupRunLog(items) {
			const leading = [];
			const trailing = [];
			const rounds = [];
			const roundByNumber = new Map();
			let seenRound = false;
			for (const item of items) {
				if (typeof item.round === 'number') {
					seenRound = true;
					let round = roundByNumber.get(item.round);
					if (!round) {
						round = { type: 'round', round: item.round, items: [] };
						roundByNumber.set(item.round, round);
						rounds.push(round);
					}
					round.items.push(item);
				} else if (!seenRound && item.kind !== 'run_complete' && item.kind !== 'run_error') {
					leading.push({ type: 'entry', item });
				} else {
					trailing.push({ type: 'entry', item });
				}
			}
			return [...leading, ...rounds, ...trailing];
		}

		function groupRunLogByFile(items) {
			const leading = [];
			const trailing = [];
			const files = [];
			const fileByKey = new Map();
			let seenFile = false;
			for (const item of items) {
				const fileKey = item.fileUri || item.relativePath;
				if (fileKey) {
					seenFile = true;
					let file = fileByKey.get(fileKey);
					if (!file) {
						file = {
							type: 'file',
							fileUri: item.fileUri || '',
							relativePath: item.relativePath || item.fileUri || 'File',
							fileIndex: item.fileIndex,
							fileCount: item.fileCount,
							items: [],
						};
						fileByKey.set(fileKey, file);
						files.push(file);
					}
					file.items.push(item);
				} else if (!seenFile && item.kind !== 'run_complete' && item.kind !== 'run_error') {
					leading.push({ type: 'entry', item });
				} else {
					trailing.push({ type: 'entry', item });
				}
			}
			return [...leading, ...files, ...trailing];
		}

		function renderRunLogFile(group) {
			const details = document.createElement('details');
			const statusValue = runLogGroupStatus(group.items);
			details.className = 'wiki-run-file ' + statusValue;

			const summary = document.createElement('summary');
			summary.className = 'wiki-run-file-summary';
			const main = document.createElement('span');
			main.className = 'wiki-run-main';
			const title = document.createElement('span');
			title.className = 'wiki-run-title';
			title.textContent = group.relativePath || 'File';
			const meta = document.createElement('span');
			meta.className = 'wiki-run-meta';
			const position = group.fileIndex && group.fileCount ? 'file ' + group.fileIndex + '/' + group.fileCount + ' | ' : '';
			meta.textContent = position + group.items.length + ' events';
			main.append(title, meta);
			const status = document.createElement('span');
			status.className = 'wiki-run-status ' + statusValue;
			status.textContent = statusValue;
			summary.append(main, status);
			details.appendChild(summary);

			const body = document.createElement('div');
			body.className = 'wiki-run-file-items';
			for (const block of groupRunLog(group.items)) {
				body.appendChild(block.type === 'round'
					? renderRunLogRound(block)
					: renderRunLogEntry(block.item));
			}
			details.appendChild(body);
			return details;
		}

		function renderRunLogRound(group) {
			const details = document.createElement('details');
			const statusValue = roundStatus(group.items);
			details.className = 'wiki-run-round ' + statusValue;

			const summary = document.createElement('summary');
			summary.className = 'wiki-run-round-summary';
			const main = document.createElement('span');
			main.className = 'wiki-run-main';
			const title = document.createElement('span');
			title.className = 'wiki-run-title';
			title.textContent = 'Round ' + group.round;
			const meta = document.createElement('span');
			meta.className = 'wiki-run-meta';
			meta.textContent = group.items.length + ' events';
			main.append(title, meta);
			const status = document.createElement('span');
			status.className = 'wiki-run-status ' + statusValue;
			status.textContent = statusValue;
			summary.append(main, status);
			details.appendChild(summary);

			const body = document.createElement('div');
			body.className = 'wiki-run-round-items';
			for (const item of group.items) {
				body.appendChild(renderRunLogEntry(item));
			}
			details.appendChild(body);
			return details;
		}

		function renderRunLogEntry(item) {
			const details = document.createElement('details');
			details.className = 'wiki-run-item ' + (item.status || 'info');
			details.id = item.id || '';

			const summary = document.createElement('summary');
			summary.className = 'wiki-run-summary';
			const main = document.createElement('span');
			main.className = 'wiki-run-main';
			const title = document.createElement('span');
			title.className = 'wiki-run-title';
			title.textContent = item.title || eventKindLabel(item.kind);
			const meta = document.createElement('span');
			meta.className = 'wiki-run-meta';
			meta.textContent = runLogMeta(item);
			main.append(title, meta);
			const status = document.createElement('span');
			status.className = 'wiki-run-status ' + (item.status || 'info');
			status.textContent = item.status || 'info';
			summary.append(main, status);
			details.appendChild(summary);

			const body = document.createElement('div');
			body.className = 'wiki-run-details';
			for (const detail of item.details || []) {
				const block = document.createElement('div');
				block.className = 'wiki-run-detail';
				const label = document.createElement('span');
				label.className = 'wiki-run-detail-label';
				label.textContent = detail.label || detail.format || 'Detail';
				const pre = document.createElement('pre');
				pre.dataset.format = detail.format || 'text';
				pre.textContent = detail.content || '';
				block.append(label, pre);
				body.appendChild(block);
			}
			if (!body.childElementCount) {
				const block = document.createElement('div');
				block.className = 'wiki-run-detail';
				const pre = document.createElement('pre');
				pre.textContent = item.summary || '';
				block.appendChild(pre);
				body.appendChild(block);
			}
			details.appendChild(body);
			return details;
		}

		function roundStatus(items) {
			return runLogGroupStatus(items);
		}

		function runLogGroupStatus(items) {
			if (items.some((item) => item.status === 'error')) {
				return 'error';
			}
			const lastStatus = [...items].reverse().find((item) => item.status !== 'info')?.status;
			if (lastStatus) {
				return lastStatus;
			}
			return items.length > 0 ? 'info' : 'success';
		}

		function runLogMeta(item) {
			const parts = [eventKindLabel(item.kind)];
			if (typeof item.round === 'number') {
				parts.push('round ' + item.round);
			}
			if (item.summary) {
				parts.push(item.summary);
			}
			return parts.join(' | ');
		}

		function eventKindLabel(kind) {
			const labels = {
				run_start: 'Run start',
				llm_request: 'LLM request',
				llm_response: 'LLM response',
				parse_success: 'Parse success',
				parse_error: 'Parse error',
				tool_call: 'Tool call',
				tool_result: 'Tool result',
				tool_results_context: 'Tool context',
				run_complete: 'Run complete',
				run_error: 'Run event',
			};
			return labels[kind] || 'Run event';
		}

		function isAgentRunning(status) {
			return status === 'initializing' || status === 'updating' || status === 'reviewing';
		}

		function applyProviderCapabilities(providerChanged) {
			const provider = llmProvider.value;
			const deepseek = provider === 'deepseek';
			jsonOutputField.hidden = provider === 'anthropic';
			thinkingModeField.hidden = !deepseek;
			strictToolsField.hidden = !deepseek;
			if (providerChanged) {
				if (deepseek) {
					llmBaseUrl.value = 'https://api.deepseek.com';
					llmModel.value = '';
					llmJsonOutput.checked = true;
					llmThinkingMode.value = 'high';
					llmStrictTools.checked = true;
				} else if (provider === 'anthropic') {
					llmJsonOutput.checked = false;
					llmThinkingMode.value = 'disabled';
					llmStrictTools.checked = false;
				} else {
					llmJsonOutput.checked = true;
					llmThinkingMode.value = 'disabled';
					llmStrictTools.checked = false;
				}
			}
			llmJsonOutput.disabled = deepseek;
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
				pendingSourceCount: 0,
				wikiNeedsUpdate: false,
				findings: [],
				jsonOutputEnabled: true,
				thinkingMode: 'disabled',
				strictTools: false,
				runLog: [],
				reviewFindings: [],
				reviewSuggestions: [],
				aiReviewFileResults: [],
				aiReviewStatus: 'none',
				aiReviewCompletedFileCount: 0,
				aiReviewTotalFileCount: 0,
			};
		}

		function fileRow(file) {
			const row = document.createElement('div');
			row.className = 'file-row' + (file.active ? ' active' : '');
			row.tabIndex = 0;
			row.title = file.skippedReason ? file.relativePath + '\\n' + file.skippedReason : file.relativePath;
			row.addEventListener('click', () => openReviewFile(file));
			row.addEventListener('keydown', (event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					openReviewFile(file);
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

		function openReviewFile(file) {
			reviewDetailUri = file.uri;
			renderWiki(lastWikiState || emptyWikiState());
			vscode.postMessage({ type: 'open', uri: file.uri });
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
	const findingsByChunk = new Map<string, AiReviewFinding[]>();
	const findingsByFile = new Map<string, AiReviewFinding[]>();
	const suggestionsByChunk = new Map<string, AiReviewChunkSuggestion[]>();
	const suggestionsByFile = new Map<string, AiReviewChunkSuggestion[]>();
	const fileResultsByUri = new Map((llmWiki.aiReviewFileResults ?? []).map((result) => [result.uri, result]));
	for (const finding of llmWiki.reviewFindings ?? []) {
		const key = `${finding.uri}#${finding.hunkId}`;
		const list = findingsByChunk.get(key) ?? [];
		list.push(finding);
		findingsByChunk.set(key, list);
		const fileList = findingsByFile.get(finding.uri) ?? [];
		fileList.push(finding);
		findingsByFile.set(finding.uri, fileList);
	}
	for (const suggestion of llmWiki.reviewSuggestions ?? []) {
		const key = `${suggestion.uri}#${suggestion.hunkId}`;
		const list = suggestionsByChunk.get(key) ?? [];
		list.push(suggestion);
		suggestionsByChunk.set(key, list);
		const fileList = suggestionsByFile.get(suggestion.uri) ?? [];
		fileList.push(suggestion);
		suggestionsByFile.set(suggestion.uri, fileList);
	}
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
					chunks: dashboardChunks(file, findingsByChunk, findingsByFile, suggestionsByChunk, suggestionsByFile),
					aiReviewResult: fileResultsByUri.get(file.uri.toString()),
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
		pendingSourceCount: 0,
		wikiNeedsUpdate: false,
		findings: [],
		jsonOutputEnabled: true,
		thinkingMode: 'disabled',
		strictTools: false,
		runLog: [],
		reviewFindings: [],
		reviewSuggestions: [],
		aiReviewFileResults: [],
		aiReviewStatus: 'none',
		aiReviewCompletedFileCount: 0,
		aiReviewTotalFileCount: 0,
	};
}

function dashboardChunks(
	file: ReviewFileState,
	findingsByChunk: Map<string, AiReviewFinding[]>,
	findingsByFile: Map<string, AiReviewFinding[]>,
	suggestionsByChunk: Map<string, AiReviewChunkSuggestion[]>,
	suggestionsByFile: Map<string, AiReviewChunkSuggestion[]>,
): ReviewDashboardChunk[] {
	const uri = file.uri.toString();
	const appliedByHunk = new Map(file.appliedAiSuggestions.map((suggestion) => [suggestion.hunkId, {
		suggestionId: suggestion.suggestionId,
		replacementText: suggestion.replacementText,
	}]));
	const chunks = file.hunks.map((hunk): ReviewDashboardChunk => ({
		hunkId: hunk.id,
		kind: hunk.kind,
		line: hunk.newStart,
		oldLines: hunk.oldLines,
		newLines: hunk.newLines,
		findings: findingsByChunk.get(`${uri}#${hunk.id}`) ?? [],
		suggestions: suggestionsByChunk.get(`${uri}#${hunk.id}`) ?? [],
		appliedSuggestion: appliedByHunk.get(hunk.id),
		reviewStatus: 'pending',
	}));
	const seen = new Set(chunks.map((chunk) => chunk.hunkId));
	for (const item of [...(findingsByFile.get(uri) ?? []), ...(suggestionsByFile.get(uri) ?? [])]) {
		if (seen.has(item.hunkId)) {
			continue;
		}
		seen.add(item.hunkId);
		chunks.push({
			hunkId: item.hunkId,
			kind: 'reviewed',
			line: item.line,
			oldLines: 0,
			newLines: 0,
			findings: findingsByChunk.get(`${uri}#${item.hunkId}`) ?? [],
			suggestions: suggestionsByChunk.get(`${uri}#${item.hunkId}`) ?? [],
			appliedSuggestion: appliedByHunk.get(item.hunkId),
			reviewStatus: 'reviewed',
		});
	}
	return chunks.sort((left, right) => left.line - right.line || left.hunkId.localeCompare(right.hunkId));
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
