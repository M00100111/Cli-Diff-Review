import * as path from 'path';
import * as vscode from 'vscode';
import type { AiReviewChunkSuggestion, AiReviewFileResult, AiReviewFinding } from './agent/codeReview';
import type { ProjectAgentLifecycle, ProjectAgentTaskKind } from './agentRunStore';
import type { AgentTraceDetail, AgentTraceEventKind, AgentTraceStatus } from './agent/runtime';
import type { LlmConfigProfile, LlmProvider, LlmThinkingMode } from './llm/config';
import type { WikiFreshnessAssessment } from './wiki/state';
import { reviewHunkIdentity } from './reviewState';
import { currentReviewProject, hasAggregateReviewTarget, ReviewFileState, ReviewHunk, ReviewSession, uriKey, visibleReviewFiles } from './types';

type DashboardMessage =
	| { type: 'ready' }
	| { type: 'refresh' }
	| { type: 'open'; uri: string }
	| { type: 'acceptFile'; uri: string; revision: number }
	| { type: 'rejectFile'; uri: string; revision: number }
	| { type: 'undoFile'; uri: string; revision: number }
	| { type: 'acceptChunk'; uri: string; hunkId: string; revision: number }
	| { type: 'rejectChunk'; uri: string; hunkId: string; revision: number }
	| { type: 'undoChunk'; uri: string; hunkId: string; revision: number }
	| { type: 'acceptAll' }
	| { type: 'rejectAll' }
	| { type: 'undoAll' }
	| { type: 'closeReviewEditors' }
	| { type: 'selectTrackingTarget' }
	| { type: 'selectTrackingProject'; projectId: string }
	| { type: 'selectGitBranch' }
	| { type: 'exitBranchExtraction' }
	| {
		type: 'saveLlmConfig';
		profileId?: string;
		provider: LlmProvider;
		baseUrl: string;
		model: string;
		apiKey: string;
		jsonOutputEnabled: boolean;
		thinkingMode: LlmThinkingMode;
		strictTools: boolean;
	}
	| { type: 'selectLlmConfigProfile'; profileId: string }
	| { type: 'deleteLlmConfigProfile'; profileId: string }
	| { type: 'initializeWiki' }
	| { type: 'updateWiki' }
	| { type: 'generateAiReview' }
	| { type: 'regenerateAiReview' }
	| { type: 'openWikiIndex' }
	| { type: 'openExtensionSettings' }
	| { type: 'openFinding'; uri: string; hunkId: string }
	| { type: 'openChunk'; uri: string; hunkId: string }
	| { type: 'applyAiSuggestion'; uri: string; hunkId: string; suggestionId: string }
	| { type: 'undoAiSuggestion'; uri: string; hunkId: string; suggestionId: string }
	| { type: 'cancelAgent' };

export interface ReviewDashboardRelatedChunk {
	uri: string;
	hunkId: string;
	relativePath: string;
	line: number;
}

export type ReviewDashboardFinding = AiReviewFinding & { relatedChunks?: ReviewDashboardRelatedChunk[] };

export interface ReviewDashboardChunk {
	hunkId: string;
	kind: string;
	line: number;
	oldLines: number;
	newLines: number;
	findings: ReviewDashboardFinding[];
	suggestions: AiReviewChunkSuggestion[];
	appliedSuggestion?: {
		suggestionId: string;
		replacementText: string;
	};
	reviewStatus?: 'pending' | 'reviewed' | 'resolved';
	reviewDecision?: 'accepted' | 'rejected';
	canAccept: boolean;
	canReject: boolean;
	canUndo: boolean;
}

export interface ReviewDashboardFile {
	uri: string;
	revision: number;
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
	trackingTarget?: {
		label: string;
		branchName?: string;
		extractionSource?: string;
		kind: 'none' | 'aggregate' | 'project';
		canSwitch: boolean;
		disabled: boolean;
		projectCount: number;
	};
	llmWiki?: LlmWikiDashboardState;
}

export type LlmWikiStatus = 'unconfigured' | 'idle' | 'initializing' | 'updating' | 'reviewing' | 'initialized' | 'paused' | 'failed';

export interface LlmWikiRunLogEntry {
	id: string;
	sequence: number;
	timestamp: string;
	source?: 'wiki' | 'review';
	stage?: 'knowledge' | 'plan' | 'file' | 'module' | 'integration';
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

export interface ProjectAgentSummary {
	projectId: string;
	projectName: string;
	branchName?: string;
	rootUri: string;
	taskKind?: ProjectAgentTaskKind;
	lifecycle: ProjectAgentLifecycle | 'idle';
	pendingCount: number;
	acceptedCount: number;
	rejectedCount: number;
	findingCount: number;
	suggestionCount: number;
	progress?: string;
	error?: string;
	running: boolean;
	hasRunLog: boolean;
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
	wikiInitializationAvailable?: boolean;
	wikiInitializationContinuation?: boolean;
	wikiUpdateAvailable?: boolean;
	wikiUpdateContinuation?: boolean;
	wikiOpenAvailable?: boolean;
	findings: ReviewDashboardFinding[];
	jsonOutputEnabled: boolean;
	thinkingMode: LlmThinkingMode;
	strictTools: boolean;
	activeProfileId?: string;
	profiles: LlmConfigProfile[];
	runLog: LlmWikiRunLogEntry[];
	runLogSource?: 'wiki' | 'review';
	reviewFindings: AiReviewFinding[];
	reviewSuggestions: AiReviewChunkSuggestion[];
	aiReviewFileResults: AiReviewFileResult[];
	aiReviewStatus: 'none' | 'partial' | 'complete';
	aiReviewCompletedFileCount: number;
	aiReviewTotalFileCount: number;
	aiReviewError?: string;
	aiReviewKnowledgeFreshness?: WikiFreshnessAssessment;
	agentProjectKey?: string;
	aggregateProjectView?: boolean;
	projectAgents?: ProjectAgentSummary[];
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
			await this.executeCommand('cli-diff.acceptFile', message.uri, message.revision);
			this.postState();
			return;
		}
		if (message.type === 'rejectFile') {
			await this.executeCommand('cli-diff.rejectFile', message.uri, message.revision);
			this.postState();
			return;
		}
		if (message.type === 'undoFile') {
			await this.executeCommand('cli-diff.undoFile', message.uri, message.revision);
			this.postState();
			return;
		}
		if (message.type === 'acceptChunk') {
			await this.executeCommand('cli-diff.acceptChange', message.uri, message.hunkId, message.revision);
			this.postState();
			return;
		}
		if (message.type === 'rejectChunk') {
			await this.executeCommand('cli-diff.rejectChange', message.uri, message.hunkId, message.revision);
			this.postState();
			return;
		}
		if (message.type === 'undoChunk') {
			await this.executeCommand('cli-diff.restoreChange', message.uri, message.hunkId, message.revision);
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
		if (message.type === 'closeReviewEditors') {
			await this.executeCommand('cli-diff.closeReviewEditors');
			return;
		}
		if (message.type === 'selectTrackingTarget') {
			await this.executeCommand('cli-diff.selectTrackingTarget');
			this.postState();
			return;
		}
		if (message.type === 'selectTrackingProject') {
			await this.executeCommand('cli-diff.selectTrackingTarget', message.projectId);
			this.postState();
			return;
		}
		if (message.type === 'selectGitBranch') {
			await this.executeCommand('cli-diff.selectGitBranch');
			this.postState();
			return;
		}
		if (message.type === 'exitBranchExtraction') {
			await this.executeCommand('cli-diff.exitBranchExtraction');
			this.postState();
			return;
		}
		if (message.type === 'saveLlmConfig') {
			const input = {
				provider: message.provider,
				baseUrl: message.baseUrl,
				model: message.model,
				apiKey: message.apiKey,
				jsonOutputEnabled: message.jsonOutputEnabled,
				thinkingMode: message.thinkingMode,
				strictTools: message.strictTools,
			};
			if (message.profileId) {
				(input as { profileId?: string }).profileId = message.profileId;
			}
			await this.executeCommand('cli-diff.saveLlmWikiConfig', input);
			this.postState();
			return;
		}
		if (message.type === 'selectLlmConfigProfile') {
			await this.executeCommand('cli-diff.selectLlmConfigProfile', message.profileId);
			this.postState();
			return;
		}
		if (message.type === 'deleteLlmConfigProfile') {
			await this.executeCommand('cli-diff.deleteLlmConfigProfile', message.profileId);
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
		if (message.type === 'regenerateAiReview') {
			await this.executeCommand('cli-diff.generateAiReview', 'regenerate');
			this.postState();
			return;
		}
		if (message.type === 'openWikiIndex') {
			await this.executeCommand('cli-diff.openWikiIndex');
			this.postState();
			return;
		}
		if (message.type === 'openExtensionSettings') {
			await this.executeCommand('workbench.action.openSettings', '@ext:M00100111.cli-diff-review');
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
		const refreshIconFile = vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..', 'resources', 'refresh.svg');
		const refreshIconUri = typeof webview.asWebviewUri === 'function' ? webview.asWebviewUri(refreshIconFile).toString() : '';
		const mergeIconFile = vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..', 'resources', 'merge.svg');
		const mergeIconUri = typeof webview.asWebviewUri === 'function' ? webview.asWebviewUri(mergeIconFile).toString() : '';
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
		.wiki-panel.has-review-detail,
		.wiki-panel.has-project-agents {
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
		.model-picker {
			width: 100%;
			max-width: 280px;
			display: flex;
			flex-direction: column;
			align-items: stretch;
			gap: 7px;
		}
		.model-list {
			display: flex;
			flex-direction: column;
			gap: 4px;
			max-height: min(42vh, 340px);
			overflow: auto;
		}
		.model-option {
			width: 100%;
			min-height: 34px;
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 6px;
			padding: 5px 6px;
			border: 1px solid var(--tree-border);
			border-radius: 4px;
			text-align: left;
		}
		.model-option.active {
			border-color: var(--accent);
			background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
		}
		.model-option-main {
			min-width: 0;
			display: flex;
			flex-direction: column;
			gap: 2px;
		}
		.model-option-title {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			font-size: 12px;
			font-weight: 600;
		}
		.model-option-meta {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			color: var(--muted);
			font-size: 10px;
		}
		.model-option-check {
			align-self: center;
			color: var(--accent);
			font-size: 12px;
			font-weight: 700;
		}
		.model-empty {
			padding: 6px;
			color: var(--muted);
			font-size: 11px;
			text-align: center;
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
		.wiki-main.has-review-detail,
		.wiki-main.has-project-agents {
			flex: 1 1 auto;
			width: 100%;
			max-width: none;
			min-height: 0;
			align-self: stretch;
			overflow: hidden;
		}
		.wiki-config[hidden],
		.model-picker[hidden],
		.wiki-main[hidden],
		.model-pill[hidden],
		.home-button[hidden],
		.page-close[hidden],
		.wiki-logo[hidden],
		.wiki-action[hidden],
		.wiki-run-list[hidden],
		.project-agent-list[hidden],
		.review-file-detail[hidden] { display: none; }
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
		.wiki-config-actions {
			display: flex;
			align-items: stretch;
			gap: 6px;
		}
		.wiki-config-actions .wiki-save { flex: 1 1 auto; }
		.wiki-config-actions .wiki-action { flex: 0 0 auto; min-width: 64px; }
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
		.wiki-main.has-review-detail .wiki-action,
		.wiki-main.has-project-agents .wiki-action {
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
			white-space: pre-line;
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
		.wiki-main.has-review-detail .review-file-detail,
		.wiki-main.has-project-agents .project-agent-list {
			flex: 1 1 auto;
			width: 100%;
			min-height: 0;
			max-height: none;
			overflow: auto;
		}
		.project-agent-list {
			display: flex;
			flex-direction: column;
			gap: 5px;
			max-height: min(46vh, 380px);
			overflow: auto;
		}
		.project-agent-card {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 7px;
			align-items: start;
			padding: 7px 8px;
			border: 1px solid var(--tree-border);
			border-radius: 4px;
			color: var(--vscode-sideBar-foreground);
			background: var(--vscode-sideBar-background);
			text-align: left;
			cursor: pointer;
		}
		.project-agent-card:hover {
			background: var(--vscode-list-hoverBackground, var(--vscode-sideBar-background));
		}
		.project-agent-main {
			min-width: 0;
			display: flex;
			flex-direction: column;
			gap: 2px;
		}
		.project-agent-heading {
			min-width: 0;
			display: flex;
			align-items: baseline;
			gap: 5px;
			overflow: hidden;
		}
		.project-agent-name {
			flex: 0 1 auto;
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			font-size: 12px;
			font-weight: 600;
		}
		.project-agent-branch {
			flex: 1 1 auto;
			min-width: 0;
			overflow: hidden;
			color: var(--muted);
			font-size: 10px;
			font-weight: 500;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.project-agent-progress {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			color: var(--muted);
			font-size: 10px;
		}
		.project-agent-detail {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			color: var(--muted);
			font-size: 10px;
		}
		.project-agent-state {
			color: var(--muted);
			font-size: 10px;
			font-weight: 600;
			white-space: nowrap;
		}
		.project-agent-card.running .project-agent-state { color: var(--accent); }
		.project-agent-card.completed .project-agent-state { color: var(--untracked); }
		.project-agent-card.failed .project-agent-state,
		.project-agent-card.interrupted .project-agent-state { color: var(--vscode-errorForeground); }
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
		.wiki-run-status.recovering,
		.wiki-run-status.recovered { color: var(--modified); }
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
			overscroll-behavior: contain;
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
		.review-file-detail {
			display: flex;
			flex-direction: column;
			gap: 5px;
			overflow: auto;
			scrollbar-color: var(--vscode-scrollbarSlider-background, rgba(128, 128, 128, 0.35)) transparent;
		}
		.review-file-detail::-webkit-scrollbar-track,
		.review-file-detail::-webkit-scrollbar-corner {
			background: transparent;
		}
		.review-file-detail::-webkit-scrollbar-thumb {
			background-color: var(--vscode-scrollbarSlider-background, rgba(128, 128, 128, 0.35));
			border-radius: 6px;
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
		.review-chunk-summary {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			align-items: start;
			gap: 6px;
			padding: 5px 6px;
			cursor: pointer;
			list-style: none;
		}
		.review-chunk-side {
			display: flex;
			align-items: flex-start;
			gap: 4px;
		}
		.review-chunk-actions {
			display: inline-flex;
			align-items: center;
			gap: 1px;
		}
		.review-chunk-action {
			width: 18px;
			height: 18px;
			padding: 0;
			display: inline-grid;
			place-items: center;
			border-radius: 3px;
		}
		.review-chunk-action svg {
			width: 13px;
			height: 13px;
			stroke: currentColor;
			fill: none;
			stroke-width: 1.8;
			stroke-linecap: round;
			stroke-linejoin: round;
		}
		.review-chunk-action.accept { color: var(--untracked); }
		.review-chunk-action.reject { color: var(--deleted); }
		.review-chunk-action.undo { color: var(--muted); }
		.review-chunk-action:disabled {
			opacity: 0.45;
			cursor: default;
		}
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
		.review-finding.error .review-finding-marker { background: var(--vscode-errorForeground); }
		.review-finding.warning .review-finding-marker { background: var(--vscode-editorWarning-foreground); }
		.review-finding.suggestion .review-finding-marker { background: var(--vscode-editorInfo-foreground); }
		.review-finding-title {
			display: block;
			font-size: 12px;
			font-weight: 600;
			overflow-wrap: anywhere;
			user-select: text;
			cursor: text;
		}
		.review-finding-text {
			display: block;
			margin-top: 3px;
			color: var(--vscode-sideBar-foreground);
			font-size: 11px;
			line-height: 1.35;
			overflow-wrap: anywhere;
			user-select: text;
			cursor: text;
		}
		.review-related-chunks { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
		.review-related-chunk { border: 1px solid var(--tree-border); border-radius: 3px; background: transparent; color: var(--accent); font-size: 10px; line-height: 16px; padding: 0 5px; cursor: pointer; }
		.review-related-chunk:hover { background: var(--toolbar-hover); }
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
			position: relative;
			z-index: 1;
			cursor: default;
			user-select: none;
		}
		.review-suggestion-title {
			flex: 1 1 auto;
			min-width: 0;
			font-size: 11px;
			font-weight: 700;
			color: var(--vscode-editorInfo-foreground);
			overflow-wrap: anywhere;
			cursor: default;
			user-select: none;
		}
		.review-suggestion-action {
			flex: 0 0 auto;
			position: relative;
			z-index: 6;
			min-width: 64px;
			min-height: 22px;
			box-sizing: border-box;
			padding: 1px 8px;
			border: 1px solid color-mix(in srgb, var(--vscode-editorInfo-foreground) 48%, transparent);
			border-radius: 4px;
			color: var(--vscode-editorInfo-foreground);
			background: color-mix(in srgb, var(--vscode-sideBar-background) 76%, var(--vscode-editorInfo-foreground) 24%);
			font-family: var(--vscode-font-family);
			font-size: 12px;
			line-height: 18px;
			white-space: nowrap;
			cursor: pointer;
			user-select: none;
			text-align: center;
			overflow: visible;
		}
		.review-suggestion-action::before {
			content: '';
			position: absolute;
			inset: -6px -4px;
			border-radius: 6px;
		}
		.review-suggestion-action:hover:not(:disabled) {
			background: color-mix(in srgb, var(--vscode-sideBar-background) 66%, var(--vscode-editorInfo-foreground) 34%);
		}
		.review-suggestion-pre {
			max-height: 160px;
			margin: 0;
			padding: 6px;
			overflow: auto;
			overscroll-behavior: contain;
			white-space: pre-wrap;
			overflow-wrap: anywhere;
			font-family: var(--vscode-editor-font-family);
			font-size: 11px;
			line-height: 1.35;
			user-select: text;
			cursor: text;
		}
		.review-suggestion-rationale {
			padding: 0 6px 6px;
			color: var(--muted);
			user-select: text;
			cursor: text;
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
			flex: 1 1 auto;
			min-width: 0;
			display: flex;
			align-items: center;
			gap: 2px;
			overflow: hidden;
		}
		.header-toggle {
			flex: 0 0 auto;
			width: 18px;
			height: 20px;
			display: inline-grid;
			place-items: center;
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
		.tracking-target {
			flex: 0 1 auto;
			min-width: 0;
			max-width: min(220px, 45vw);
			height: 20px;
			padding: 0 3px;
			color: inherit;
			font-weight: 700;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.tracking-target:disabled {
			opacity: 1;
			cursor: default;
		}
		.tracking-branch,
		.tracking-extraction-source {
			flex: 1 1 auto;
			min-width: 0;
			padding: 0;
			border: 0;
			overflow: hidden;
			color: var(--muted);
			background: transparent;
			font-weight: 500;
			text-overflow: ellipsis;
			white-space: nowrap;
			cursor: pointer;
		}
		.tracking-extraction-arrow {
			flex: 0 0 auto;
			width: 15px;
			height: 15px;
		}
		.tracking-branch[hidden],
		.tracking-extraction-arrow[hidden],
		.tracking-extraction-source[hidden] { display: none; }
		.header-actions {
			flex: 0 0 auto;
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
			flex: 0 0 var(--file-extension-column-width, auto);
			width: var(--file-extension-column-width, auto);
			color: var(--vscode-symbolIcon-fileForeground, var(--vscode-icon-foreground));
			font-size: 9px;
			font-weight: 700;
			letter-spacing: 0;
			white-space: nowrap;
			text-transform: uppercase;
			text-align: left;
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
		#refresh img {
			width: 13px;
			height: 13px;
			display: block;
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
					<button class="settings-menu-item" type="button" role="menuitem" data-menu-action="closeReviewEditors">
						<span class="settings-menu-title">Close all Review editors</span>
						<span class="settings-menu-reason"></span>
					</button>
					<div class="settings-menu-divider" role="separator"></div>
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
					<button class="settings-menu-item" type="button" role="menuitem" data-menu-action="regenerateAiReview" hidden>
						<span class="settings-menu-title">Regenerate AI review</span>
						<span class="settings-menu-reason"></span>
					</button>
					<div class="settings-menu-divider" role="separator"></div>
					<button class="settings-menu-item" type="button" role="menuitem" data-menu-action="openWikiIndex">
						<span class="settings-menu-title">Open Code Wiki home</span>
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
			<div class="model-picker" id="modelPicker" hidden>
				<div class="model-list" id="modelList"></div>
				<button class="wiki-action" id="addModelConfig" type="button">Add model configuration</button>
			</div>
			<form class="wiki-config" id="wikiConfig">
				<div class="wiki-field">
					<label for="llmProvider">Provider</label>
					<select id="llmProvider">
						<option value="openai">OpenAI-compatible</option>
						<option value="anthropic">Anthropic</option>
						<option value="deepseek">DeepSeek</option>
						<option value="glm">GLM</option>
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
						<option value="minimal">Minimal</option>
						<option value="low">Low</option>
						<option value="medium">Medium</option>
						<option value="high">High</option>
						<option value="xhigh">XHigh</option>
						<option value="max">Max</option>
					</select>
				</div>
				<label class="wiki-check provider-capability" id="strictToolsField" hidden>
					<input id="llmStrictTools" type="checkbox">
					<span>Strict Tools (Beta)</span>
				</label>
				<div class="wiki-config-actions">
					<button class="wiki-save" id="saveLlmConfig" type="submit">Save</button>
					<button class="wiki-action secondary" id="deleteLlmConfig" type="button" hidden>Delete</button>
				</div>
			</form>
			<div class="wiki-main" id="wikiMain" hidden>
				<img class="wiki-logo" id="wikiLogo" src="${iconUri}" alt="">
				<div class="review-file-detail" id="reviewFileDetail" hidden></div>
				<div class="wiki-run-list" id="wikiRunList" hidden></div>
				<div class="project-agent-list" id="projectAgentList" hidden></div>
				<div class="wiki-status" id="wikiStatus"></div>
				<button class="wiki-action" id="wikiAction" type="button">Initialize LLM Code Wiki</button>
			</div>
		</section>
		<section class="review-tree" aria-label="Cli Diff Review">
			<header class="tree-header">
				<div class="header-left">
					<button class="header-toggle" id="toggle" aria-expanded="true" title="Toggle Cli Diff Review">
						<span class="chevron" aria-hidden="true"></span>
					</button>
					<button class="tracking-target" id="trackingTarget" type="button" title="Select tracked project" disabled></button>
					<button class="tracking-branch" id="trackingBranch" type="button" hidden></button>
					<img class="tracking-extraction-arrow" id="trackingExtractionArrow" src="${mergeIconUri}" alt="" aria-hidden="true" hidden>
					<button class="tracking-extraction-source" id="trackingExtractionSource" type="button" hidden></button>
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
					<button class="refresh-button" id="refresh" type="button" title="Refresh and stage reviewed changes" aria-label="Refresh and stage reviewed changes">
						<img src="${refreshIconUri}" alt="" aria-hidden="true">
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
		const trackingTarget = document.getElementById('trackingTarget');
		const trackingBranch = document.getElementById('trackingBranch');
		const trackingExtractionArrow = document.getElementById('trackingExtractionArrow');
		const trackingExtractionSource = document.getElementById('trackingExtractionSource');
		const list = document.getElementById('list');
		const modelPill = document.getElementById('modelPill');
		const homeButton = document.getElementById('homeButton');
		const closeConfig = document.getElementById('closeConfig');
		const settingsButton = document.getElementById('settingsButton');
		const settingsMenu = document.getElementById('settingsMenu');
		const settingsMenuItems = [...settingsMenu.querySelectorAll('[data-menu-action]')];
		const modelPicker = document.getElementById('modelPicker');
		const modelList = document.getElementById('modelList');
		const addModelConfig = document.getElementById('addModelConfig');
		const wikiConfig = document.getElementById('wikiConfig');
		const wikiMain = document.getElementById('wikiMain');
		const wikiLogo = document.getElementById('wikiLogo');
		const reviewFileDetail = document.getElementById('reviewFileDetail');
		const wikiRunList = document.getElementById('wikiRunList');
		const projectAgentList = document.getElementById('projectAgentList');
		const wikiStatus = document.getElementById('wikiStatus');
		const wikiAction = document.getElementById('wikiAction');
		const llmProvider = document.getElementById('llmProvider');
		const llmBaseUrl = document.getElementById('llmBaseUrl');
		const llmModel = document.getElementById('llmModel');
		const llmApiKey = document.getElementById('llmApiKey');
		const llmJsonOutput = document.getElementById('llmJsonOutput');
		const llmThinkingMode = document.getElementById('llmThinkingMode');
		const llmStrictTools = document.getElementById('llmStrictTools');
		const deleteLlmConfig = document.getElementById('deleteLlmConfig');
		const jsonOutputField = document.getElementById('jsonOutputField');
		const thinkingModeField = document.getElementById('thinkingModeField');
		const strictToolsField = document.getElementById('strictToolsField');
		const acceptAllButton = document.getElementById('acceptAll');
		const rejectAllButton = document.getElementById('rejectAll');
		const undoAllButton = document.getElementById('undoAll');
		let wikiMode = 'main';
		let editingProfileId;
		let apiKeyPlaceholderActive = false;
		acceptAllButton.addEventListener('click', () => vscode.postMessage({ type: 'acceptAll' }));
		rejectAllButton.addEventListener('click', () => vscode.postMessage({ type: 'rejectAll' }));
		undoAllButton.addEventListener('click', () => vscode.postMessage({ type: 'undoAll' }));
		trackingTarget.addEventListener('click', () => vscode.postMessage({ type: 'selectTrackingTarget' }));
		trackingBranch.addEventListener('click', () => vscode.postMessage({ type: 'selectGitBranch' }));
		trackingExtractionSource.addEventListener('click', () => vscode.postMessage({ type: 'exitBranchExtraction' }));
		document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
		modelPill.addEventListener('click', openModelPicker);
		addModelConfig.addEventListener('click', openNewConfig);
		homeButton.addEventListener('click', () => {
			reviewDetailUri = undefined;
			renderWiki(lastWikiState || emptyWikiState());
		});
		closeConfig.addEventListener('click', closeModelPanel);
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
			applyProviderCapabilities(true);
		});
		llmApiKey.addEventListener('focus', () => {
			if (apiKeyPlaceholderActive) {
				llmApiKey.value = '';
				apiKeyPlaceholderActive = false;
			}
		});
		llmApiKey.addEventListener('input', () => {
			apiKeyPlaceholderActive = false;
		});
		llmApiKey.addEventListener('blur', () => {
			if (!llmApiKey.value && currentEditingProfile()?.hasApiKey) {
				showStoredApiKey();
			}
		});
		wikiConfig.addEventListener('submit', (event) => {
			event.preventDefault();
			const profileId = editingProfileId;
			wikiMode = 'main';
			editingProfileId = undefined;
			vscode.postMessage({
				type: 'saveLlmConfig',
				profileId,
				provider: llmProvider.value,
				baseUrl: llmBaseUrl.value,
				model: llmModel.value,
				apiKey: apiKeyPlaceholderActive ? '' : llmApiKey.value,
				jsonOutputEnabled: llmJsonOutput.checked,
				thinkingMode: llmThinkingMode.value,
				strictTools: llmStrictTools.checked,
			});
		});
		deleteLlmConfig.addEventListener('click', () => {
			if (!editingProfileId) {
				return;
			}
			const profileId = editingProfileId;
			wikiMode = 'main';
			editingProfileId = undefined;
			vscode.postMessage({ type: 'deleteLlmConfigProfile', profileId });
		});
		wikiAction.addEventListener('click', () => {
			if (wikiAction.dataset.action === 'addModelConfig') {
				openNewConfig();
				return;
			}
			if (isAgentRunning(lastWikiState?.status) && !lastWikiState?.aggregateProjectView) {
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
		let renderedReviewDetailUri;
		let renderedReviewDetailSignature;
		let renderedRunLogSignature;
		const pendingScrollTops = new WeakMap();
		const suggestionScrollPositions = new Map();
		const runLogDetailScrollPositions = new Map();
		const runLogListScrollPositions = new Map();
		let renderedRunLogProjectKey;
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
			acceptChunk: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5L6.5 11.5L12.5 4.5"/></svg>',
			rejectChunk: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5L11.5 11.5"/><path d="M11.5 4.5L4.5 11.5"/></svg>',
			undoChunk: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 5.5H3.5V3.5"/><path d="M3.8 5.4A5 5 0 1 1 4.9 12"/></svg>',
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
			} else if (wikiMode !== 'main') {
				closeModelPanel();
			}
		});
		vscode.postMessage({ type: 'ready' });

		function render(payload) {
			const files = payload.files || [];
			const listScrollTop = list.scrollTop;
			captureSuggestionScrollPositions();
			pruneSuggestionScrollPositions(files);
			tree.style.removeProperty('--file-extension-column-width');
			lastFiles = files;
			renderTrackingTarget(payload.trackingTarget);
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
				restoreScrollTop(list, listScrollTop);
				return;
			}
			for (const file of files) {
				list.appendChild(fileRow(file));
			}
			updateFileExtensionColumnWidth();
			restoreScrollTop(list, listScrollTop);
		}

		function updateFileExtensionColumnWidth() {
			const width = Array.from(list.querySelectorAll('.file-icon')).reduce((maximum, icon) => (
				Math.max(maximum, Math.ceil(icon.getBoundingClientRect().width))
			), 0);
			if (width > 0) {
				tree.style.setProperty('--file-extension-column-width', width + 'px');
			}
		}

		function restoreScrollTop(container, scrollTop) {
			const pendingScrollTop = pendingScrollTops.get(container);
			const targetScrollTop = pendingScrollTop === undefined ? scrollTop : pendingScrollTop;
			pendingScrollTops.set(container, targetScrollTop);
			requestAnimationFrame(() => {
				if (pendingScrollTops.get(container) !== targetScrollTop) {
					return;
				}
				const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
				container.scrollTop = Math.min(targetScrollTop, maxScrollTop);
				pendingScrollTops.delete(container);
			});
		}

		function suggestionScrollKey(file, suggestion) {
			return file.uri + '::' + suggestion.id;
		}

		function captureSuggestionScrollPositions() {
			for (const pre of reviewFileDetail.querySelectorAll('.review-suggestion-pre[data-suggestion-scroll-key]')) {
				suggestionScrollPositions.set(pre.dataset.suggestionScrollKey, {
					top: pre.scrollTop,
					left: pre.scrollLeft,
				});
			}
		}

		function pruneSuggestionScrollPositions(files) {
			const validKeys = new Set();
			for (const file of files) {
				for (const chunk of file.chunks || []) {
					for (const suggestion of chunk.suggestions || []) {
						validKeys.add(suggestionScrollKey(file, suggestion));
					}
				}
			}
			for (const key of suggestionScrollPositions.keys()) {
				if (!validKeys.has(key)) {
					suggestionScrollPositions.delete(key);
				}
			}
		}

		function restoreSuggestionScrollPosition(pre, key) {
			const position = suggestionScrollPositions.get(key);
			if (!position) {
				return;
			}
			requestAnimationFrame(() => {
				if (!pre.isConnected || pre.dataset.suggestionScrollKey !== key) {
					return;
				}
				pre.scrollTop = Math.min(position.top, Math.max(0, pre.scrollHeight - pre.clientHeight));
				pre.scrollLeft = Math.min(position.left, Math.max(0, pre.scrollWidth - pre.clientWidth));
			});
		}

		function reviewFileDetailSignature(file) {
			if (!file) {
				return '';
			}
			return JSON.stringify({
				uri: file.uri,
				revision: file.revision,
				relativePath: file.relativePath,
				dirty: file.dirty,
				chunks: file.chunks || [],
				aiReviewResult: file.aiReviewResult,
			});
		}

		function renderTrackingTarget(target) {
			const tracking = target || { label: '', canSwitch: false, disabled: false };
			trackingTarget.textContent = tracking.label || '';
			trackingTarget.title = tracking.canSwitch ? 'Select tracked project' : (tracking.label || 'No tracked project');
			trackingTarget.disabled = !tracking.canSwitch || tracking.disabled;
			trackingBranch.textContent = tracking.branchName || '';
			trackingBranch.title = tracking.branchName || '';
			trackingBranch.hidden = !tracking.branchName;
			trackingExtractionSource.textContent = tracking.extractionSource || '';
			trackingExtractionSource.title = tracking.extractionSource ? 'Exit extracted branch review' : '';
			trackingExtractionSource.hidden = !tracking.extractionSource;
			trackingExtractionArrow.hidden = !tracking.extractionSource;
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
			modelPill.hidden = false;
			modelPill.textContent = wiki.configured && wiki.model ? wiki.model : 'No model';
			modelPill.title = 'Select model configuration';
			closeConfig.hidden = wikiMode === 'main';
			modelPicker.hidden = wikiMode !== 'modelPicker';
			wikiConfig.hidden = wikiMode !== 'configEditor';
			wikiMain.hidden = wikiMode !== 'main';
			const runLog = wiki.runLog || [];
			const projectAgents = wiki.projectAgents || [];
			const reviewDetailFile = reviewDetailUri ? lastFiles.find((file) => file.uri === reviewDetailUri) : undefined;
			const hasRunLog = runLog.length > 0 && Boolean(wiki.configured) && wikiMode === 'main';
			const hasReviewDetail = Boolean(reviewDetailFile) && wikiMode === 'main';
			const hasProjectAgents = Boolean(wiki.aggregateProjectView) && projectAgents.length > 0 && wikiMode === 'main' && !hasReviewDetail;
			wikiPanel?.classList.toggle('has-run-log', hasRunLog);
			wikiPanel?.classList.toggle('has-review-detail', hasReviewDetail);
			wikiPanel?.classList.toggle('has-project-agents', hasProjectAgents);
			wikiMain.classList.toggle('has-run-log', hasRunLog);
			wikiMain.classList.toggle('has-review-detail', hasReviewDetail);
			wikiMain.classList.toggle('has-project-agents', hasProjectAgents);
			homeButton.hidden = !hasReviewDetail;
			renderProjectAgents(hasProjectAgents ? projectAgents : []);
			renderSettingsMenu(wiki);
			if (wikiMode === 'modelPicker') {
				renderModelPicker(wiki);
				return;
			}
			if (wikiMode === 'configEditor') {
				deleteLlmConfig.hidden = !editingProfileId;
				return;
			}
			if (!wiki.configured) {
				renderReviewFileDetail(reviewDetailFile);
				renderRunLog([], wiki.runLogSource, wiki.agentProjectKey);
				wikiLogo.hidden = hasReviewDetail || hasProjectAgents;
				wikiAction.classList.remove('secondary');
				wikiAction.hidden = hasReviewDetail;
				wikiAction.disabled = false;
				wikiAction.dataset.action = 'addModelConfig';
				wikiAction.textContent = 'Add model configuration';
				wikiStatus.textContent = hasReviewDetail ? '' : 'No model configured\\nConfigure a model to use Wiki and AI review';
				return;
			}

			const initialized = wiki.status === 'initialized';
			const running = isAgentRunning(wiki.status);
			renderReviewFileDetail(reviewDetailFile);
			renderRunLog(hasReviewDetail || hasProjectAgents ? [] : runLog, wiki.runLogSource, wiki.agentProjectKey);
			wikiLogo.hidden = running || hasRunLog || hasReviewDetail || hasProjectAgents;
			wikiAction.classList.toggle('secondary', running);
			wikiAction.hidden = false;
			wikiAction.disabled = !wiki.workspaceAvailable && !running;
			if (running && !wiki.aggregateProjectView) {
				wikiAction.dataset.action = 'cancelAgent';
				wikiAction.textContent = 'Cancel Agent';
			} else if ((wiki.pendingSourceCount || 0) > 0) {
				wikiAction.dataset.action = 'generateAiReview';
				wikiAction.textContent = wiki.aggregateProjectView ? 'Start project AI review' : aiReviewActionLabel(wiki);
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

		function renderProjectAgents(items) {
			projectAgentList.replaceChildren();
			projectAgentList.hidden = items.length === 0;
			for (const item of items) {
				const card = document.createElement('button');
				card.type = 'button';
				card.className = 'project-agent-card ' + item.lifecycle;
				card.title = 'Show Agent flow for ' + item.projectName;
				card.addEventListener('click', () => vscode.postMessage({ type: 'selectTrackingProject', projectId: item.projectId }));
				const main = document.createElement('span');
				main.className = 'project-agent-main';
				const heading = document.createElement('span');
				heading.className = 'project-agent-heading';
				const name = document.createElement('span');
				name.className = 'project-agent-name';
				name.textContent = item.projectName;
				heading.appendChild(name);
				if (item.branchName) {
					const branch = document.createElement('span');
					branch.className = 'project-agent-branch';
					branch.textContent = item.branchName;
					branch.title = item.branchName;
					heading.appendChild(branch);
				}
				const reviewSummary = document.createElement('span');
				reviewSummary.className = 'project-agent-progress';
				reviewSummary.textContent = projectReviewSummary(item);
				main.append(heading, reviewSummary);
				const detailText = item.running || item.lifecycle === 'failed' || item.lifecycle === 'interrupted'
					? item.error || item.progress
					: undefined;
				if (detailText) {
					const detail = document.createElement('span');
					detail.className = 'project-agent-detail';
					detail.textContent = detailText;
					main.append(detail);
				}
				const state = document.createElement('span');
				state.className = 'project-agent-state';
				state.textContent = projectAgentStateLabel(item);
				card.append(main, state);
				projectAgentList.appendChild(card);
			}
		}

		function projectReviewSummary(item) {
			const parts = [];
			if (item.pendingCount > 0) {
				parts.push(item.pendingCount + ' Pending');
			}
			if (item.acceptedCount > 0) {
				parts.push(item.acceptedCount + ' Accepted');
			}
			if (item.rejectedCount > 0) {
				parts.push(item.rejectedCount + ' Rejected');
			}
			if (item.findingCount > 0) {
				parts.push(item.findingCount + ' Findings');
			}
			if (item.suggestionCount > 0) {
				parts.push(item.suggestionCount + ' Suggestions');
			}
			return parts.length > 0 ? parts.join(' · ') : 'No pending changes';
		}

		function projectAgentStateLabel(item) {
			const kind = item.taskKind === 'review' ? 'AI Review' : item.taskKind === 'update' ? 'Wiki Update' : item.taskKind === 'initialize' ? 'Wiki Init' : '';
			const lifecycle = item.lifecycle === 'idle'
				? 'Idle'
				: item.lifecycle.charAt(0).toUpperCase() + item.lifecycle.slice(1);
			return kind ? kind + ' · ' + lifecycle : lifecycle;
		}

		function renderSettingsMenu(wiki) {
			const running = isAgentRunning(wiki.status) && !wiki.aggregateProjectView;
			const initialized = wiki.status === 'initialized';
			const initializeLabel = wiki.status === 'paused'
				? 'Resume Wiki Initialization'
				: wiki.wikiInitializationContinuation ? 'Continue Wiki Initialization'
					: wiki.status === 'failed' ? 'Retry Wiki Initialization' : 'Initialize LLM Code Wiki';
			const initializationAvailable = wiki.wikiInitializationAvailable ?? !initialized;
			const updateAvailable = wiki.wikiUpdateAvailable ?? wiki.wikiNeedsUpdate;
			const openAvailable = wiki.wikiOpenAvailable ?? initialized;
			setMenuAction('initializeWiki', initializeLabel, running || !wiki.configured || !wiki.workspaceAvailable || !initializationAvailable,
				running ? 'Agent is running'
					: !wiki.configured ? 'Configure LLM first'
						: !wiki.workspaceAvailable ? 'Open a workspace folder'
							: 'Wiki already initialized');
			setMenuAction('updateWiki', wiki.wikiUpdateContinuation ? 'Continue Wiki Update' : 'Update LLM Code Wiki',
				running || !wiki.configured || !wiki.workspaceAvailable || !updateAvailable,
				running ? 'Agent is running'
					: !wiki.configured ? 'Configure LLM first'
						: !wiki.workspaceAvailable ? 'Open a workspace folder'
							: !wiki.wikiExists ? 'Initialize Code Wiki first' : 'Code Wiki is up to date');
			setMenuAction('generateAiReview', wiki.aggregateProjectView ? 'Start project AI review' : aiReviewActionLabel(wiki),
				running || !wiki.configured || !wiki.workspaceAvailable || (wiki.pendingSourceCount || 0) === 0,
				running ? 'Agent is running'
					: !wiki.configured ? 'Configure LLM first'
						: !wiki.workspaceAvailable ? 'Open a workspace folder' : 'No pending source changes');
			setMenuActionVisible('regenerateAiReview', !wiki.aggregateProjectView && wiki.aiReviewStatus === 'partial');
			setMenuAction('regenerateAiReview', 'Regenerate AI review',
				running || !wiki.configured || !wiki.workspaceAvailable || (wiki.pendingSourceCount || 0) === 0,
				running ? 'Agent is running'
					: !wiki.configured ? 'Configure LLM first'
						: !wiki.workspaceAvailable ? 'Open a workspace folder' : 'No pending source changes');
			setMenuAction('openWikiIndex', 'Open Code Wiki home', !openAvailable, openAvailable ? '' : 'Initialize Code Wiki first');
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

		function setMenuActionVisible(action, visible) {
			const item = settingsMenuItems.find((candidate) => candidate.dataset.menuAction === action);
			if (item) {
				item.hidden = !visible;
			}
		}

		function aiReviewActionLabel(wiki) {
			if (wiki.aiReviewStatus === 'complete') {
				return 'Regenerate AI review';
			}
			if (wiki.aiReviewStatus === 'partial') {
				return 'Continue AI review';
			}
			return 'Generate AI review';
		}

		function setSettingsMenuOpen(open) {
			settingsMenu.hidden = !open;
			settingsButton.setAttribute('aria-expanded', String(open));
		}

		function openModelPicker() {
			wikiMode = 'modelPicker';
			editingProfileId = undefined;
			renderWiki(lastWikiState || emptyWikiState());
		}

		function openNewConfig() {
			wikiMode = 'configEditor';
			editingProfileId = undefined;
			populateConfig(newConfigState());
			renderWiki(lastWikiState || emptyWikiState());
		}

		function openEditConfig(profileId) {
			const profile = (lastWikiState?.profiles || []).find((item) => item.id === profileId);
			if (!profile) {
				return;
			}
			wikiMode = 'configEditor';
			editingProfileId = profileId;
			populateConfig(profile);
			renderWiki(lastWikiState || emptyWikiState());
		}

		function closeModelPanel() {
			wikiMode = 'main';
			editingProfileId = undefined;
			renderWiki(lastWikiState || emptyWikiState());
		}

		function currentEditingProfile() {
			if (!editingProfileId) {
				return undefined;
			}
			return (lastWikiState?.profiles || []).find((profile) => profile.id === editingProfileId);
		}

		function populateConfig(config) {
			llmProvider.value = config.provider || 'openai';
			llmBaseUrl.value = config.baseUrl || '';
			llmModel.value = config.model || '';
			llmJsonOutput.checked = Boolean(config.jsonOutputEnabled);
			llmThinkingMode.value = config.thinkingMode || 'disabled';
			llmStrictTools.checked = Boolean(config.strictTools);
			if (config.hasApiKey) {
				showStoredApiKey();
			} else {
				llmApiKey.value = '';
				apiKeyPlaceholderActive = false;
			}
			applyProviderCapabilities(false);
		}

		function renderModelPicker(wiki) {
			modelList.replaceChildren();
			const profiles = wiki.profiles || [];
			if (profiles.length === 0) {
				const empty = document.createElement('div');
				empty.className = 'model-empty';
				empty.textContent = 'No saved models';
				modelList.appendChild(empty);
			}
			for (const profile of profiles) {
				const active = profile.id === wiki.activeProfileId;
				const button = document.createElement('button');
				button.type = 'button';
				button.className = 'model-option' + (active ? ' active' : '');
				button.title = active ? 'Edit current model configuration' : 'Switch to this model configuration';
				const main = document.createElement('span');
				main.className = 'model-option-main';
				const title = document.createElement('span');
				title.className = 'model-option-title';
				title.textContent = profile.model || 'Unnamed model';
				const meta = document.createElement('span');
				meta.className = 'model-option-meta';
				meta.textContent = modelProfileMeta(profile);
				main.appendChild(title);
				main.appendChild(meta);
				button.appendChild(main);
				if (active) {
					const check = document.createElement('span');
					check.className = 'model-option-check';
					check.textContent = 'Current';
					button.appendChild(check);
				}
				button.addEventListener('click', () => {
					if (active) {
						openEditConfig(profile.id);
						return;
					}
					wikiMode = 'main';
					editingProfileId = undefined;
					vscode.postMessage({ type: 'selectLlmConfigProfile', profileId: profile.id });
				});
				modelList.appendChild(button);
			}
		}

		function showStoredApiKey() {
			llmApiKey.value = '********';
			apiKeyPlaceholderActive = true;
		}

		function modelProfileMeta(profile) {
			const parts = [providerLabel(profile.provider)];
			const host = urlHost(profile.baseUrl);
			if (host) {
				parts.push(host);
			}
			if (!profile.configured) {
				parts.push('Incomplete');
			}
			return parts.join(' · ');
		}

		function providerLabel(provider) {
			if (provider === 'anthropic') {
				return 'Anthropic';
			}
			if (provider === 'deepseek') {
				return 'DeepSeek';
			}
			if (provider === 'glm') {
				return 'GLM';
			}
			return 'OpenAI-compatible';
		}

		function urlHost(value) {
			try {
				return new URL(value).host;
			} catch {
				return '';
			}
		}

		function newConfigState() {
			return {
				provider: 'openai',
				baseUrl: '',
				model: '',
				hasApiKey: false,
				jsonOutputEnabled: true,
				thinkingMode: 'disabled',
				strictTools: false,
			};
		}

		function wikiStatusText(wiki, initialized, running) {
			if (!wiki.workspaceAvailable && !running) {
				return 'Open a workspace folder';
			}
			if (wiki.aggregateProjectView) {
				const runningProjects = (wiki.projectAgents || []).filter((item) => item.running).length;
				return runningProjects > 0
					? runningProjects + ' project Agent task' + (runningProjects === 1 ? '' : 's') + ' running'
					: 'Select a project to view its Agent flow';
			}
			if (running) {
				return wiki.progress || 'Agent running';
			}
			if (wiki.aiReviewStatus === 'complete') {
				return 'AI review ready';
			}
			if (wiki.aiReviewStatus === 'partial') {
				const completed = wiki.aiReviewCompletedFileCount || 0;
				const total = wiki.aiReviewTotalFileCount || 0;
				return wiki.aiReviewError
					? 'AI review failed after ' + completed + '/' + total + ' files'
					: 'AI review partial: ' + completed + '/' + total + ' files';
			}
			const freshness = wiki.aiReviewKnowledgeFreshness;
			if (freshness?.status === 'stale') {
				return 'Wiki knowledge may be stale: ' + freshness.totalChangedSourceCount + ' source files changed since the last synchronization';
			}
			if (freshness?.status === 'unknown' && wiki.aiReviewStatus !== 'none') {
				return 'Wiki freshness is unknown; current source remains authoritative';
			}
			if (initialized) {
				return 'Knowledge base initialized';
			}
			if (wiki.status === 'failed') {
				return wiki.error || 'Initialization failed';
			}
			if (wiki.status === 'paused') {
				return wiki.progress || 'Initialization paused';
			}
			return wiki.progress || 'Ready';
		}

		function renderReviewFileDetail(file) {
			const nextSignature = reviewFileDetailSignature(file);
			if (renderedReviewDetailUri === file?.uri && renderedReviewDetailSignature === nextSignature) {
				reviewFileDetail.hidden = !file;
				return;
			}
			captureSuggestionScrollPositions();
			const shouldRestoreScroll = Boolean(file) && renderedReviewDetailUri === file.uri;
			const pendingDetailScrollTop = pendingScrollTops.get(reviewFileDetail);
			const detailScrollTop = shouldRestoreScroll
				? (pendingDetailScrollTop === undefined ? reviewFileDetail.scrollTop : pendingDetailScrollTop)
				: 0;
			if (!shouldRestoreScroll) {
				pendingScrollTops.delete(reviewFileDetail);
			}
			renderedReviewDetailUri = file?.uri;
			renderedReviewDetailSignature = nextSignature;
			reviewFileDetail.replaceChildren();
			reviewFileDetail.hidden = !file;
			if (!file) {
				reviewFileDetail.scrollTop = 0;
				pendingScrollTops.delete(reviewFileDetail);
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
				pendingScrollTops.delete(reviewFileDetail);
				return;
			}

			for (const chunk of file.chunks) {
				reviewFileDetail.appendChild(renderReviewChunk(file, chunk));
			}
			if (shouldRestoreScroll) {
				restoreScrollTop(reviewFileDetail, detailScrollTop);
			} else {
				reviewFileDetail.scrollTop = 0;
			}
		}

		function shouldNavigateReviewCard(event, container) {
			const target = event.target instanceof Element ? event.target : undefined;
			if (target?.closest('button, a')) {
				return false;
			}
			const selection = window.getSelection();
			if (!selection || selection.isCollapsed || selection.toString().length === 0) {
				return true;
			}
			return !container.contains(selection.anchorNode) && !container.contains(selection.focusNode);
		}

		function renderReviewChunk(file, chunk) {
			const findings = chunk.findings || [];
			const suggestions = chunk.suggestions || [];
			const container = document.createElement('div');
			const kindClass = ['add', 'delete', 'modify'].includes(chunk.kind) ? chunk.kind : 'modify';
			container.className = 'review-chunk ' + kindClass
				+ (findings.length > 0 ? ' has-findings' : ' no-findings')
				+ (suggestions.length > 0 ? ' has-suggestion' : '');

			const header = document.createElement('div');
			header.className = 'review-chunk-summary';
			header.setAttribute('role', 'button');
			header.tabIndex = 0;
			header.addEventListener('click', () => vscode.postMessage({ type: 'openChunk', uri: file.uri, hunkId: chunk.hunkId }));
			header.addEventListener('keydown', (event) => {
				if (event.key !== 'Enter' && event.key !== ' ') {
					return;
				}
				event.preventDefault();
				vscode.postMessage({ type: 'openChunk', uri: file.uri, hunkId: chunk.hunkId });
			});
			const main = document.createElement('span');
			main.className = 'wiki-run-main';
			const title = document.createElement('span');
			title.className = 'wiki-run-title';
			const decisionLabel = chunk.reviewDecision === 'accepted'
				? 'Accepted'
				: chunk.reviewDecision === 'rejected'
					? 'Rejected'
					: chunk.reviewStatus === 'pending' ? 'Pending' : '';
			title.textContent = (decisionLabel ? decisionLabel + ' · ' : '') + chunk.kind + ' ' + chunk.oldLines + '->' + chunk.newLines + ' lines';
			const meta = document.createElement('span');
			meta.className = 'wiki-run-meta';
			meta.textContent = 'line ' + (chunk.line + 1) + ' | ' + (findings.length || 'No') + ' findings'
				+ (suggestions.length > 0 ? ' | ' + suggestions.length + ' suggestion' + (suggestions.length === 1 ? '' : 's') : '');
			main.append(title, meta);
			const side = document.createElement('span');
			side.className = 'review-chunk-side';
			const actions = document.createElement('span');
			actions.className = 'review-chunk-actions';
			if (chunk.reviewStatus === 'reviewed') {
				actions.appendChild(chunkActionButton('undoChunk', file.uri, chunk.hunkId, file.revision, !chunk.canUndo, 'Undo chunk', 'undo'));
			} else if (chunk.reviewStatus === 'pending') {
				actions.appendChild(chunkActionButton('rejectChunk', file.uri, chunk.hunkId, file.revision, !chunk.canReject, 'Reject chunk', 'reject'));
				actions.appendChild(chunkActionButton('acceptChunk', file.uri, chunk.hunkId, file.revision, !chunk.canAccept, 'Accept chunk', 'accept'));
			}
			side.append(actions);
			header.append(main, side);
			container.appendChild(header);

			if (suggestions.length === 0 && findings.length === 0) {
				return container;
			}

			const body = document.createElement('div');
			body.className = 'review-chunk-body';
			for (const suggestion of suggestions) {
				body.appendChild(renderReviewChunkSuggestion(file, chunk, suggestion));
			}

			for (const finding of findings) {
				body.appendChild(renderReviewChunkFinding(file, finding));
			}
			container.appendChild(body);
			return container;
		}

		function renderReviewChunkSuggestion(file, chunk, suggestion) {
			const applied = chunk.appliedSuggestion && chunk.appliedSuggestion.suggestionId === suggestion.id;
			const canApply = chunk.reviewStatus === 'pending' && !applied;
			const wrapper = document.createElement('div');
			wrapper.className = 'review-suggestion' + (applied ? ' applied' : '');
			wrapper.addEventListener('click', (event) => {
				if (!shouldNavigateReviewCard(event, wrapper)) {
					return;
				}
				vscode.postMessage({ type: 'openChunk', uri: file.uri, hunkId: chunk.hunkId });
			});
			const header = document.createElement('div');
			header.className = 'review-suggestion-header';
			const title = document.createElement('div');
			title.className = 'review-suggestion-title';
			title.textContent = applied ? 'AI suggestion applied' : 'AI suggestion';
			header.appendChild(title);
			if (canApply) {
				const action = document.createElement('button');
				action.type = 'button';
				action.className = 'review-suggestion-action';
				action.textContent = 'Accept';
				action.title = 'Accept AI suggestion';
				action.setAttribute('aria-label', 'Accept AI suggestion');
				action.addEventListener('click', (event) => {
					event.preventDefault();
					event.stopPropagation();
					vscode.postMessage({
						type: 'applyAiSuggestion',
						uri: file.uri,
						hunkId: chunk.hunkId,
						suggestionId: suggestion.id,
					});
				});
				header.appendChild(action);
			} else if (applied && (chunk.reviewStatus === 'pending' || chunk.reviewStatus === 'resolved')) {
				const action = document.createElement('button');
				action.type = 'button';
				action.className = 'review-suggestion-action';
				action.textContent = 'Undo';
				action.title = 'Undo AI suggestion';
				action.setAttribute('aria-label', 'Undo AI suggestion');
				action.addEventListener('click', (event) => {
					event.preventDefault();
					event.stopPropagation();
					vscode.postMessage({
						type: 'undoAiSuggestion',
						uri: file.uri,
						hunkId: chunk.hunkId,
						suggestionId: suggestion.id,
					});
				});
				header.appendChild(action);
			}
			wrapper.appendChild(header);
			const pre = document.createElement('pre');
			pre.className = 'review-suggestion-pre';
			const scrollKey = suggestionScrollKey(file, suggestion);
			pre.dataset.suggestionScrollKey = scrollKey;
			pre.textContent = suggestion.replacementText;
			restoreSuggestionScrollPosition(pre, scrollKey);
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
			const container = document.createElement('div');
			container.className = 'review-finding ' + finding.severity;
			container.title = finding.explanation + '\\n\\n' + finding.recommendation;
			container.setAttribute('role', 'button');
			container.tabIndex = 0;
			const openPrimary = () => vscode.postMessage({ type: 'openFinding', uri: file.uri, hunkId: finding.hunkId });
			container.addEventListener('click', (event) => {
				if (shouldNavigateReviewCard(event, container)) {
					openPrimary();
				}
			});
			container.addEventListener('keydown', (event) => {
				if (event.target !== container || (event.key !== 'Enter' && event.key !== ' ')) {
					return;
				}
				event.preventDefault();
				openPrimary();
			});
			const marker = document.createElement('span');
			marker.className = 'review-finding-marker';
			container.appendChild(marker);
			const body = document.createElement('span');
			const title = document.createElement('span');
			title.className = 'review-finding-title';
			title.textContent = (finding.source === 'integration' ? 'integration ' : '') + finding.severity + ': ' + finding.title;
			const explanation = document.createElement('span');
			explanation.className = 'review-finding-text';
			explanation.textContent = finding.explanation;
			const recommendation = document.createElement('span');
			recommendation.className = 'review-finding-text';
			recommendation.textContent = finding.recommendation;
			body.append(title, explanation, recommendation);
			if (finding.relatedChunks && finding.relatedChunks.length > 0) {
				const related = document.createElement('span');
				related.className = 'review-related-chunks';
				for (const chunk of finding.relatedChunks) {
					const relatedButton = document.createElement('button');
					relatedButton.type = 'button';
					relatedButton.className = 'review-related-chunk';
					relatedButton.textContent = chunk.relativePath + ':' + (chunk.line + 1);
					relatedButton.title = 'Open related chunk ' + chunk.relativePath + ':' + (chunk.line + 1);
					relatedButton.addEventListener('click', (event) => {
						event.stopPropagation();
						vscode.postMessage({ type: 'openChunk', uri: chunk.uri, hunkId: chunk.hunkId });
					});
					related.appendChild(relatedButton);
				}
				body.appendChild(related);
			}
			container.appendChild(body);
			return container;
		}

		function renderRunLog(items, source, projectKey) {
			const nextSignature = runLogSignature(items, source, projectKey);
			if (renderedRunLogSignature === nextSignature) {
				wikiRunList.hidden = items.length === 0;
				return;
			}
			if (renderedRunLogProjectKey) {
				runLogListScrollPositions.set(renderedRunLogProjectKey, wikiRunList.scrollTop);
			}
			captureRunLogDetailScrollPositions();
			const openRunLogKeys = new Set();
			for (const details of wikiRunList.querySelectorAll('details[data-run-log-key][open]')) {
				openRunLogKeys.add(details.dataset.runLogKey);
			}
			const runLogScrollTop = projectKey ? runLogListScrollPositions.get(projectKey) || 0 : 0;
			wikiRunList.replaceChildren();
			wikiRunList.hidden = items.length === 0;
			renderedRunLogSignature = nextSignature;
			renderedRunLogProjectKey = projectKey;
			const blocks = source === 'review' || items.some((item) => item.source === 'review' || item.fileUri)
				? groupRunLogByFile(items)
				: groupRunLog(items);
			for (const block of blocks) {
				wikiRunList.appendChild(block.type === 'round'
					? renderRunLogRound(block, openRunLogKeys)
					: block.type === 'file'
						? renderRunLogFile(block, openRunLogKeys)
					: renderRunLogEntry(block.item, openRunLogKeys));
			}
			pruneRunLogDetailScrollPositions();
			restoreScrollTop(wikiRunList, runLogScrollTop);
		}

		function runLogSignature(items, source, projectKey) {
			return JSON.stringify({ projectKey: projectKey || '', source: source || '', items });
		}

		function captureRunLogDetailScrollPositions() {
			for (const pre of wikiRunList.querySelectorAll('.wiki-run-detail pre[data-run-log-detail-scroll-key]')) {
				runLogDetailScrollPositions.set(pre.dataset.runLogDetailScrollKey, {
					top: pre.scrollTop,
					left: pre.scrollLeft,
				});
			}
		}

		function pruneRunLogDetailScrollPositions() {
			const validKeys = new Set([...wikiRunList.querySelectorAll('.wiki-run-detail pre[data-run-log-detail-scroll-key]')]
				.map((pre) => pre.dataset.runLogDetailScrollKey));
			for (const key of runLogDetailScrollPositions.keys()) {
				if (!validKeys.has(key)) {
					runLogDetailScrollPositions.delete(key);
				}
			}
		}

		function restoreRunLogDetailScrollPosition(pre, key) {
			const position = runLogDetailScrollPositions.get(key);
			if (!position) {
				return;
			}
			requestAnimationFrame(() => {
				if (!pre.isConnected || pre.dataset.runLogDetailScrollKey !== key) {
					return;
				}
				pre.scrollTop = Math.min(position.top, Math.max(0, pre.scrollHeight - pre.clientHeight));
				pre.scrollLeft = Math.min(position.left, Math.max(0, pre.scrollWidth - pre.clientWidth));
			});
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

		function applyRunLogDetailsState(details, key, openRunLogKeys) {
			details.dataset.runLogKey = key;
			details.open = openRunLogKeys.has(key);
			return details;
		}

		function runLogFileKey(group) {
			return 'file:' + (group.fileUri || group.relativePath || '');
		}

		function runLogRoundKey(group, parentKey) {
			return (parentKey || '') + 'round:' + group.round;
		}

		function runLogEntryKey(item, parentKey) {
			const identity = item.id || (typeof item.sequence === 'number' ? 'sequence:' + item.sequence : item.timestamp || item.title || item.kind || '');
			return (parentKey || '') + 'event:' + identity;
		}

		function renderRunLogFile(group, openRunLogKeys) {
			const details = document.createElement('details');
			const statusValue = runLogGroupStatus(group.items);
			details.className = 'wiki-run-file ' + statusValue;
			applyRunLogDetailsState(details, runLogFileKey(group), openRunLogKeys);

			const summary = document.createElement('summary');
			summary.className = 'wiki-run-file-summary';
			const main = document.createElement('span');
			main.className = 'wiki-run-main';
			const title = document.createElement('span');
			title.className = 'wiki-run-title';
			title.textContent = group.relativePath || 'File';
			const meta = document.createElement('span');
			meta.className = 'wiki-run-meta';
			const moduleGroup = group.items.some((item) => item.stage === 'module');
			const position = group.fileIndex && group.fileCount
				? (moduleGroup ? 'module ' : 'file ') + group.fileIndex + '/' + group.fileCount + ' | '
				: '';
			meta.textContent = position + runLogCountsMeta(group.items) + runLogRecoveryMeta(statusValue);
			main.append(title, meta);
			const status = document.createElement('span');
			status.className = 'wiki-run-status ' + statusValue;
			status.textContent = statusValue;
			summary.append(main, status);
			details.appendChild(summary);

			const body = document.createElement('div');
			body.className = 'wiki-run-file-items';
			const parentKey = runLogFileKey(group) + '/';
			for (const block of groupRunLog(group.items)) {
				body.appendChild(block.type === 'round'
					? renderRunLogRound(block, openRunLogKeys, parentKey)
					: renderRunLogEntry(block.item, openRunLogKeys, parentKey));
			}
			details.appendChild(body);
			return details;
		}

		function runLogCountsMeta(items) {
			const roundCount = new Set(items
				.filter((item) => typeof item.round === 'number')
				.map((item) => item.round)).size;
			const eventCount = items.length;
			return roundCount + ' ' + (roundCount === 1 ? 'round' : 'rounds')
				+ ' · ' + eventCount + ' ' + (eventCount === 1 ? 'event' : 'events');
		}

		function renderRunLogRound(group, openRunLogKeys, parentKey) {
			const details = document.createElement('details');
			const statusValue = roundStatus(group.items);
			details.className = 'wiki-run-round ' + statusValue;
			applyRunLogDetailsState(details, runLogRoundKey(group, parentKey), openRunLogKeys);

			const summary = document.createElement('summary');
			summary.className = 'wiki-run-round-summary';
			const main = document.createElement('span');
			main.className = 'wiki-run-main';
			const title = document.createElement('span');
			title.className = 'wiki-run-title';
			title.textContent = 'Round ' + group.round;
			const meta = document.createElement('span');
			meta.className = 'wiki-run-meta';
			meta.textContent = group.items.length + ' events' + runLogRecoveryMeta(statusValue);
			main.append(title, meta);
			const status = document.createElement('span');
			status.className = 'wiki-run-status ' + statusValue;
			status.textContent = statusValue;
			summary.append(main, status);
			details.appendChild(summary);

			const body = document.createElement('div');
			body.className = 'wiki-run-round-items';
			for (const item of group.items) {
				body.appendChild(renderRunLogEntry(item, openRunLogKeys, (parentKey || '') + 'round:' + group.round + '/'));
			}
			details.appendChild(body);
			return details;
		}

		function renderRunLogEntry(item, openRunLogKeys, parentKey) {
			const details = document.createElement('details');
			details.className = 'wiki-run-item ' + (item.status || 'info');
			details.id = item.id || '';
			const entryKey = runLogEntryKey(item, parentKey);
			applyRunLogDetailsState(details, entryKey, openRunLogKeys);

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
			for (const [detailIndex, detail] of (item.details || []).entries()) {
				const block = document.createElement('div');
				block.className = 'wiki-run-detail';
				const label = document.createElement('span');
				label.className = 'wiki-run-detail-label';
				label.textContent = detail.label || detail.format || 'Detail';
				const pre = document.createElement('pre');
				const scrollKey = entryKey + '/detail:' + detailIndex;
				pre.dataset.format = detail.format || 'text';
				pre.dataset.runLogDetailScrollKey = scrollKey;
				pre.textContent = detail.content || '';
				restoreRunLogDetailScrollPosition(pre, scrollKey);
				block.append(label, pre);
				body.appendChild(block);
			}
			if (!body.childElementCount) {
				const block = document.createElement('div');
				block.className = 'wiki-run-detail';
				const pre = document.createElement('pre');
				const scrollKey = entryKey + '/detail:0';
				pre.dataset.runLogDetailScrollKey = scrollKey;
				pre.textContent = item.summary || '';
				restoreRunLogDetailScrollPosition(pre, scrollKey);
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
			let lastErrorIndex = -1;
			for (let index = items.length - 1; index >= 0; index -= 1) {
				if (items[index].status === 'error') {
					lastErrorIndex = index;
					break;
				}
			}
			if (lastErrorIndex >= 0) {
				const laterItems = items.slice(lastErrorIndex + 1);
				const recovered = laterItems.some((item) => item.status === 'success'
					&& (item.kind === 'parse_success' || item.kind === 'run_complete'));
				if (recovered) {
					return 'recovered';
				}
				const recovering = laterItems.some((item) => item.status === 'running' && item.kind === 'llm_request');
				return recovering ? 'recovering' : 'error';
			}
			const lastStatus = [...items].reverse().find((item) => item.status !== 'info')?.status;
			if (lastStatus) {
				return lastStatus;
			}
			return items.length > 0 ? 'info' : 'success';
		}

		function runLogRecoveryMeta(status) {
			if (status === 'recovering') {
				return ' · Recovering after error';
			}
			if (status === 'recovered') {
				return ' · Recovered after error';
			}
			return '';
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
			const glm = provider === 'glm';
			const thinking = deepseek || glm;
			updateThinkingModeOptions(provider, llmThinkingMode.value);
			jsonOutputField.hidden = provider === 'anthropic';
			thinkingModeField.hidden = !thinking;
			strictToolsField.hidden = !deepseek;
			if (providerChanged) {
				if (deepseek) {
					llmBaseUrl.value = 'https://api.deepseek.com';
					llmModel.value = '';
					llmJsonOutput.checked = true;
					llmThinkingMode.value = 'high';
					llmStrictTools.checked = true;
				} else if (glm) {
					llmBaseUrl.value = 'https://open.bigmodel.cn/api/coding/paas/v4';
					llmModel.value = 'glm-5.2';
					llmJsonOutput.checked = true;
					llmThinkingMode.value = 'high';
					llmStrictTools.checked = false;
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
			updateThinkingModeOptions(provider, llmThinkingMode.value);
			llmJsonOutput.disabled = deepseek || glm;
		}

		function updateThinkingModeOptions(provider, currentValue) {
			const optionSets = {
				deepseek: [
					['disabled', 'Disabled'],
					['high', 'High'],
					['max', 'Max'],
				],
				glm: [
					['disabled', 'Disabled'],
					['minimal', 'Minimal'],
					['low', 'Low'],
					['medium', 'Medium'],
					['high', 'High'],
					['xhigh', 'XHigh'],
					['max', 'Max'],
				],
				default: [['disabled', 'Disabled']],
			};
			const options = optionSets[provider] || optionSets.default;
			llmThinkingMode.replaceChildren(...options.map(([value, label]) => {
				const option = document.createElement('option');
				option.value = value;
				option.textContent = label;
				return option;
			}));
			const fallback = provider === 'deepseek' || provider === 'glm' ? 'high' : 'disabled';
			llmThinkingMode.value = options.some(([value]) => value === currentValue) ? currentValue : fallback;
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
				wikiInitializationAvailable: true,
				wikiUpdateAvailable: false,
				wikiOpenAvailable: false,
				findings: [],
				jsonOutputEnabled: true,
				thinkingMode: 'disabled',
				strictTools: false,
				activeProfileId: undefined,
				profiles: [],
				runLog: [],
				reviewFindings: [],
				reviewSuggestions: [],
				aiReviewFileResults: [],
				aiReviewStatus: 'none',
				aiReviewCompletedFileCount: 0,
				aiReviewTotalFileCount: 0,
				projectAgents: [],
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
			icon.title = file.fileExtension || '';
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
			actions.appendChild(actionButton('acceptFile', file.uri, file.revision, file.acceptDisabled, 'Accept file'));
			actions.appendChild(actionButton('rejectFile', file.uri, file.revision, file.rejectDisabled, 'Reject file'));
			actions.appendChild(actionButton('undoFile', file.uri, file.revision, file.undoDisabled, 'Undo file'));
			return row;
		}

		function openReviewFile(file) {
			reviewDetailUri = file.uri;
			renderWiki(lastWikiState || emptyWikiState());
			vscode.postMessage({ type: 'open', uri: file.uri });
		}

		function actionButton(type, uri, revision, disabled, title) {
			const button = document.createElement('button');
			button.className = 'icon-button';
			button.title = title;
			button.setAttribute('aria-label', title);
			button.innerHTML = icons[type] || '';
			button.disabled = Boolean(disabled);
			button.addEventListener('click', (event) => {
				event.stopPropagation();
				markReviewActionPending(button);
				vscode.postMessage({ type, uri, revision });
			});
			return button;
		}

		function chunkActionButton(type, uri, hunkId, revision, disabled, title, tone) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'icon-button review-chunk-action ' + tone;
			button.title = title;
			button.setAttribute('aria-label', title);
			button.innerHTML = icons[type] || '';
			button.disabled = Boolean(disabled);
			button.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				if (button.disabled) {
					return;
				}
				markReviewActionPending(button);
				vscode.postMessage({ type, uri, hunkId, revision });
			});
			return button;
		}

		function markReviewActionPending(button) {
			button.disabled = true;
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
	extractionSource?: string,
	extractionTargetLabel?: string,
): ReviewDashboardPayload {
	const currentKey = currentReviewUri ? uriKey(currentReviewUri) : undefined;
	const hunkLinksById = dashboardHunkLinks(session);
	const findingsByChunk = new Map<string, ReviewDashboardFinding[]>();
	const findingsByFile = new Map<string, ReviewDashboardFinding[]>();
	const suggestionsByChunk = new Map<string, AiReviewChunkSuggestion[]>();
	const suggestionsByFile = new Map<string, AiReviewChunkSuggestion[]>();
	const fileResultsByUri = new Map((llmWiki.aiReviewFileResults ?? []).map((result) => [result.uri, result]));
	for (const finding of llmWiki.reviewFindings ?? []) {
		const dashboardFinding = dashboardFindingWithRelatedChunks(finding, hunkLinksById);
		const key = `${finding.uri}#${finding.hunkId}`;
		const list = findingsByChunk.get(key) ?? [];
		list.push(dashboardFinding);
		findingsByChunk.set(key, list);
		const fileList = findingsByFile.get(finding.uri) ?? [];
		fileList.push(dashboardFinding);
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
	const currentProject = currentReviewProject(session);
	const aggregate = hasAggregateReviewTarget(session) && session?.trackingTarget?.kind === 'aggregate';
	const files = session
		? visibleReviewFiles(session)
			.filter((file) => file.hunks.length > 0
				|| file.acceptedHunks.length > 0
				|| file.rejectedHunks.length > 0
				|| file.appliedAiSuggestions.some((suggestion) => suggestion.resolvedToIndex)
				|| file.skippedReason)
			.sort((left, right) => (left.projectName ?? '').localeCompare(right.projectName ?? '')
				|| left.relativePath.localeCompare(right.relativePath))
			.map((file) => {
				const pendingHunks = dashboardPendingHunks(file);
				const pendingCount = pendingHunks.length;
				const acceptedCount = file.acceptedHunks.length;
				const rejectedCount = file.rejectedHunks.length;
				const reviewedCount = acceptedCount + rejectedCount;
				const fileUri = file.uri.toString();
				const findingCount = findingsByFile.get(fileUri)?.length ?? 0;
				const suggestionCount = suggestionsByFile.get(fileUri)?.length ?? 0;
				const dirty = isDirty(file.uri);
				const mutationDisabled = dirty || Boolean(file.skippedReason);
				const status = dashboardStatus(file);
				const displayPath = aggregate && file.projectName ? `${file.projectName}/${file.relativePath}` : file.relativePath;
				return {
					uri: fileUri,
					revision: file.revision,
					relativePath: displayPath,
					fileExtension: dashboardExtension(displayPath),
					description: dashboardDescription(
						pendingCount,
						acceptedCount,
						rejectedCount,
						findingCount,
						suggestionCount,
						dirty,
						file.skippedReason,
					),
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
					chunks: dashboardChunks(file, pendingHunks, findingsByChunk, suggestionsByChunk, mutationDisabled),
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
		trackingTarget: {
			label: session ? currentProject?.name ?? path.basename(session.rootUri.fsPath) : '',
			branchName: currentProject ? extractionTargetLabel ?? currentProject.branchName : undefined,
			extractionSource: currentProject ? extractionSource : undefined,
			kind: !session ? 'none' : currentProject ? 'project' : session.trackingTarget?.kind === 'aggregate' ? 'aggregate' : 'project',
			canSwitch: hasAggregateReviewTarget(session),
			disabled: false,
			projectCount: session?.projects?.length ?? (session ? 1 : 0),
		},
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
		wikiInitializationAvailable: true,
		wikiUpdateAvailable: false,
		wikiOpenAvailable: false,
		findings: [],
		jsonOutputEnabled: true,
		thinkingMode: 'disabled',
		strictTools: false,
		activeProfileId: undefined,
		profiles: [],
		runLog: [],
		reviewFindings: [],
		reviewSuggestions: [],
		aiReviewFileResults: [],
		aiReviewStatus: 'none',
		aiReviewCompletedFileCount: 0,
		aiReviewTotalFileCount: 0,
		projectAgents: [],
	};
}

function dashboardHunkLinks(session: ReviewSession | undefined): Map<string, ReviewDashboardRelatedChunk[]> {
	const links = new Map<string, ReviewDashboardRelatedChunk[]>();
	for (const file of visibleReviewFiles(session)) {
		for (const hunk of file.hunks) {
			const link = { uri: file.uri.toString(), hunkId: hunk.id, relativePath: file.relativePath, line: hunk.newStart };
			addDashboardHunkLink(links, hunk.id, link);
			addDashboardHunkLink(links, hunk.reviewItemId ?? hunk.sourceHunkId ?? hunk.id, link);
			if (hunk.sourceHunkId) {
				addDashboardHunkLink(links, hunk.sourceHunkId, link);
			}
		}
		for (const hunk of [...file.acceptedHunks, ...file.rejectedHunks]) {
			const link = { uri: file.uri.toString(), hunkId: hunk.id, relativePath: file.relativePath, line: hunk.displayStart };
			addDashboardHunkLink(links, hunk.id, link);
			addDashboardHunkLink(links, hunk.reviewItemId ?? hunk.sourceHunkId ?? hunk.id, link);
			if (hunk.sourceHunkId) {
				addDashboardHunkLink(links, hunk.sourceHunkId, link);
			}
			const original = originalReviewedHunkId(hunk.id);
			if (original !== hunk.id) {
				addDashboardHunkLink(links, original, { ...link, hunkId: original });
			}
		}
		for (const applied of file.appliedAiSuggestions.filter((suggestion) => suggestion.resolvedToIndex)) {
			const link = {
				uri: file.uri.toString(),
				hunkId: applied.currentHunkId,
				relativePath: file.relativePath,
				line: applied.appliedHunk.newStart,
			};
			addDashboardHunkLink(links, applied.currentHunkId, link);
			addDashboardHunkLink(links, applied.reviewItemId ?? applied.sourceHunkId, link);
			addDashboardHunkLink(links, applied.sourceHunkId, link);
		}
	}
	return links;
}

function addDashboardHunkLink(links: Map<string, ReviewDashboardRelatedChunk[]>, key: string, link: ReviewDashboardRelatedChunk): void {
	const list = links.get(key) ?? [];
	if (!list.some((item) => item.uri === link.uri && item.hunkId === link.hunkId)) {
		list.push(link);
	}
	links.set(key, list);
}

function dashboardFindingWithRelatedChunks(finding: AiReviewFinding, links: Map<string, ReviewDashboardRelatedChunk[]>): ReviewDashboardFinding {
	const relatedChunks = (finding.relatedHunkIds ?? [])
		.flatMap((hunkId) => links.get(hunkId) ?? [])
		.filter((link, index, items) => items.findIndex((item) => item.uri === link.uri && item.hunkId === link.hunkId) === index);
	return relatedChunks.length > 0 ? { ...finding, relatedChunks } : finding;
}
function dashboardChunks(
	file: ReviewFileState,
	pendingHunks: ReviewHunk[],
	findingsByChunk: Map<string, ReviewDashboardFinding[]>,
	suggestionsByChunk: Map<string, AiReviewChunkSuggestion[]>,
	mutationDisabled: boolean,
): ReviewDashboardChunk[] {
	const uri = file.uri.toString();
	const appliedByHunk = new Map(file.appliedAiSuggestions.map((suggestion) => [suggestion.currentHunkId, suggestion]));
	const chunks = pendingHunks.map((hunk): ReviewDashboardChunk => {
		const applied = appliedByHunk.get(hunk.id);
		const reviewItemId = applied?.reviewItemId ?? hunk.reviewItemId ?? hunk.sourceHunkId ?? hunk.id;
		const reviewItemHunkIds = [...new Set([hunk.id, hunk.sourceHunkId, applied?.sourceHunkId, reviewItemId]
			.filter((value): value is string => Boolean(value)))];
		return {
			hunkId: hunk.id,
			kind: hunk.kind,
			line: hunk.newStart,
			oldLines: hunk.oldLines,
			newLines: hunk.newLines,
			findings: reviewItemsByHunkIds(findingsByChunk, uri, reviewItemHunkIds),
			suggestions: reviewItemsByHunkIds(suggestionsByChunk, uri, reviewItemHunkIds),
			appliedSuggestion: dashboardAppliedSuggestion(applied),
			reviewStatus: 'pending',
			canAccept: !mutationDisabled,
			canReject: !mutationDisabled,
			canUndo: false,
		};
	});
	const seenIdentities = new Set(pendingHunks.map(reviewHunkIdentity));
	for (const hunk of [...file.acceptedHunks, ...file.rejectedHunks]) {
		const identity = reviewHunkIdentity(hunk);
		if (seenIdentities.has(identity)) {
			continue;
		}
		seenIdentities.add(identity);
		const originalHunkId = originalReviewedHunkId(hunk.id);
		const reviewItemId = hunk.reviewItemId ?? hunk.appliedAiSuggestion?.reviewItemId
			?? hunk.sourceHunkId ?? hunk.appliedAiSuggestion?.sourceHunkId ?? originalHunkId;
		const reviewItemHunkIds = [...new Set([
			hunk.id,
			originalHunkId,
			hunk.sourceHunkId,
			reviewItemId,
			hunk.appliedAiSuggestion?.sourceHunkId,
		].filter((value): value is string => Boolean(value)))];
		chunks.push({
			hunkId: hunk.id,
			kind: hunk.kind,
			line: hunk.displayStart,
			oldLines: hunk.oldLines,
			newLines: hunk.newLines,
			findings: reviewItemsByHunkIds(findingsByChunk, uri, reviewItemHunkIds),
			suggestions: reviewItemsByHunkIds(suggestionsByChunk, uri, reviewItemHunkIds),
			appliedSuggestion: dashboardAppliedSuggestion(hunk.appliedAiSuggestion)
				?? dashboardAppliedSuggestion(appliedByHunk.get(hunk.id))
				?? dashboardAppliedSuggestion(appliedByHunk.get(originalHunkId)),
			reviewStatus: 'reviewed',
			reviewDecision: hunk.status,
			canAccept: false,
			canReject: false,
			canUndo: !mutationDisabled,
		});
	}
	const representedSuggestionIds = new Set(chunks.flatMap((chunk) => chunk.appliedSuggestion?.suggestionId ? [chunk.appliedSuggestion.suggestionId] : []));
	for (const applied of file.appliedAiSuggestions.filter((suggestion) => suggestion.resolvedToIndex
		&& !representedSuggestionIds.has(suggestion.suggestionId))) {
		const sourceIds = [...new Set([
			applied.currentHunkId,
			applied.sourceHunkId,
			applied.reviewItemId,
		].filter((value): value is string => Boolean(value)))];
		chunks.push({
			hunkId: applied.currentHunkId,
			kind: applied.originalHunk.kind,
			line: applied.appliedHunk.newStart,
			oldLines: applied.originalHunk.oldLines,
			newLines: applied.appliedHunk.newLines,
			findings: reviewItemsByHunkIds(findingsByChunk, uri, sourceIds),
			suggestions: reviewItemsByHunkIds(suggestionsByChunk, uri, sourceIds),
			appliedSuggestion: dashboardAppliedSuggestion(applied),
			reviewStatus: 'resolved',
			canAccept: false,
			canReject: false,
			canUndo: false,
		});
	}
	return chunks.sort((left, right) => left.line - right.line || left.hunkId.localeCompare(right.hunkId));
}

function reviewItemsByHunkIds<T>(itemsByChunk: Map<string, T[]>, uri: string, hunkIds: string[]): T[] {
	return hunkIds.flatMap((hunkId) => itemsByChunk.get(`${uri}#${hunkId}`) ?? []);
}

function dashboardAppliedSuggestion(suggestion: { suggestionId: string; replacementText: string } | undefined): ReviewDashboardChunk['appliedSuggestion'] {
	return suggestion ? {
		suggestionId: suggestion.suggestionId,
		replacementText: suggestion.replacementText,
	} : undefined;
}

function originalReviewedHunkId(hunkId: string): string {
	const acceptPrefix = 'accept-';
	const rejectPrefix = 'reject-';
	const prefix = hunkId.startsWith(acceptPrefix)
		? acceptPrefix
		: hunkId.startsWith(rejectPrefix) ? rejectPrefix : undefined;
	if (!prefix) {
		return hunkId;
	}
	const suffix = hunkId.slice(prefix.length);
	const firstSeparator = suffix.indexOf('-');
	if (firstSeparator < 0) {
		return suffix;
	}
	const firstSegment = suffix.slice(0, firstSeparator);
	return /^\d+$/.test(firstSegment) ? suffix.slice(firstSeparator + 1) : suffix;
}

function dashboardPendingHunks(file: ReviewFileState): ReviewHunk[] {
	const reviewedIdentities = new Set([...file.acceptedHunks, ...file.rejectedHunks].map(reviewHunkIdentity));
	if (reviewedIdentities.size === 0) {
		return file.hunks;
	}

	return file.hunks.filter((hunk) => !reviewedIdentities.has(reviewHunkIdentity(hunk)));
}

function dashboardDescription(
	pendingCount: number,
	acceptedCount: number,
	rejectedCount: number,
	findingCount: number,
	suggestionCount: number,
	dirty: boolean,
	skippedReason?: string,
): string {
	if (skippedReason) {
		return 'skipped';
	}
	const parts: string[] = [];
	if (pendingCount > 0) {
		parts.push(`${pendingCount} Pending`);
	}
	if (acceptedCount > 0) {
		parts.push(`${acceptedCount} Accepted`);
	}
	if (rejectedCount > 0) {
		parts.push(`${rejectedCount} Rejected`);
	}
	if (findingCount > 0) {
		parts.push(`${findingCount} ${findingCount === 1 ? 'finding' : 'findings'}`);
	}
	if (suggestionCount > 0) {
		parts.push(`${suggestionCount} ${suggestionCount === 1 ? 'suggestion' : 'suggestions'}`);
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
	return path.posix.extname(relativePath).replace(/^\./, '') || 'file';
}

function dashboardStatus(file: ReviewFileState): { label: string; kind: ReviewDashboardFile['statusKind'] } {
	if (file.skippedReason) {
		return { label: 'Unsupported Git change', kind: 'skipped' };
	}

	const changeKinds = new Set(
		[
			...file.hunks,
			...file.acceptedHunks,
			...file.rejectedHunks,
			...file.appliedAiSuggestions.filter((suggestion) => suggestion.resolvedToIndex).map((suggestion) => suggestion.originalHunk),
		]
			.map((hunk) => hunk.kind)
			.filter((kind) => kind === 'add' || kind === 'delete' || kind === 'modify'),
	);
	if (changeKinds.size === 1 && changeKinds.has('add')) {
		return { label: 'U', kind: 'untracked' };
	}
	if (changeKinds.size === 1 && changeKinds.has('delete')) {
		return { label: 'D', kind: 'deleted' };
	}
	if (changeKinds.size > 0) {
		return { label: 'M', kind: 'modified' };
	}

	if (!file.currentExists) {
		return { label: 'D', kind: 'deleted' };
	}
	if (!file.baselineExists) {
		return { label: 'U', kind: 'untracked' };
	}
	return { label: 'M', kind: 'modified' };
}
