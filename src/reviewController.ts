import { hash as reviewContentHash } from './agent/review/live';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { AiReviewLanguage, AiReviewPartialError, AiReviewStore, CodeReviewAgentService, CodeReviewTraceContext, normalizeAiSuggestionReplacementText, reviewChangeSignature, StoredAiReview, sortFindings, sourcePendingFiles } from './agent/codeReview';
import type { AgentTraceEvent } from './agent/runtime';
import { AgentRunStore, ProjectAgentLifecycle, ProjectAgentTaskKind, StoredProjectAgentRun } from './agentRunStore';
import { GitBranchRef, GitService } from './gitService';
import { computeLineDiff } from './diffEngine';
import { contentStateHash, expectedRejectedFileHash, fileStateHash, GitReviewJournalStore } from './gitReviewJournal';
import { createLlmClient, LlmClient } from './llm/client';
import { LlmConfigInput, LlmConfigStore, LlmSavedConfig, LlmRuntimeConfig } from './llm/config';
import { buildReviewDashboardPayload, defaultLlmWikiDashboardState, LlmWikiDashboardState, LlmWikiRunLogEntry, ProjectAgentSummary, ReviewDashboardProvider } from './reviewDashboard';
import { ReviewTreeProvider } from './reviewTree';
import {
	EditedRange,
	ReviewNavigationAction,
	ReviewNavigationRequestType,
	ReviewNavigationResponse,
	ReviewNavigationTargetPayload,
	ReviewWebviewManager,
} from './reviewWebview';
import { isGitIgnoredReviewPath, shouldSkipReviewPath } from './reviewFileFilter';
import {
	captureLineBlockContext,
	firstReviewRevealPosition,
	ReviewRevealPosition,
	gitReviewFileStateFingerprint,
	isStaleRevision,
	lineBlockWithContextMatches,
	mapLineAfterFileEdits,
	mapLineAfterLineEdits,
	reviewHunkIdentity,
	SerialOperationQueue,
} from './reviewState';
import { decodeUtf8, encodeUtf8, isProbablyBinary, lineRange, relativePath, replaceLineBlock, splitLines } from './text';
import {
	AppliedAiSuggestion,
	currentReviewProject,
	FilePair,
	GitReviewHunk,
	hasAggregateReviewTarget,
	projectReviewSession,
	ReviewedHunk,
	ReviewFileState,
	ReviewHunk,
	ReviewProject,
	reviewProjectFolder,
	ReviewSession,
	ReviewSource,
	uriKey,
	visibleReviewFiles,
} from './types';
import { isAbortError } from './wiki/cancellation';
import { wikiReferencesPath } from './wiki/paths';
import type { WikiFreshnessAssessment } from './wiki/state';
import { WikiAgentTraceContext, WikiInitializationService } from './wiki/wikiInitializer';

type InternalWriteSource = 'plugin' | 'human';

type GitSessionRefreshRequest =
	| { source: 'manual' }
	| { source: 'gitIndexChanged' };

interface ReviewNavigationTarget extends vscode.QuickPickItem {
	uri: vscode.Uri;
	range: vscode.Range;
}

type RunLogSource = 'wiki' | 'review';

type RunLogMetadata = Pick<LlmWikiRunLogEntry, 'source' | 'stage' | 'fileUri' | 'relativePath' | 'fileIndex' | 'fileCount' | 'agentId' | 'parentAgentId' | 'role' | 'segment'>;

interface ProjectAgentTask {
	id: string;
	projectKey: string;
	projectId?: string;
	kind: ProjectAgentTaskKind;
	root: vscode.WorkspaceFolder;
	abortController: AbortController;
	done: Promise<void>;
	cancelMode?: 'pause' | 'revert';
}

interface ProjectAgentRuntime {
	projectKey: string;
	projectId?: string;
	rootUri: vscode.Uri;
	task?: ProjectAgentTask;
	run?: StoredProjectAgentRun;
	checkpointSaveQueue: Promise<void>;
	loaded: boolean;
}

interface BranchExtractionState {
	version: 1;
	projectRootUri: string;
	targetHeadOid: string;
	targetLabel: string;
	sourceRef: string;
	startedAt: number;
}

type SuggestionMappingFailureReason =
	| 'no-candidate'
	| 'other-hunk-overlap'
	| 'target-residual'
	| 'other-hunk-residual'
	| 'ambiguous';

interface SuggestionMappingDiagnostics {
	original: Pick<ReviewHunk, 'kind' | 'oldStart' | 'oldLines' | 'newStart' | 'newLines'>;
	regeneratedHunkCount: number;
	regeneratedHunks: Array<Pick<GitReviewHunk, 'fingerprint' | 'occurrence' | 'kind' | 'oldStart' | 'oldLines' | 'newStart' | 'newLines'> & {
		disposition: 'candidate' | 'preserved-other' | 'outside-target-scope';
	}>;
	preservedOtherHunkCount: number;
	outsideScopeCandidateCount: number;
	referenceCompared: boolean;
	matchesExpectedReference: boolean;
	resolvedToIndex: boolean;
	candidateCount: number;
	candidates: Array<Pick<GitReviewHunk, 'fingerprint' | 'occurrence' | 'oldStart' | 'oldLines' | 'newStart' | 'newLines'>>;
	otherPendingCount: number;
	validGroupCount: number;
	overlappingGroupCount: number;
	targetResidualRanges: Array<Pick<ReviewHunk, 'oldStart' | 'oldLines' | 'newStart' | 'newLines'>>;
	otherResidualRanges: Array<Pick<ReviewHunk, 'oldStart' | 'oldLines' | 'newStart' | 'newLines'>>;
}

type SuggestionMappingResult =
	| { ok: true; effect: 'git-hunks' | 'resolved-to-index'; members: GitReviewHunk[]; undoText: string }
	| { ok: false; reason: SuggestionMappingFailureReason; diagnostics: SuggestionMappingDiagnostics };

export class ReviewController implements vscode.Disposable {
	private readonly gitService = new GitService();
	private readonly gitReviewJournal: GitReviewJournalStore;
	private readonly llmConfigStore: LlmConfigStore;
	private readonly wikiInitializationService: WikiInitializationService;
	private readonly codeReviewAgentService = new CodeReviewAgentService();
	private readonly aiReviewStore: AiReviewStore;
	private readonly agentRunStore: AgentRunStore;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly treeProvider: ReviewTreeProvider;
	private readonly dashboardProvider: ReviewDashboardProvider;
	private readonly reviewWebview: ReviewWebviewManager;
	private readonly refreshTimers = new Map<string, NodeJS.Timeout>();
	private readonly humanEditBatches = new Map<string, EditedRange[]>();
	private readonly humanSaveIntents = new Map<string, number>();
	private readonly internalWriteDepth = new Map<string, number>();
	private readonly writeGraceUntil = new Map<string, { source: InternalWriteSource; until: number }>();
	private readonly fileOperationQueue = new SerialOperationQueue<string>();
	private gitRefreshTimer: NodeJS.Timeout | undefined;
	private llmDashboardRefreshTimer: NodeJS.Timeout | undefined;
	private llmDashboardRefreshPending = false;
	private gitRefreshRequested = false;
	private gitRefreshInFlight: Promise<void> | undefined;
	private llmDashboardRefreshGeneration = 0;
	private gitMutationDepth = 0;
	private currentReviewUri: vscode.Uri | undefined;
	private activeSession: ReviewSession | undefined;
	private readonly projectAgentRuntimes = new Map<string, ProjectAgentRuntime>();
	private llmConfigState: LlmSavedConfig = {
		provider: 'deepseek',
		baseUrl: '',
		model: '',
		hasApiKey: false,
		configured: false,
		jsonOutputEnabled: true,
		thinkingMode: 'disabled',
		strictTools: false,
		profiles: [],
	};
	private llmWikiState: LlmWikiDashboardState = defaultLlmWikiDashboardState();
	private wikiRootUri: vscode.Uri | undefined;

	public constructor(private readonly context: vscode.ExtensionContext) {
		this.gitReviewJournal = new GitReviewJournalStore(context);
		this.llmConfigStore = new LlmConfigStore(context);
		this.wikiInitializationService = new WikiInitializationService(
			context.extensionUri,
			context.storageUri ?? context.globalStorageUri,
		);
		this.aiReviewStore = new AiReviewStore(context.workspaceState, context.storageUri ?? context.globalStorageUri);
		this.agentRunStore = new AgentRunStore(context);
		void this.migrateLegacyReviewStorage();
		this.treeProvider = new ReviewTreeProvider(() => this.activeSession, () => this.dashboardStoredAiReview());
		this.dashboardProvider = new ReviewDashboardProvider(() => {
			const extraction = this.currentBranchExtraction();
			return buildReviewDashboardPayload(
				this.activeSession,
				this.currentReviewUri,
				(uri) => this.isOpenDocumentDirty(uri),
				this.llmWikiState,
				extraction?.sourceRef,
				extraction?.targetLabel,
			);
		});
		this.reviewWebview = new ReviewWebviewManager(
			context,
			() => this.activeSession,
			(type, uri, line, column, requestId) => this.navigateFromReview(type, uri, line, column, requestId),
			(uri, line, column) => this.openNavigationTarget(uri, line, column),
			(uri) => this.setCurrentReviewUri(uri),
		);

		this.disposables.push(
			this.reviewWebview,
			this.dashboardProvider,
			vscode.window.registerTreeDataProvider('cli-diff.review', this.treeProvider),
			vscode.window.registerWebviewViewProvider(ReviewDashboardProvider.viewType, this.dashboardProvider),
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor) {
					void this.ensureGitReviewForUri(editor.document.uri);
				}
			}),
			vscode.window.onDidChangeVisibleTextEditors((editors) => {
				for (const editor of editors) {
					void this.ensureGitReviewForUri(editor.document.uri);
				}
			}),
			vscode.workspace.onDidOpenTextDocument((document) => this.scheduleRefresh(document.uri)),
			vscode.workspace.onWillSaveTextDocument((event) => this.handleWillSaveDocument(event)),
			vscode.workspace.onDidSaveTextDocument((document) => {
				void this.handleSavedDocument(document);
			}),
			vscode.workspace.onDidChangeTextDocument((event) => this.handleChangedDocument(event)),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('cliDiff.reviewWikiChanges')) {
					void this.refreshAll();
				} else if (event.affectsConfiguration('cliDiff.aiReviewLanguage')
					|| event.affectsConfiguration('cliDiff.aiReviewMaxRounds')
					|| event.affectsConfiguration('cliDiff.agentConcurrency')
					|| event.affectsConfiguration('cliDiff.aiReviewAutoCompress')) {
					void this.refreshLlmWikiDashboardState();
				}
			}),
			this.createFileWatcher(),
			this.createGitMetadataWatcher(),
			this.createGitExtensionStateWatcher(),
			this.registerCommand('cli-diff.startGitReview', () => this.startGitReview()),
			this.registerCommand('cli-diff.acceptChange', (uri?: string, hunkId?: string, revision?: number) => this.acceptChange(uri, hunkId, revision)),
			this.registerCommand('cli-diff.rejectChange', (uri?: string, hunkId?: string, revision?: number) => this.rejectChange(uri, hunkId, revision)),
			this.registerCommand('cli-diff.restoreChange', (uri?: string, hunkId?: string, revision?: number) => this.restoreChange(uri, hunkId, revision)),
			this.registerCommand('cli-diff.acceptFile', (uri?: string | ReviewFileState, revision?: number) => this.acceptFile(uri, revision)),
			this.registerCommand('cli-diff.rejectFile', (uri?: string | ReviewFileState, revision?: number) => this.rejectFile(uri, revision)),
			this.registerCommand('cli-diff.undoFile', (uri?: string | ReviewFileState, revision?: number) => this.undoFile(uri, revision)),
			this.registerCommand('cli-diff.acceptAll', () => this.acceptAll()),
			this.registerCommand('cli-diff.rejectAll', () => this.rejectAll()),
			this.registerCommand('cli-diff.undoAll', () => this.undoAll()),
			this.registerCommand('cli-diff.selectTrackingTarget', (projectId?: string) => this.selectTrackingTarget(projectId)),
			this.registerCommand('cli-diff.selectGitBranch', () => this.selectGitBranch()),
			this.registerCommand('cli-diff.exitBranchExtraction', () => this.exitBranchExtraction()),
			this.registerCommand('cli-diff.nextChange', (uri?: string, hunkId?: string) => this.navigateChange(1, uri, hunkId)),
			this.registerCommand('cli-diff.previousChange', (uri?: string, hunkId?: string) => this.navigateChange(-1, uri, hunkId)),
			this.registerCommand('cli-diff.openReviewView', (uri?: string) => this.openReviewView(uri)),
			this.registerCommand('cli-diff.openFileAtChange', (uri: string, hunkId: string) => this.openFileAtChange(uri, hunkId)),
			this.registerCommand('cli-diff.closeReviewEditors', () => this.closeReviewEditors()),
			this.registerCommand('cli-diff.refresh', () => this.refreshAll()),
			this.registerCommand('cli-diff.saveLlmWikiConfig', (input: LlmConfigInput) => this.saveLlmWikiConfig(input)),
			this.registerCommand('cli-diff.selectLlmConfigProfile', (profileId: string) => this.selectLlmConfigProfile(profileId)),
			this.registerCommand('cli-diff.deleteLlmConfigProfile', (profileId: string) => this.deleteLlmConfigProfile(profileId)),
			this.registerCommand('cli-diff.initializeLlmWiki', () => this.initializeLlmWiki()),
			this.registerCommand('cli-diff.cancelLlmWikiInitialization', () => this.cancelLlmWikiInitialization()),
			this.registerCommand('cli-diff.updateLlmWiki', () => this.updateLlmWiki()),
			this.registerCommand('cli-diff.generateAiReview', (mode?: 'regenerate') => this.generateAiReview(mode)),
			this.registerCommand('cli-diff.openWikiIndex', () => this.openWikiIndex()),
			this.registerCommand('cli-diff.openAiReviewFinding', (uri: string, hunkId: string) => this.openAiReviewFinding(uri, hunkId)),
			this.registerCommand('cli-diff.applyAiSuggestion', (uri: string, hunkId: string, suggestionId: string) => this.applyAiSuggestion(uri, hunkId, suggestionId)),
			this.registerCommand('cli-diff.undoAiSuggestion', (uri: string, hunkId: string, suggestionId: string) => this.undoAiSuggestion(uri, hunkId, suggestionId)),
			this.registerCommand('cli-diff.cancelAgent', () => this.cancelCurrentAgent()),
		);
		void vscode.commands.executeCommand('setContext', 'cliDiff:hasSession', false);
		if (context.extensionMode !== vscode.ExtensionMode.Test) {
			void this.refreshLlmWikiDashboardState();
			void this.startAutomaticGitReview();
			void this.ensureVisibleEditorsReviewed();
		}
	}

	public dispose(): void {
		for (const runtime of this.projectAgentRuntimes.values()) {
			runtime.task?.abortController.abort();
		}
		if (this.gitRefreshTimer) {
			clearTimeout(this.gitRefreshTimer);
			this.gitRefreshTimer = undefined;
		}
		if (this.llmDashboardRefreshTimer) {
			clearTimeout(this.llmDashboardRefreshTimer);
			this.llmDashboardRefreshTimer = undefined;
		}
		this.llmDashboardRefreshPending = false;
		for (const timer of this.refreshTimers.values()) {
			clearTimeout(timer);
		}
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	private handleChangedDocument(event: vscode.TextDocumentChangeEvent): void {
		if (event.document.uri.scheme !== 'file') {
			return;
		}

		const key = uriKey(event.document.uri);
		if (this.isInternalWriteActive(event.document.uri)) {
			this.humanEditBatches.delete(key);
			return;
		}

		if (!event.document.isDirty) {
			this.humanEditBatches.delete(key);
			this.handleFileSystemChange(event.document.uri);
			return;
		}

		const ranges = this.humanEditBatches.get(key) ?? [];
		for (const change of event.contentChanges) {
			const startLine = Math.max(0, change.range.start.line);
			const insertedLines = this.countInsertedLines(change.text);
			const endLine = Math.max(change.range.end.line, startLine + insertedLines);
			ranges.push({ startLine, endLine: Math.max(startLine + 1, endLine) });
		}
		this.humanEditBatches.set(key, this.mergeEditedRanges(ranges));
	}

	private handleWillSaveDocument(event: vscode.TextDocumentWillSaveEvent): void {
		if (event.document.uri.scheme !== 'file' || this.isInternalWriteActive(event.document.uri)) {
			return;
		}

		this.humanSaveIntents.set(uriKey(event.document.uri), Date.now() + 5000);
		this.markWriteGrace(event.document.uri, 'human');
	}

	private async handleSavedDocument(document: vscode.TextDocument): Promise<void> {
		if (document.uri.scheme !== 'file') {
			return;
		}

		const key = uriKey(document.uri);
		if (this.isInternalWriteActive(document.uri)) {
			this.humanEditBatches.delete(key);
			return;
		}

		if (this.humanEditBatches.has(key) || this.hasHumanSaveIntent(document.uri)) {
			this.markWriteGrace(document.uri, 'human');
			await this.flushHumanEdits(document);
			this.markWriteGrace(document.uri, 'human');
			return;
		}

		this.scheduleRefresh(document.uri, { preferDisk: true });
	}

	private async startGitReview(): Promise<void> {
		try {
			const folder = await this.pickWorkspaceFolder();
			if (!folder) {
				return;
			}

			const projects = await this.gitService.discoverProjects(folder);
			if (projects.length === 0) {
				throw new Error('No Git project found in the workspace root or its direct child folders.');
			}
			await this.startSession('git', await this.createProjectFilePairs(projects), folder.uri, true, projects);
		} catch (error) {
			this.showError(error);
		}
	}

	private async migrateLegacyReviewStorage(): Promise<void> {
		const migrationKey = 'cliDiff.gitPatchReviewMigration.v1';
		if (this.context.workspaceState.get<boolean>(migrationKey)) {
			return;
		}
		const storageRoot = this.context.storageUri ?? this.context.globalStorageUri;
		try {
			await vscode.workspace.fs.delete(vscode.Uri.joinPath(storageRoot, 'snapshot'), { recursive: true });
		} catch {
			// The old snapshot directory is optional.
		}
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			await this.aiReviewStore.clear(folder.uri);
		}
		await this.context.workspaceState.update(migrationKey, true);
	}

	private async startAutomaticGitReview(): Promise<void> {
		if (!vscode.workspace.getConfiguration('cliDiff').get<boolean>('autoStartGitReview', true)) {
			return;
		}

		const folders = vscode.workspace.workspaceFolders ?? [];
		for (const folder of folders) {
			try {
				const projects = await this.gitService.discoverProjects(folder);
				if (projects.length === 0) {
					continue;
				}
				await this.startSession('git', await this.createProjectFilePairs(projects), folder.uri, false, projects);
				await this.ensureVisibleEditorsReviewed();
				return;
			} catch {
				// Ignore non-Git workspace folders during automatic startup.
			}
		}
	}

	private async startSession(
		mode: 'git',
		pairs: FilePair[],
		rootUri?: vscode.Uri,
		notify = true,
		projects?: ReviewProject[],
	): Promise<void> {
		const workspaceRoot = rootUri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!workspaceRoot) {
			throw new Error('Open a workspace folder before starting a review.');
		}

		const files = new Map<string, ReviewFileState>();
		for (const pair of pairs) {
			const file = this.createFileState(pair);
			if (file.hunks.length > 0 || file.acceptedHunks.length > 0 || file.skippedReason) {
				files.set(uriKey(file.uri), file);
			}
		}
		if (mode === 'git') {
			await this.attachRejectedJournals(files, projects ?? []);
			await this.validateBranchExtractions(projects ?? []);
		}

		this.activeSession = {
			id: `${mode}-${Date.now()}`,
			mode,
			rootUri: workspaceRoot,
			createdAt: Date.now(),
			files,
			projects,
			trackingTarget: mode === 'git' ? await this.restoredTrackingTarget(workspaceRoot, projects ?? []) : undefined,
		};
		await this.loadProjectAgentRuns(projects ?? []);
		await vscode.commands.executeCommand('setContext', 'cliDiff:hasSession', true);
		this.refreshUi();
		const hunkCount = [...files.values()].reduce((total, file) => total + file.hunks.length, 0);
		if (notify) {
			vscode.window.showInformationMessage(`Cli Diff Review ${mode} review started (${files.size} files, ${hunkCount} changes).`);
		}
	}

	private async initializeGitSessionForFolder(folder: vscode.WorkspaceFolder): Promise<void> {
		const projects = await this.gitService.discoverProjects(folder);
		if (projects.length === 0) {
			return;
		}
		await this.startSession('git', await this.createProjectFilePairs(projects), folder.uri, false, projects);
	}

	private async createProjectFilePairs(projects: ReviewProject[]): Promise<FilePair[]> {
		const projectPairs = await Promise.all(projects.map(async (project, index) => {
			const projectPairs = await this.gitService.createFilePairs(reviewProjectFolder(project, index));
			return projectPairs.map((pair) => ({
				...pair,
				projectId: project.id,
				projectName: project.name,
			}));
		}));
		return projectPairs.flat();
	}

	private async attachRejectedJournals(
		files: Map<string, ReviewFileState>,
		projects: ReviewProject[],
		onlyUri?: vscode.Uri,
	): Promise<void> {
		let headChanged = false;
		for (const project of projects) {
			const folder = reviewProjectFolder(project);
			const headOid = project.headOid ?? await this.gitService.headOid(folder);
			project.headOid = headOid;
			const indexEntries = new Map<string, { exists: boolean; text: string; mode: string; oid?: string }>();
			const loaded = await this.gitReviewJournal.load(project, headOid);
			headChanged ||= loaded.headChanged;
			if (loaded.headChanged) {
				await this.aiReviewStore.clear(project.rootUri);
				if (this.activeSession && uriKey(this.activeSession.rootUri) !== uriKey(project.rootUri)) {
					await this.aiReviewStore.clear(this.activeSession.rootUri);
				}
			}
			for (const record of loaded.records) {
				const uri = vscode.Uri.parse(record.fileUri);
				if (onlyUri && uriKey(uri) !== uriKey(onlyUri)) {
					continue;
				}
				const key = uriKey(uri);
				let file = files.get(key);
				if (record.kind === 'accept') {
					const savedMembers = record.memberHunks ?? record.hunk.memberHunks ?? [record.hunk];
					const used = new Set<string>();
					const currentMembers = savedMembers.flatMap((saved) => {
						const match = file?.hunks.find((hunk) => !used.has(hunk.id)
							&& hunk.fingerprint === saved.fingerprint
							&& (hunk.occurrence ?? 0) === (saved.occurrence ?? 0));
						if (!match) {
							return [];
						}
						used.add(match.id);
						return [this.requireGitHunk(match)];
					});
					const allMembersMatched = currentMembers.length === savedMembers.length;
					const current = file && allMembersMatched
						? currentMembers.length === 1
							? {
								...currentMembers[0],
								sourceHunkId: record.sourceHunkId ?? record.hunk.sourceHunkId ?? record.hunk.id,
								reviewItemId: record.reviewItemId ?? record.sourceHunkId ?? record.hunk.id,
								memberHunks: currentMembers,
							}
							: record.appliedAiSuggestion
								? this.createLogicalSuggestionHunk(
									file,
									record.appliedAiSuggestion.originalHunk,
									currentMembers,
									record.reviewItemId ?? record.appliedAiSuggestion.reviewItemId ?? record.appliedAiSuggestion.sourceHunkId,
								)
								: { ...record.hunk, patch: this.gitService.combinePatches(currentMembers), memberHunks: currentMembers }
						: undefined;
					const indexUnchanged = record.indexBlobOid === file?.gitSnapshot?.indexBlobOid;
					if (record.state === 'flushing' && (!file || !current || !indexUnchanged)) {
						await this.gitReviewJournal.clear(project, headOid);
						break;
					}
					if (!file || !current || !indexUnchanged) {
						await this.gitReviewJournal.remove(project, headOid, record.id);
						continue;
					}
					if (record.state === 'flushing') {
						await this.gitReviewJournal.setAcceptState(project, headOid, [record.id], 'reviewed');
						record.state = 'reviewed';
					}
					const accepted = this.gitReviewJournal.toAcceptedHunk(record, this.requireGitHunk(current));
					file.hunks = file.hunks.filter((hunk) => !used.has(hunk.id));
					file.acceptedHunks.push(accepted);
					continue;
				}
				let indexEntry = indexEntries.get(record.relativePath);
				if (!indexEntry) {
					indexEntry = await this.gitService.readIndexEntry(folder, record.relativePath);
					indexEntries.set(record.relativePath, indexEntry);
				}
				const indexIdentityChanged = (record.indexExists !== undefined && record.indexExists !== indexEntry.exists)
					|| (record.indexBlobOid !== undefined && record.indexBlobOid !== indexEntry.oid);
				if (indexIdentityChanged && record.state !== 'stale') {
					record.state = 'stale';
					await this.gitReviewJournal.setState(project, headOid, record.id, 'stale');
				}
				if (!file) {
					const current = await this.readCurrentText(uri, { preferDisk: true });
					file = this.createManualBaselineFileState(uri, indexEntry.text);
					file.relativePath = record.relativePath;
					file.projectId = project.id;
					file.projectName = project.name;
					file.oldText = indexEntry.text;
					file.newText = current.text;
					file.originalText = indexEntry.text;
					file.originalExists = indexEntry.exists;
					file.baselineExists = indexEntry.exists;
					file.currentExists = current.exists;
					file.headOid = headOid;
					file.gitSnapshot = {
						headText: indexEntry.text,
						indexText: indexEntry.text,
						workingText: current.text,
						headExists: indexEntry.exists,
						indexExists: indexEntry.exists,
						workingExists: current.exists,
						indexBlobOid: indexEntry.oid,
					};
					files.set(key, file);
				}
				let rejected = this.gitReviewJournal.toReviewedHunk(record);
				if (file.hunks.some((pending) => this.externalHunkTouchesDecision(pending, rejected))) {
					await this.gitReviewJournal.remove(project, headOid, record.id);
					continue;
				}
				const mappedStart = this.mapDecisionStartAfterExternalChanges(rejected.displayStart, file.hunks);
				rejected = { ...rejected, displayStart: mappedStart, currentStart: mappedStart, zoneAfterLineNumber: mappedStart };
				file.rejectedHunks.push(rejected);
				if (record.state === 'stale') {
					file.skippedReason = 'Rejected change is stale because the working file no longer matches its journal.';
				}
			}
		}
		if (headChanged) {
			void vscode.window.showInformationMessage('Git history changed. Cli Diff Review rebuilt the affected review session.');
		}
	}

	private async restoredTrackingTarget(rootUri: vscode.Uri, projects: ReviewProject[]): Promise<ReviewSession['trackingTarget']> {
		if (projects.length === 0) {
			return undefined;
		}
		if (projects.some((project) => uriKey(project.rootUri) === uriKey(rootUri))) {
			return projects[0] ? { kind: 'project', projectId: projects[0].id } : undefined;
		}
		const savedProjectId = this.context.workspaceState.get<string>(trackingTargetStorageKey(rootUri));
		return savedProjectId && projects.some((project) => project.id === savedProjectId)
			? { kind: 'project', projectId: savedProjectId }
			: { kind: 'aggregate' };
	}

	private async ensureTrackingTargetAvailable(): Promise<void> {
		const session = this.activeSession;
		if (!session || session.mode !== 'git') {
			return;
		}
		const projects = session.projects ?? [];
		if (projects.length === 0) {
			session.trackingTarget = undefined;
			return;
		}
		if (!hasAggregateReviewTarget(session)) {
			session.trackingTarget = projects[0] ? { kind: 'project', projectId: projects[0].id } : undefined;
			return;
		}
		if (!session.trackingTarget) {
			session.trackingTarget = { kind: 'aggregate' };
			return;
		}
		const selectedProjectId = session.trackingTarget?.kind === 'project' ? session.trackingTarget.projectId : undefined;
		if (selectedProjectId && !projects.some((project) => project.id === selectedProjectId)) {
			session.trackingTarget = { kind: 'aggregate' };
			await this.context.workspaceState.update(trackingTargetStorageKey(session.rootUri), undefined);
		}
	}

	private async selectTrackingTarget(projectId?: string): Promise<void> {
		const session = this.activeSession;
		if (!session || !hasAggregateReviewTarget(session)) {
			return;
		}
		const currentProject = currentReviewProject(session);
		const directProject = projectId ? session.projects?.find((project) => project.id === projectId) : undefined;
		const picked = directProject ? {
			label: directProject.name,
			description: directProject.rootUri.fsPath,
			projectId: directProject.id,
			picked: currentProject?.id === directProject.id,
		} : projectId ? undefined : await vscode.window.showQuickPick([
				{
					label: path.basename(session.rootUri.fsPath),
					description: 'All projects',
					projectId: undefined,
					picked: session.trackingTarget?.kind === 'aggregate',
				},
				...(session.projects ?? []).map((project) => ({
					label: project.name,
					description: project.rootUri.fsPath,
					projectId: project.id,
					picked: currentProject?.id === project.id,
				})),
			], { placeHolder: 'Select the project tracked by Cli Diff Review' });
		if (!picked) {
			return;
		}

		session.trackingTarget = picked.projectId ? { kind: 'project', projectId: picked.projectId } : { kind: 'aggregate' };
		await this.context.workspaceState.update(trackingTargetStorageKey(session.rootUri), picked.projectId);
		if (this.currentReviewUri && !visibleReviewFiles(session).some((file) => uriKey(file.uri) === uriKey(this.currentReviewUri as vscode.Uri))) {
			this.currentReviewUri = undefined;
		}
		await this.refreshLlmWikiDashboardState();
		this.refreshUi();
	}

	private async selectGitBranch(): Promise<void> {
		const project = currentReviewProject(this.activeSession);
		if (!project) {
			return;
		}
		if (this.branchExtraction(project)) {
			void vscode.window.showInformationMessage(`Exit the extracted review from ${this.branchExtraction(project)?.sourceRef} before switching branches.`);
			return;
		}
		try {
			const folder = reviewProjectFolder(project);
			const refs = await this.gitService.branchRefs(folder);
			const items: Array<(vscode.QuickPickItem & { action?: 'extract' | 'checkout'; ref?: GitBranchRef })> = [
				{
					label: `$(git-merge) Review branch changes in ${project.branchName ?? project.name}…`,
					description: 'Extract code into the current workspace',
					action: 'extract',
				},
			];
			const local = refs.filter((ref) => ref.kind === 'local');
			const remote = refs.filter((ref) => ref.kind === 'remote');
			if (local.length > 0) {
				items.push({ label: 'Local', kind: vscode.QuickPickItemKind.Separator });
				items.push(...local.map((ref) => ({
					label: ref.name,
					description: ref.current ? 'Current' : undefined,
					action: 'checkout' as const,
					ref,
				})));
			}
			if (remote.length > 0) {
				items.push({ label: 'Remote', kind: vscode.QuickPickItemKind.Separator });
				items.push(...remote.map((ref) => ({
					label: ref.name,
					description: ref.current ? 'Current · Detached HEAD' : 'Detached HEAD',
					action: 'checkout' as const,
					ref,
				})));
			}
			const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a Git branch action' });
			if (!picked?.action) {
				return;
			}
			if (picked.action === 'extract') {
				await this.extractBranchReview(project, refs);
				return;
			}
			if (!picked.ref || picked.ref.current) {
				return;
			}
			await this.enqueueProjectGitOperation(project, async () => {
				await this.gitService.checkout(folder, picked.ref?.name ?? '');
			});
			await this.requestGitSessionRefresh();
		} catch (error) {
			this.showError(error);
		}
	}

	private async extractBranchReview(project: ReviewProject, refs: GitBranchRef[]): Promise<void> {
		const sourceItems: Array<(vscode.QuickPickItem & { ref?: GitBranchRef })> = [];
		const local = refs.filter((ref) => ref.kind === 'local' && !ref.current);
		const remote = refs.filter((ref) => ref.kind === 'remote' && !ref.current);
		if (local.length > 0) {
			sourceItems.push({ label: 'Local', kind: vscode.QuickPickItemKind.Separator });
			sourceItems.push(...local.map((ref) => ({ label: ref.name, ref })));
		}
		if (remote.length > 0) {
			sourceItems.push({ label: 'Remote', kind: vscode.QuickPickItemKind.Separator });
			sourceItems.push(...remote.map((ref) => ({ label: ref.name, ref })));
		}
		const picked = await vscode.window.showQuickPick(sourceItems, {
			placeHolder: 'Select a branch to review in the current workspace',
		});
		if (!picked?.ref) {
			return;
		}
		if (this.hasDirtyDocumentInProject(project)) {
			void vscode.window.showInformationMessage(`Save or revert open files in ${project.name} before extracting branch changes.`);
			return;
		}
		if (this.projectHasReviewDecisions(project)) {
			void vscode.window.showInformationMessage(`Finish the current ${project.name} review before extracting branch changes.`);
			return;
		}
		const folder = reviewProjectFolder(project);
		await this.enqueueProjectGitOperation(project, async () => {
			if (!await this.gitService.isClean(folder)) {
				throw new Error(`The ${project.name} working tree and index must be clean before extracting branch changes.`);
			}
			const headOid = await this.gitService.headOid(folder);
			if (!headOid) {
				throw new Error(`The ${project.name} repository has no HEAD commit.`);
			}
			const extraction = await this.gitService.extractBranchPatch(folder, picked.ref?.name ?? '');
			if (!extraction.ok) {
				void vscode.window.showWarningMessage('The selected branch has merge conflicts. No changes were applied.');
				return;
			}
			if (!extraction.patch) {
				void vscode.window.showInformationMessage('The selected branch has no changes to review.');
				return;
			}
			await this.gitService.applyPatch(folder, extraction.patch, { check: true });
			await this.gitService.applyPatch(folder, extraction.patch);
			const state: BranchExtractionState = {
				version: 1,
				projectRootUri: project.rootUri.toString(),
				targetHeadOid: headOid,
				targetLabel: project.branchName ?? headOid.slice(0, 7),
				sourceRef: picked.ref?.name ?? '',
				startedAt: Date.now(),
			};
			await this.context.workspaceState.update(branchExtractionStorageKey(project.rootUri), state);
		});
		await this.requestGitSessionRefresh();
	}

	private async exitBranchExtraction(): Promise<void> {
		const project = currentReviewProject(this.activeSession);
		const extraction = project ? this.branchExtraction(project) : undefined;
		if (!project || !extraction) {
			return;
		}
		const confirmed = await vscode.window.showWarningMessage(
			`Exit extracted review from “${extraction.sourceRef}”?\n\nThis discards all staged, unstaged, and untracked changes in “${project.name}”.`,
			{ modal: true },
			'Exit and Discard',
		);
		if (confirmed !== 'Exit and Discard') {
			return;
		}
		if (this.hasDirtyDocumentInProject(project)) {
			void vscode.window.showInformationMessage(`Save or revert open files in ${project.name} before exiting the extracted review.`);
			return;
		}
		try {
			const folder = reviewProjectFolder(project);
			await this.enqueueProjectGitOperation(project, async () => {
				const headOid = await this.gitService.headOid(folder);
				if (headOid !== extraction.targetHeadOid) {
					await this.context.workspaceState.update(branchExtractionStorageKey(project.rootUri), undefined);
					throw new Error('Git HEAD changed after branch extraction. The extraction label was cleared without modifying files.');
				}
				await this.gitService.restoreProject(folder, extraction.targetHeadOid);
				await this.gitReviewJournal.clear(project, extraction.targetHeadOid);
				await this.aiReviewStore.clear(project.rootUri);
				await this.context.workspaceState.update(branchExtractionStorageKey(project.rootUri), undefined);
			});
			if (this.currentReviewUri && uriIsInside(project.rootUri, this.currentReviewUri)) {
				this.currentReviewUri = undefined;
			}
			await this.requestGitSessionRefresh();
		} catch (error) {
			this.showError(error);
			await this.requestGitSessionRefresh();
		}
	}

	private branchExtraction(project: ReviewProject): BranchExtractionState | undefined {
		const stored = this.context.workspaceState.get<BranchExtractionState>(branchExtractionStorageKey(project.rootUri));
		return stored?.version === 1 && stored.projectRootUri === project.rootUri.toString() ? stored : undefined;
	}

	private currentBranchExtraction(): BranchExtractionState | undefined {
		const project = currentReviewProject(this.activeSession);
		return project ? this.branchExtraction(project) : undefined;
	}

	private async validateBranchExtractions(projects: ReviewProject[]): Promise<void> {
		for (const project of projects) {
			const extraction = this.branchExtraction(project);
			if (extraction && extraction.targetHeadOid !== project.headOid) {
				await this.context.workspaceState.update(branchExtractionStorageKey(project.rootUri), undefined);
			}
		}
	}

	private hasDirtyDocumentInProject(project: ReviewProject): boolean {
		return vscode.workspace.textDocuments.some((document) => (
			document.uri.scheme === 'file'
			&& document.isDirty
			&& uriIsInside(project.rootUri, document.uri)
		));
	}

	private projectHasReviewDecisions(project: ReviewProject): boolean {
		return [...(this.activeSession?.files.values() ?? [])].some((file) => (
			file.projectId === project.id
			&& (file.acceptedHunks.length > 0 || file.rejectedHunks.length > 0 || file.appliedAiSuggestions.length > 0)
		));
	}

	private async enqueueProjectGitOperation(project: ReviewProject, operation: () => Promise<void>): Promise<void> {
		await this.fileOperationQueue.enqueue(uriKey(project.rootUri), async () => {
			if (this.gitRefreshInFlight) {
				await this.gitRefreshInFlight;
			}
			if (this.gitRefreshTimer) {
				clearTimeout(this.gitRefreshTimer);
				this.gitRefreshTimer = undefined;
			}
			this.gitMutationDepth += 1;
			try {
				await operation();
			} finally {
				this.gitMutationDepth = Math.max(0, this.gitMutationDepth - 1);
			}
		});
	}

	private createFileState(pair: FilePair): ReviewFileState {
		if (pair.gitSnapshot) {
			const pendingHunks = pair.pendingHunks ?? [];
			return {
				uri: pair.uri,
				relativePath: pair.relativePath,
				projectId: pair.projectId,
				projectName: pair.projectName,
				oldText: pair.gitSnapshot.headText,
				newText: pair.gitSnapshot.workingText,
				hunks: pendingHunks,
				acceptedHunks: [],
				rejectedHunks: [],
				appliedAiSuggestions: [],
				originalText: pair.gitSnapshot.headText,
				originalExists: pair.gitSnapshot.headExists,
				baselineExists: pair.gitSnapshot.headExists,
				currentExists: pair.gitSnapshot.workingExists,
				revision: 0,
				skippedReason: pair.skippedReason,
				gitSnapshot: pair.gitSnapshot,
				headOid: pair.headOid,
			};
		}
		if (pair.skippedReason) {
			return {
				uri: pair.uri,
				relativePath: pair.relativePath,
				projectId: pair.projectId,
				projectName: pair.projectName,
				oldText: pair.oldText,
				newText: pair.newText,
				hunks: [],
				acceptedHunks: [],
				rejectedHunks: [],
				appliedAiSuggestions: [],
				originalText: pair.oldText,
				originalExists: pair.baselineExists,
				baselineExists: pair.baselineExists,
				currentExists: pair.currentExists,
				revision: 0,
				skippedReason: pair.skippedReason,
			};
		}

		const diff: { hunks: ReviewHunk[]; skippedReason?: string } = { hunks: [] };
		if (diff.skippedReason) {
			return {
				uri: pair.uri,
				relativePath: pair.relativePath,
				projectId: pair.projectId,
				projectName: pair.projectName,
				oldText: pair.oldText,
				newText: pair.newText,
				hunks: [],
				acceptedHunks: [],
				rejectedHunks: [],
				appliedAiSuggestions: [],
				originalText: pair.oldText,
				originalExists: pair.baselineExists,
				baselineExists: pair.baselineExists,
				currentExists: pair.currentExists,
				revision: 0,
				skippedReason: diff.skippedReason,
			};
		}

		return {
			uri: pair.uri,
			relativePath: pair.relativePath,
			projectId: pair.projectId,
			projectName: pair.projectName,
			oldText: pair.oldText,
			newText: pair.newText,
			hunks: diff.hunks,
			acceptedHunks: [],
			rejectedHunks: [],
			appliedAiSuggestions: [],
			originalText: pair.oldText,
			originalExists: pair.baselineExists,
			baselineExists: pair.baselineExists,
			currentExists: pair.currentExists,
			revision: 0,
		};
	}

	private createManualBaselineFileState(uri: vscode.Uri, text: string): ReviewFileState {
		const project = this.gitProjectForUri(uri);
		const rootUri = project?.rootUri ?? this.activeSession?.rootUri ?? vscode.workspace.getWorkspaceFolder(uri)?.uri ?? vscode.Uri.file(path.dirname(uri.fsPath));
		return {
			uri,
			relativePath: relativePath(rootUri, uri),
			projectId: project?.id,
			projectName: project?.name,
			oldText: text,
			newText: text,
			hunks: [],
			acceptedHunks: [],
			rejectedHunks: [],
			appliedAiSuggestions: [],
			originalText: text,
			originalExists: true,
			baselineExists: true,
			currentExists: true,
			revision: 0,
		};
	}

	private async ensureManualReviewSession(uri: vscode.Uri): Promise<void> {
		if (this.activeSession || !vscode.workspace.getConfiguration('cliDiff').get<boolean>('autoStartGitReview', true)) {
			return;
		}

		const folder = vscode.workspace.getWorkspaceFolder(uri);
		if (folder) {
			await this.initializeGitSessionForFolder(folder);
		}
	}

	private async acceptChange(uriString?: string, hunkId?: string, expectedRevision?: number): Promise<void> {
		await this.enqueueFileOperation(this.operationUri(uriString), () => this.acceptChangeCore(uriString, hunkId, expectedRevision));
	}

	private async acceptChangeCore(uriString?: string, hunkId?: string, expectedRevision?: number): Promise<void> {
		try {
			const target = this.resolveHunk(uriString, hunkId);
			if (!target) {
				vscode.window.showInformationMessage('No Cli Diff Review change selected.');
				return;
			}

			if (this.isStaleMutation(target.file, expectedRevision)) {
				await this.refreshFile(target.file.uri, { reconcileExternalChanges: false });
				return;
			}
			if (!this.ensureFileCleanForReviewMutation(target.file)) {
				return;
			}
			const hunk = this.requireGitHunk(target.hunk);
			const folder = this.requireGitFolder(target.file);
			const project = this.requireGitProject(target.file);
			const headOid = await this.ensureGitHeadUnchanged(target.file, folder);
			const appliedAiSuggestion = target.file.appliedAiSuggestions.find((suggestion) => suggestion.currentHunkId === target.hunk.id);
			const record = await this.gitReviewJournal.accept(
				project,
				headOid,
				target.file.relativePath,
				target.file.uri,
				hunk,
				target.file.gitSnapshot?.indexBlobOid,
				appliedAiSuggestion,
			);
			target.file.hunks = target.file.hunks.filter((candidate) => candidate.id !== target.hunk.id);
			const accepted = this.gitReviewJournal.toAcceptedHunk(record, hunk);
			target.file.acceptedHunks.push(accepted);
			this.touchFileRevision(target.file);
			this.refreshUi();
		} catch (error) {
			this.showError(error);
		}
	}

	private async rejectChange(uriString?: string, hunkId?: string, expectedRevision?: number): Promise<void> {
		await this.enqueueFileOperation(this.operationUri(uriString), () => this.rejectChangeCore(uriString, hunkId, expectedRevision));
	}

	private async rejectChangeCore(uriString?: string, hunkId?: string, expectedRevision?: number): Promise<void> {
		try {
			const target = this.resolveHunk(uriString, hunkId);
			if (!target) {
				vscode.window.showInformationMessage('No Cli Diff Review change selected.');
				return;
			}

			if (this.isStaleMutation(target.file, expectedRevision)) {
				await this.refreshFile(target.file.uri, { reconcileExternalChanges: false });
				return;
			}
			if (!this.ensureFileCleanForReviewMutation(target.file)) {
				return;
			}
			const hunk = this.requireGitHunk(target.hunk);
			const folder = this.requireGitFolder(target.file);
			const project = this.requireGitProject(target.file);
			const [headOid, beforeHash] = await Promise.all([
				this.ensureGitHeadUnchanged(target.file, folder),
				fileStateHash(target.file.uri),
			]);
			const afterHash = expectedRejectedFileHash(
				target.file.newText,
				hunk,
				target.file.gitSnapshot?.indexExists ?? target.file.baselineExists,
			);
			const appliedAiSuggestion = target.file.appliedAiSuggestions.find((suggestion) => suggestion.currentHunkId === target.hunk.id);
			const record = await this.gitReviewJournal.prepare(
				project,
				headOid,
				target.file.relativePath,
				target.file.uri,
				hunk,
				beforeHash,
				afterHash,
				appliedAiSuggestion,
				{
					exists: target.file.gitSnapshot?.indexExists ?? target.file.baselineExists,
					oid: target.file.gitSnapshot?.indexBlobOid,
				},
			);
			let applied = false;
			try {
				await this.gitService.applyPatch(folder, hunk.patch, { reverse: true, check: true });
				await this.withInternalWrite(target.file.uri, 'plugin', () => this.gitService.applyPatch(folder, hunk.patch, { reverse: true }));
				applied = true;
				await this.synchronizeOpenDocumentAfterGitMutation(target.file.uri);
				await this.gitReviewJournal.setState(project, headOid, record.id, 'applied');
			} catch (error) {
				if (!applied) {
					await this.gitReviewJournal.remove(project, headOid, record.id);
				}
				throw error;
			}
			await this.refreshGitReviewFile(target.file.uri);
		} catch (error) {
			this.showError(error);
		}
	}

	private async restoreChange(uriString?: string, hunkId?: string, expectedRevision?: number): Promise<void> {
		await this.enqueueFileOperation(this.operationUri(uriString), () => this.restoreChangeCore(uriString, hunkId, expectedRevision));
	}

	private async restoreChangeCore(uriString?: string, hunkId?: string, expectedRevision?: number): Promise<void> {
		try {
			const preflightFile = this.resolveFile(uriString);
			if (preflightFile && this.isStaleMutation(preflightFile, expectedRevision)) {
				await this.refreshFile(preflightFile.uri, { reconcileExternalChanges: false });
				return;
			}

			const target = this.resolveDecisionHunk(uriString, hunkId);
			if (!target) {
				vscode.window.showInformationMessage('No accepted or rejected Cli Diff Review change selected.');
				return;
			}
			if (this.isStaleMutation(target.file, expectedRevision)) {
				await this.refreshFile(target.file.uri, { reconcileExternalChanges: false });
				return;
			}
			if (!this.ensureFileCleanForReviewMutation(target.file)) {
				return;
			}
			if (target.list === 'accepted' && target.hunk.appliedAiSuggestion && target.hunk.patch) {
				const folder = this.requireGitFolder(target.file);
				const project = this.requireGitProject(target.file);
				const headOid = await this.ensureGitHeadUnchanged(target.file, folder);
				const reviewSession = this.sessionForFile(target.file);
				const storedReview = this.aiReviewStore.load(reviewSession);
				this.retainAppliedAiSuggestions(target.file, [target.hunk.appliedAiSuggestion]);
				await this.gitReviewJournal.remove(project, headOid, target.hunk.id);
				await this.refreshGitReviewFile(target.file.uri);
				const restoredFile = this.resolveFile(target.file.uri.toString());
				await this.saveAiReviewWithCurrentSignature(storedReview, restoredFile ? this.sessionForFile(restoredFile) : reviewSession);
				return;
			}
			if (target.hunk.patch) {
				const hunk = this.requireGitHunk(target.hunk);
				const folder = this.requireGitFolder(target.file);
				if (target.list === 'accepted') {
					const project = this.requireGitProject(target.file);
					const headOid = await this.ensureGitHeadUnchanged(target.file, folder);
					await this.gitReviewJournal.remove(project, headOid, target.hunk.id);
				} else {
					await this.ensureGitHeadUnchanged(target.file, folder);
					if (target.hunk.operable === false) {
						throw new Error('This rejected change is stale and cannot be safely undone.');
					}
					const project = this.requireGitProject(target.file);
					const headOid = project.headOid ?? await this.gitService.headOid(folder);
					await this.gitReviewJournal.setState(project, headOid, target.hunk.id, 'undoing');
					let applied = false;
					try {
						await this.gitService.applyPatch(folder, hunk.patch, { check: true });
						await this.withInternalWrite(target.file.uri, 'plugin', () => this.gitService.applyPatch(folder, hunk.patch));
						applied = true;
						await this.synchronizeOpenDocumentAfterGitMutation(target.file.uri);
						await this.gitReviewJournal.remove(project, headOid, target.hunk.id);
					} catch (error) {
						if (!applied) {
							await this.gitReviewJournal.setState(project, headOid, target.hunk.id, 'applied');
						}
						throw error;
					}
				}
				if (target.hunk.appliedAiSuggestion) {
					this.retainAppliedAiSuggestions(target.file, [target.hunk.appliedAiSuggestion]);
				}
				await this.refreshGitReviewFile(target.file.uri);
				this.refreshUi();
				return;
			}

			let aiReviewSession: ReviewSession | undefined;
			let aiReviewToResign: StoredAiReview | undefined;
			if (target.list === 'accepted') {
				const baselineStart = target.hunk.baselineStart;
				if (!this.reviewedBaselineSideMatches(target.file.oldText, target.hunk, baselineStart, target.hunk.newLines, target.hunk.newText)) {
					await this.refreshFile(target.file.uri, { reconcileExternalChanges: false });
					return;
				}
				const appliedSuggestion = target.hunk.appliedAiSuggestion;
				aiReviewSession = appliedSuggestion ? this.sessionForFile(target.file) : undefined;
				aiReviewToResign = appliedSuggestion ? this.aiReviewStore.load(aiReviewSession) : undefined;
				target.file.oldText = replaceLineBlock(target.file.oldText, baselineStart, target.hunk.newLines, target.hunk.oldText);
				target.file.acceptedHunks = target.file.acceptedHunks.filter((item) => item.id !== target.hunk.id);
				this.mapDecisionBaselineStarts(target.file, [{
					oldStart: baselineStart,
					oldLines: target.hunk.newLines,
					newLines: target.hunk.oldLines,
				}]);
				if (appliedSuggestion) {
					this.retainAppliedAiSuggestions(target.file, [appliedSuggestion]);
				}
				this.syncBaselineExistsForPending(target.file);
			} else {
				const current = await this.readCurrentText(target.file.uri);
				const currentStart = target.hunk.currentStart;
				if (!this.reviewedCurrentSideMatches(current.text, target.hunk, currentStart, target.hunk.displayLines, target.hunk.oldText)) {
					await this.refreshFile(target.file.uri, { reconcileExternalChanges: false });
					return;
				}
				const currentText = replaceLineBlock(current.text, currentStart, target.hunk.displayLines, target.hunk.newText);
				await this.writeCurrentFileText(target.file.uri, currentText);
				target.file.newText = currentText;
				target.file.currentExists = true;
				target.file.rejectedHunks = target.file.rejectedHunks.filter((item) => item.id !== target.hunk.id);
				this.mapDecisionCurrentStarts(target.file, [{
					oldStart: currentStart,
					oldLines: target.hunk.displayLines,
					newLines: target.hunk.newLines,
				}]);
				this.retainAppliedAiSuggestions(target.file, [target.hunk.appliedAiSuggestion]);
			}

			this.refreshPendingHunksFromReviewState(target.file);
			this.touchFileRevision(target.file);
			await this.saveAiReviewWithCurrentSignature(aiReviewToResign, aiReviewSession);
			await this.refreshFile(target.file.uri, { reconcileExternalChanges: false });
		} catch (error) {
			this.showError(error);
		}
	}

	private async acceptFile(uriString?: string | ReviewFileState, expectedRevision?: number): Promise<void> {
		await this.enqueueFileOperation(this.operationUri(uriString), () => this.acceptFileCore(uriString, expectedRevision));
	}

	private async acceptFileCore(uriString?: string | ReviewFileState, expectedRevision?: number): Promise<void> {
		try {
			const file = this.resolveFile(uriString);
			if (!file) {
				vscode.window.showInformationMessage('No Cli Diff Review file selected.');
				return;
			}
			if (this.isStaleMutation(file, expectedRevision)) {
				await this.refreshFile(file.uri, { reconcileExternalChanges: false });
				return;
			}
			if (!this.ensureFileCleanForReviewMutation(file)) {
				return;
			}
			if (file.gitSnapshot) {
				const hunks = file.hunks.map((hunk) => this.requireGitHunk(hunk));
				if (hunks.length === 0) {
					return;
				}
				const folder = this.requireGitFolder(file);
				const project = this.requireGitProject(file);
				const headOid = await this.ensureGitHeadUnchanged(file, folder);
				for (const hunk of hunks) {
					const appliedAiSuggestion = file.appliedAiSuggestions.find((suggestion) => suggestion.currentHunkId === hunk.id);
					const record = await this.gitReviewJournal.accept(
						project,
						headOid,
						file.relativePath,
						file.uri,
						hunk,
						file.gitSnapshot.indexBlobOid,
						appliedAiSuggestion,
					);
					const accepted = this.gitReviewJournal.toAcceptedHunk(record, hunk);
					file.acceptedHunks.push(accepted);
				}
				file.hunks = [];
				this.touchFileRevision(file);
				this.refreshUi();
				return;
			}

			const current = await this.readCurrentText(file.uri);
			file.newText = current.text;
			file.currentExists = current.exists;
			const pendingHunks = [...file.hunks];
			if (pendingHunks.some((hunk) => !this.originalHunkSideMatches(file.oldText, hunk, 'old', hunk.oldStart))) {
				await this.refreshUnmatchedMutation(file);
				return;
			}
			const baselineEdits = pendingHunks.map((hunk) => ({
				oldStart: hunk.oldStart,
				oldLines: hunk.oldLines,
				newLines: hunk.newLines,
			}));
			file.oldText = file.newText;
			file.baselineExists = file.currentExists;
			this.mapDecisionBaselineStarts(file, baselineEdits);
			for (const hunk of pendingHunks) {
				this.recordDecisionHunk(file, hunk, 'accept', hunk.newStart, hunk.newLines, hunk.newStart, hunk.newStart);
			}
			file.hunks = [];
			file.appliedAiSuggestions = [];
			this.touchFileRevision(file);
			await this.refreshFile(file.uri, { reconcileExternalChanges: false });
		} catch (error) {
			this.showError(error);
		}
	}

	private async rejectFile(uriString?: string | ReviewFileState, expectedRevision?: number): Promise<void> {
		await this.enqueueFileOperation(this.operationUri(uriString), () => this.rejectFileCore(uriString, expectedRevision));
	}

	private async rejectFileCore(uriString?: string | ReviewFileState, expectedRevision?: number): Promise<void> {
		try {
			const file = this.resolveFile(uriString);
			if (!file) {
				vscode.window.showInformationMessage('No Cli Diff Review file selected.');
				return;
			}
			if (this.isStaleMutation(file, expectedRevision)) {
				await this.refreshFile(file.uri, { reconcileExternalChanges: false });
				return;
			}
			if (!this.ensureFileCleanForReviewMutation(file)) {
				return;
			}
			if (file.gitSnapshot) {
				const hunks = file.hunks.map((hunk) => this.requireGitHunk(hunk));
				if (hunks.length === 0) {
					return;
				}
				const folder = this.requireGitFolder(file);
				const project = this.requireGitProject(file);
				const [headOid, beforeHash] = await Promise.all([
					this.ensureGitHeadUnchanged(file, folder),
					fileStateHash(file.uri),
				]);
				let rejectedText = file.newText;
				for (const hunk of [...hunks].sort((left, right) => right.newStart - left.newStart)) {
					rejectedText = replaceLineBlock(rejectedText, hunk.newStart, hunk.newLines, hunk.oldText);
				}
				const afterHash = contentStateHash(rejectedText, file.gitSnapshot.indexExists);
				const records = [];
				for (const hunk of hunks) {
					records.push(await this.gitReviewJournal.prepare(
						project,
						headOid,
						file.relativePath,
						file.uri,
						hunk,
						beforeHash,
						afterHash,
						file.appliedAiSuggestions.find((suggestion) => suggestion.currentHunkId === hunk.id),
						{ exists: file.gitSnapshot.indexExists, oid: file.gitSnapshot.indexBlobOid },
					));
				}
				const patch = this.gitService.combinePatches(hunks);
				let applied = false;
				try {
					await this.gitService.applyPatch(folder, patch, { reverse: true, check: true });
					await this.withInternalWrite(file.uri, 'plugin', () => this.gitService.applyPatch(folder, patch, { reverse: true }));
					applied = true;
					await this.synchronizeOpenDocumentAfterGitMutation(file.uri);
					for (const record of records) {
						await this.gitReviewJournal.setState(project, headOid, record.id, 'applied');
					}
				} catch (error) {
					if (!applied) {
						for (const record of records) {
							await this.gitReviewJournal.remove(project, headOid, record.id);
						}
					}
					throw error;
				}
				await this.refreshGitReviewFile(file.uri);
				return;
			}

			await this.refreshFile(file.uri);
			const refreshedFile = this.resolveFile(file.uri.toString()) ?? file;
			const pendingHunks = [...refreshedFile.hunks];
			if (pendingHunks.length === 0) {
				return;
			}

			let currentText = refreshedFile.newText;
			if (pendingHunks.some((hunk) => !this.originalHunkSideMatches(currentText, hunk, 'new', hunk.newStart))) {
				await this.refreshUnmatchedMutation(refreshedFile);
				return;
			}
			for (const hunk of [...pendingHunks].sort((left, right) => right.newStart - left.newStart)) {
				currentText = replaceLineBlock(currentText, hunk.newStart, hunk.newLines, hunk.oldText);
			}
			const currentEdits = pendingHunks.map((hunk) => ({
				oldStart: hunk.newStart,
				oldLines: hunk.newLines,
				newLines: hunk.oldLines,
			}));

			refreshedFile.newText = currentText;
			refreshedFile.currentExists = true;
			this.mapDecisionCurrentStarts(refreshedFile, currentEdits);
			for (const hunk of pendingHunks) {
				this.recordDecisionHunk(refreshedFile, hunk, 'reject', hunk.oldStart, hunk.oldLines, hunk.oldStart, hunk.oldStart);
			}
			refreshedFile.hunks = [];
			refreshedFile.appliedAiSuggestions = [];
			this.touchFileRevision(refreshedFile);

			await this.writeCurrentFileText(refreshedFile.uri, currentText);
			await this.refreshFile(refreshedFile.uri, { reconcileExternalChanges: false });
		} catch (error) {
			this.showError(error);
		}
	}

	private async undoFile(uriString?: string | ReviewFileState, expectedRevision?: number): Promise<void> {
		await this.enqueueFileOperation(this.operationUri(uriString), () => this.undoFileCore(uriString, expectedRevision));
	}

	private async undoFileCore(uriString?: string | ReviewFileState, expectedRevision?: number): Promise<void> {
		try {
			const file = this.resolveFile(uriString);
			if (!file) {
				vscode.window.showInformationMessage('No Cli Diff Review file selected.');
				return;
			}
			if (this.isStaleMutation(file, expectedRevision)) {
				await this.refreshFile(file.uri, { reconcileExternalChanges: false });
				return;
			}
			if (!this.ensureFileCleanForReviewMutation(file)) {
				return;
			}
			if (file.gitSnapshot) {
				const rejected = file.rejectedHunks.filter((hunk) => hunk.operable !== false).map((hunk) => this.requireGitHunk(hunk));
				const decisionSuggestions = [...file.acceptedHunks, ...file.rejectedHunks]
					.map((hunk) => hunk.appliedAiSuggestion)
					.filter((suggestion): suggestion is AppliedAiSuggestion => Boolean(suggestion));
				if (file.acceptedHunks.length === 0 && rejected.length === 0) {
					return;
				}
				const aiReviewSession = decisionSuggestions.length > 0 ? this.sessionForFile(file) : undefined;
				const aiReviewToResign = aiReviewSession ? this.aiReviewStore.load(aiReviewSession) : undefined;
				const folder = this.requireGitFolder(file);
				const rejectedPatch = rejected.length > 0 ? this.gitService.combinePatches(rejected) : undefined;
				await Promise.all([
					this.ensureGitHeadUnchanged(file, folder),
					rejectedPatch
						? this.gitService.applyPatch(folder, rejectedPatch, { check: true })
						: Promise.resolve(),
				]);
				const rejectedProject = rejected.length > 0 ? this.requireGitProject(file) : undefined;
				const rejectedHeadOid = rejectedProject ? rejectedProject.headOid ?? await this.gitService.headOid(folder) : undefined;
				if (rejectedProject && rejectedHeadOid !== undefined) {
					for (const hunk of file.rejectedHunks.filter((candidate) => candidate.operable !== false)) {
						await this.gitReviewJournal.setState(rejectedProject, rejectedHeadOid, hunk.id, 'undoing');
					}
				}
				try {
					if (rejectedPatch) {
						await this.withInternalWrite(file.uri, 'plugin', () => this.gitService.applyPatch(folder, rejectedPatch));
						await this.synchronizeOpenDocumentAfterGitMutation(file.uri);
					}
				} catch (error) {
					if (rejectedPatch) {
						await this.gitService.applyPatch(folder, rejectedPatch, { reverse: true }).catch(() => undefined);
						await this.synchronizeOpenDocumentAfterGitMutation(file.uri).catch(() => undefined);
					}
					if (rejectedProject && rejectedHeadOid !== undefined) {
						for (const hunk of file.rejectedHunks.filter((candidate) => candidate.operable !== false)) {
							await this.gitReviewJournal.setState(rejectedProject, rejectedHeadOid, hunk.id, 'applied');
						}
					}
					throw error;
				}
				if (rejectedProject && rejectedHeadOid !== undefined) {
					for (const hunk of file.rejectedHunks.filter((candidate) => candidate.operable !== false)) {
						await this.gitReviewJournal.remove(rejectedProject, rejectedHeadOid, hunk.id);
					}
				}
				const project = this.requireGitProject(file);
				const headOid = project.headOid ?? await this.gitService.headOid(folder);
				await this.gitReviewJournal.removeMany(project, headOid, file.acceptedHunks.map((hunk) => hunk.id));
				this.retainAppliedAiSuggestions(file, decisionSuggestions);
				await this.refreshGitReviewFile(file.uri);
				const restoredFile = this.resolveFile(file.uri.toString());
				await this.saveAiReviewWithCurrentSignature(aiReviewToResign, restoredFile ? this.sessionForFile(restoredFile) : aiReviewSession);
				return;
			}

			const aiReviewSession = file.acceptedHunks.some((hunk) => hunk.appliedAiSuggestion)
				? this.sessionForFile(file)
				: undefined;
			const aiReviewToResign = aiReviewSession ? this.aiReviewStore.load(aiReviewSession) : undefined;
			await this.restoreDecisionsToPending(file);
			this.refreshPendingHunksFromReviewState(file);
			this.touchFileRevision(file);
			await this.saveAiReviewWithCurrentSignature(aiReviewToResign, aiReviewSession);
			await this.refreshFile(file.uri, { reconcileExternalChanges: false });
		} catch (error) {
			this.showError(error);
		}
	}

	private async acceptAll(): Promise<void> {
		await this.applyBulkFileOperation('accept');
	}

	private async rejectAll(): Promise<void> {
		await this.applyBulkFileOperation('reject');
	}

	private async undoAll(): Promise<void> {
		await this.applyBulkFileOperation('undo');
	}

	private async applyBulkFileOperation(action: 'accept' | 'reject' | 'undo'): Promise<void> {
		const targets = this.bulkFileTargets(action);
		if (targets.length === 0) {
			vscode.window.showInformationMessage(action === 'undo'
				? 'No reviewed Cli Diff Review changes.'
				: 'No pending Cli Diff Review changes.');
			return;
		}

		const dirtyTargets = targets.filter((target) => this.isOpenDocumentDirty(target.file.uri));
		if (dirtyTargets.length > 0) {
			for (const target of dirtyTargets) {
				this.refreshReviewPresentation(target.file.uri);
			}
			vscode.window.showInformationMessage('Save or revert target files before accepting, rejecting, or undoing all Cli Diff Review changes.');
			return;
		}

		const chunkCount = targets.reduce((sum, target) => sum + target.chunkCount, 0);
		const confirmationLabel = this.bulkConfirmationLabel(action);
		const confirmed = await vscode.window.showWarningMessage(
			this.bulkConfirmationMessage(action, targets.length, chunkCount),
			{ modal: true },
			confirmationLabel,
		);
		if (confirmed !== confirmationLabel) {
			return;
		}
		if (targets.every((target) => Boolean(target.file.gitSnapshot))) {
			const byProject = new Map<string, ReviewFileState[]>();
			for (const target of targets) {
				const project = this.requireGitProject(target.file);
				byProject.set(project.id, [...(byProject.get(project.id) ?? []), target.file]);
			}
			const failures: string[] = [];
			for (const files of byProject.values()) {
				const project = this.requireGitProject(files[0]);
				try {
					await this.fileOperationQueue.enqueue(uriKey(project.rootUri), () => this.applyGitProjectBulkOperation(action, project, files));
				} catch (error) {
					failures.push(`${project.name}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			await this.refreshGitSessionFiles({ source: 'gitIndexChanged' });
			if (failures.length > 0) {
				void vscode.window.showWarningMessage(`Some Git review operations failed:\n${failures.join('\n')}`);
			}
			return;
		}

		for (const target of targets) {
			await this.enqueueFileOperation(target.file.uri, async () => {
				if (action === 'accept') {
					await this.acceptFileCore(target.file);
				} else if (action === 'reject') {
					await this.rejectFileCore(target.file);
				} else {
					await this.undoFileCore(target.file);
				}
			});
		}
	}

	private async applyGitProjectBulkOperation(action: 'accept' | 'reject' | 'undo', project: ReviewProject, files: ReviewFileState[]): Promise<void> {
		const folder = reviewProjectFolder(project);
		await this.ensureGitHeadUnchanged(files[0], folder);
		if (action === 'accept') {
			const headOid = project.headOid ?? await this.gitService.headOid(folder);
			for (const file of files) {
				for (const hunk of file.hunks.map((candidate) => this.requireGitHunk(candidate))) {
					await this.gitReviewJournal.accept(
						project,
						headOid,
						file.relativePath,
						file.uri,
						hunk,
						file.gitSnapshot?.indexBlobOid,
						file.appliedAiSuggestions.find((suggestion) => suggestion.currentHunkId === hunk.id),
					);
				}
			}
			return;
		}
		if (action === 'reject') {
			const headOid = project.headOid ?? await this.gitService.headOid(folder);
			const records: Array<{ id: string }> = [];
			const hunks: GitReviewHunk[] = [];
			for (const file of files) {
				const fileHunks = file.hunks.map((hunk) => this.requireGitHunk(hunk));
				hunks.push(...fileHunks);
				let rejectedText = file.newText;
				for (const hunk of [...fileHunks].sort((left, right) => right.newStart - left.newStart)) {
					rejectedText = replaceLineBlock(rejectedText, hunk.newStart, hunk.newLines, hunk.oldText);
				}
				const beforeHash = await fileStateHash(file.uri);
				const afterHash = contentStateHash(rejectedText, file.gitSnapshot?.indexExists ?? file.baselineExists);
				for (const hunk of fileHunks) {
					records.push(await this.gitReviewJournal.prepare(
						project,
						headOid,
						file.relativePath,
						file.uri,
						hunk,
						beforeHash,
						afterHash,
						file.appliedAiSuggestions.find((suggestion) => suggestion.currentHunkId === hunk.id),
						{
							exists: file.gitSnapshot?.indexExists ?? file.baselineExists,
							oid: file.gitSnapshot?.indexBlobOid,
						},
					));
				}
			}
			const patch = this.gitService.combinePatches(hunks);
			let applied = false;
			try {
				await this.gitService.applyPatch(folder, patch, { reverse: true, check: true });
				await this.withInternalWrites(files.map((file) => file.uri), () => this.gitService.applyPatch(folder, patch, { reverse: true }));
				applied = true;
				for (const record of records) {
					await this.gitReviewJournal.setState(project, headOid, record.id, 'applied');
				}
			} catch (error) {
				if (!applied) {
					for (const record of records) {
						await this.gitReviewJournal.remove(project, headOid, record.id);
					}
				}
				throw error;
			}
			return;
		}

		const rejectedHunks = files.flatMap((file) => file.rejectedHunks.filter((hunk) => hunk.operable !== false));
		const rejected = rejectedHunks.map((hunk) => this.requireGitHunk(hunk));
		const rejectedPatch = rejected.length > 0 ? this.gitService.combinePatches(rejected) : undefined;
		if (rejectedPatch) {
			await this.gitService.applyPatch(folder, rejectedPatch, { check: true });
		}
		const headOid = project.headOid ?? await this.gitService.headOid(folder);
		for (const hunk of rejectedHunks) {
			await this.gitReviewJournal.setState(project, headOid, hunk.id, 'undoing');
		}
		try {
			if (rejectedPatch) {
				await this.withInternalWrites(files.map((file) => file.uri), () => this.gitService.applyPatch(folder, rejectedPatch));
			}
		} catch (error) {
			for (const hunk of rejectedHunks) {
				await this.gitReviewJournal.setState(project, headOid, hunk.id, 'applied');
			}
			throw error;
		}
		for (const file of files) {
			this.retainAppliedAiSuggestions(file, [...file.acceptedHunks, ...file.rejectedHunks].map((hunk) => hunk.appliedAiSuggestion));
		}
		for (const hunk of rejectedHunks) {
			await this.gitReviewJournal.remove(project, headOid, hunk.id);
		}
		await this.gitReviewJournal.removeMany(project, headOid, files.flatMap((file) => file.acceptedHunks.map((hunk) => hunk.id)));
	}

	private bulkFileTargets(action: 'accept' | 'reject' | 'undo'): Array<{ file: ReviewFileState; chunkCount: number }> {
		if (!this.activeSession) {
			return [];
		}

		return visibleReviewFiles(this.activeSession)
			.map((file) => ({
				file,
				chunkCount: action === 'undo' ? file.acceptedHunks.length + file.rejectedHunks.length : file.hunks.length,
			}))
			.filter((target) => target.chunkCount > 0)
			.sort((left, right) => left.file.relativePath.localeCompare(right.file.relativePath));
	}

	private bulkConfirmationMessage(action: 'accept' | 'reject' | 'undo', fileCount: number, chunkCount: number): string {
		if (action === 'accept') {
			return `Accept all ${chunkCount} pending changes across ${fileCount} files?`;
		}
		if (action === 'reject') {
			return `Reject all ${chunkCount} pending changes across ${fileCount} files? This will modify working files.`;
		}
		return `Undo all ${chunkCount} reviewed changes across ${fileCount} files? This will restore them to pending.`;
	}

	private bulkConfirmationLabel(action: 'accept' | 'reject' | 'undo'): string {
		if (action === 'accept') {
			return 'Accept All';
		}
		if (action === 'reject') {
			return 'Reject All';
		}
		return 'Undo All';
	}

	private async saveEditedCurrent(uriString: string, editedText: string, editedRanges: EditedRange[]): Promise<void> {
		try {
			const uri = vscode.Uri.parse(uriString);
			await this.ensureGitReviewForUri(uri);

			const file = this.resolveFile(uriString);
			if (!file) {
				await this.writeCurrentFileText(uri, editedText, 'human');
				return;
			}

			await this.writeCurrentFileText(uri, editedText, 'human');
			await this.refreshFile(file.uri, { reconcileExternalChanges: false, preferDisk: true });
		} catch (error) {
			this.showError(error);
		}
	}

	private async flushHumanEdits(document: vscode.TextDocument): Promise<void> {
		try {
			const key = uriKey(document.uri);
			const editedRanges = this.humanEditBatches.get(key) ?? [];
			this.humanEditBatches.delete(key);
			this.humanSaveIntents.delete(key);

			await this.ensureManualReviewSession(document.uri);
			if (this.activeSession?.mode === 'git') {
				await this.refreshGitSessionFiles({ source: 'gitIndexChanged' });
				return;
			}
			let file = this.resolveFile(document.uri.toString());
			if (!file) {
				file = this.createManualBaselineFileState(document.uri, document.getText());
				this.activeSession?.files.set(key, file);
				this.refreshUi();
				return;
			}

			void editedRanges;
			await this.refreshFile(file.uri, { reconcileExternalChanges: false, preferDisk: true });
		} catch (error) {
			this.showError(error);
		}
	}

	private async navigateChange(direction: 1 | -1, uriString?: string, hunkId?: string): Promise<void> {
		const hunks = this.flattenHunks();
		if (hunks.length === 0) {
			vscode.window.showInformationMessage('No Cli Diff Review changes to navigate.');
			return;
		}

		let index = direction === 1 ? 0 : hunks.length - 1;

		if (uriString && hunkId) {
			const currentIndex = hunks.findIndex((item) => uriKey(item.file.uri) === uriKey(vscode.Uri.parse(uriString)) && item.hunk.id === hunkId);
			if (currentIndex >= 0) {
				index = (currentIndex + direction + hunks.length) % hunks.length;
			}
		} else {
			const activeUri = vscode.window.activeTextEditor?.document.uri;
			const activeLine = vscode.window.activeTextEditor?.selection.active.line ?? 0;
			if (activeUri) {
				const sameFileHunks = hunks
					.map((item, itemIndex) => ({ ...item, itemIndex }))
					.filter((item) => uriKey(item.file.uri) === uriKey(activeUri));
				const current = direction === 1
					? sameFileHunks.find((item) => item.hunk.newStart > activeLine)
					: [...sameFileHunks].reverse().find((item) => item.hunk.newStart < activeLine);
				if (current) {
					index = current.itemIndex;
				}
			}
		}

		await this.openFileAtChange(hunks[index].file.uri.toString(), hunks[index].hunk.id);
	}

	private async openReviewView(uriString?: string): Promise<void> {
		const uri = uriString ? vscode.Uri.parse(uriString) : vscode.window.activeTextEditor?.document.uri;
		if (!uri) {
			vscode.window.showInformationMessage('No active file to review.');
			return;
		}

		await this.ensureGitReviewForUri(uri);
		await this.openReviewPresentation(uri);
	}

	private async openReviewPresentation(uri: vscode.Uri, reveal?: Pick<ReviewRevealPosition, 'line' | 'column'>): Promise<void> {
		const file = this.activeSession?.files.get(uriKey(uri));
		const effectiveReveal = reveal ?? (file ? firstReviewRevealPosition(file) : undefined);
		await this.reviewWebview.open(uri, effectiveReveal?.line !== undefined ? {
			line: effectiveReveal.line,
			column: effectiveReveal.column ?? 0,
		} : undefined);
		this.setCurrentReviewUri(uri);
	}

	private async navigateFromReview(
		type: ReviewNavigationRequestType,
		uriString: string,
		line: number,
		column: number,
		requestId?: number,
	): Promise<ReviewNavigationResponse | undefined> {
		const sourceUri = vscode.Uri.parse(uriString);
		const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
		const position = this.providerPosition(sourceDocument, line, column);

		if (type === 'resolveNavigationAction') {
			const action = await this.resolveReviewNavigationAction(sourceUri, sourceDocument, position);
			return {
				type: 'navigationAction',
				requestId: requestId ?? 0,
				action,
				label: this.navigationActionLabel(action),
			};
		}

		const action = type === 'smartNavigate'
			? await this.resolveReviewNavigationAction(sourceUri, sourceDocument, position)
			: type;

		return this.navigateFromResolvedAction(action, sourceUri, position);
	}

	private async navigateFromResolvedAction(
		action: ReviewNavigationAction,
		sourceUri: vscode.Uri,
		position: vscode.Position,
	): Promise<ReviewNavigationResponse | undefined> {
		if (action === 'findReferences') {
			const targets = await this.referenceTargets(sourceUri, position);
			if (targets.length === 0) {
				vscode.window.showInformationMessage('No references found.');
			}
			return {
				type: 'references',
				title: 'References',
				sourceUri: sourceUri.toString(),
				targets: await this.navigationTargetPayloads(targets, sourceUri),
			};
		}

		const targets = await this.definitionTargets(sourceUri, position);
		if (targets.length === 0) {
			vscode.window.showInformationMessage('No definition found.');
			return undefined;
		}
		if (targets.length === 1) {
			await this.openResolvedLocation(targets[0].uri, targets[0].range);
			return undefined;
		}
		const picked = await vscode.window.showQuickPick(targets, {
			placeHolder: 'Select a definition',
			matchOnDescription: true,
			matchOnDetail: true,
		});
		if (picked) {
			await this.openResolvedLocation(picked.uri, picked.range);
		}
		return undefined;
	}

	private async resolveReviewNavigationAction(
		sourceUri: vscode.Uri,
		sourceDocument: vscode.TextDocument,
		position: vscode.Position,
	): Promise<ReviewNavigationAction> {
		try {
			if (await this.isDefinitionPosition(sourceUri, sourceDocument, position)) {
				return 'findReferences';
			}
		} catch {
			// Hover and smart-click should remain usable even if one provider fails.
		}
		return 'goToDefinition';
	}

	private navigationActionLabel(action: ReviewNavigationAction): string {
		return action === 'findReferences' ? 'Find References' : 'Go to Definition';
	}

	private async definitionTargets(uri: vscode.Uri, position: vscode.Position): Promise<ReviewNavigationTarget[]> {
		const locations = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
			'vscode.executeDefinitionProvider',
			uri,
			position,
		);
		return this.navigationTargets(locations ?? []);
	}

	private async referenceTargets(uri: vscode.Uri, position: vscode.Position): Promise<ReviewNavigationTarget[]> {
		const locations = await vscode.commands.executeCommand<vscode.Location[]>(
			'vscode.executeReferenceProvider',
			uri,
			position,
		);
		return this.navigationTargets(locations ?? []);
	}

	private navigationTargets(locations: Array<vscode.Location | vscode.LocationLink>): ReviewNavigationTarget[] {
		const rootUri = this.activeSession?.rootUri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
		const seen = new Set<string>();
		const targets: ReviewNavigationTarget[] = [];
		for (const location of locations) {
			const normalized = this.normalizeLocation(location);
			const key = `${normalized.uri.toString()}::${normalized.range.start.line}:${normalized.range.start.character}:${normalized.range.end.line}:${normalized.range.end.character}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			const labelPath = rootUri && normalized.uri.scheme === 'file'
				? relativePath(rootUri, normalized.uri)
				: normalized.uri.toString();
			const line = normalized.range.start.line + 1;
			const column = normalized.range.start.character + 1;
			targets.push({
				label: `${labelPath}:${line}:${column}`,
				description: normalized.uri.scheme === 'file' ? normalized.uri.fsPath : normalized.uri.toString(),
				uri: normalized.uri,
				range: normalized.range,
			});
		}
		return targets;
	}

	private async navigationTargetPayloads(targets: ReviewNavigationTarget[], sourceUri: vscode.Uri): Promise<ReviewNavigationTargetPayload[]> {
		const documents = new Map<string, vscode.TextDocument>();
		const payloads: ReviewNavigationTargetPayload[] = [];
		for (const target of targets) {
			const targetKey = uriKey(target.uri);
			let preview = '';
			try {
				let document = documents.get(targetKey);
				if (!document) {
					document = await vscode.workspace.openTextDocument(target.uri);
					documents.set(targetKey, document);
				}
				if (target.range.start.line >= 0 && target.range.start.line < document.lineCount) {
					preview = document.lineAt(target.range.start.line).text.trim();
				}
			} catch {
				preview = '';
			}

			const file = this.activeSession?.files.get(targetKey);
			payloads.push({
				id: `${target.uri.toString()}::${target.range.start.line}:${target.range.start.character}:${target.range.end.line}:${target.range.end.character}`,
				uri: target.uri.toString(),
				label: target.label,
				description: target.description ?? '',
				preview,
				line: target.range.start.line,
				column: target.range.start.character,
				reviewable: this.isReviewableFile(file),
				currentFile: targetKey === uriKey(sourceUri),
			});
		}
		return payloads;
	}

	private async isDefinitionPosition(sourceUri: vscode.Uri, sourceDocument: vscode.TextDocument, position: vscode.Position): Promise<boolean> {
		const definitions = await this.definitionTargets(sourceUri, position);
		const wordRange = this.wordRangeAtPosition(sourceDocument, position);
		if (definitions.some((target) => uriKey(target.uri) === uriKey(sourceUri)
			&& this.rangeTouchesPositionOrWord(target.range, position, wordRange))) {
			return true;
		}

		return this.documentSymbolsContainPosition(sourceUri, position);
	}

	private async documentSymbolsContainPosition(uri: vscode.Uri, position: vscode.Position): Promise<boolean> {
		const symbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
			'vscode.executeDocumentSymbolProvider',
			uri,
		);
		for (const range of this.symbolSelectionRanges(symbols ?? [])) {
			if (range.contains(position)) {
				return true;
			}
		}
		return false;
	}

	private symbolSelectionRanges(symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>): vscode.Range[] {
		const ranges: vscode.Range[] = [];
		for (const symbol of symbols) {
			if ('selectionRange' in symbol) {
				ranges.push(symbol.selectionRange);
				ranges.push(...this.symbolSelectionRanges(symbol.children));
			} else {
				ranges.push(symbol.location.range);
			}
		}
		return ranges;
	}

	private rangeTouchesPositionOrWord(range: vscode.Range, position: vscode.Position, wordRange: vscode.Range | undefined): boolean {
		return range.contains(position) || Boolean(wordRange && this.rangesOverlap(range, wordRange));
	}

	private rangesOverlap(left: vscode.Range, right: vscode.Range): boolean {
		return left.start.isBeforeOrEqual(right.end) && right.start.isBeforeOrEqual(left.end);
	}

	private providerPosition(document: vscode.TextDocument, line: number, column: number): vscode.Position {
		const safeLine = Math.max(0, Math.min(line, document.lineCount - 1));
		const safeColumn = Math.max(0, Math.min(column, document.lineAt(safeLine).text.length));
		const position = document.validatePosition(new vscode.Position(safeLine, safeColumn));
		return this.positionInsideWord(document, position);
	}

	private positionInsideWord(document: vscode.TextDocument, position: vscode.Position): vscode.Position {
		const wordRange = this.wordRangeAtPosition(document, position);
		if (!wordRange) {
			return position;
		}

		const character = Math.min(
			Math.max(position.character, wordRange.start.character),
			Math.max(wordRange.start.character, wordRange.end.character - 1),
		);
		return new vscode.Position(wordRange.start.line, character);
	}

	private wordRangeAtPosition(document: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
		const wordRange = document.getWordRangeAtPosition(position);
		if (wordRange || position.character === 0) {
			return wordRange;
		}
		return document.getWordRangeAtPosition(position.translate(0, -1));
	}

	private normalizeLocation(location: vscode.Location | vscode.LocationLink): { uri: vscode.Uri; range: vscode.Range } {
		if ('targetUri' in location) {
			return {
				uri: location.targetUri,
				range: location.targetSelectionRange ?? location.targetRange,
			};
		}

		return {
			uri: location.uri,
			range: location.range,
		};
	}

	private async openResolvedLocation(uri: vscode.Uri, range: vscode.Range): Promise<void> {
		const file = this.activeSession?.files.get(uriKey(uri));
		if (this.isReviewableFile(file)) {
			await this.openReviewPresentation(uri, { line: range.start.line, column: range.start.character });
			return;
		}

		const document = await vscode.workspace.openTextDocument(uri);
		const editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(range.start, range.start);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	}

	private async openNavigationTarget(uriString: string, line: number, column: number): Promise<void> {
		const uri = vscode.Uri.parse(uriString);
		const document = await vscode.workspace.openTextDocument(uri);
		const safeLine = Math.max(0, Math.min(line, document.lineCount - 1));
		const safeColumn = Math.max(0, Math.min(column, document.lineAt(safeLine).text.length));
		const position = document.validatePosition(new vscode.Position(safeLine, safeColumn));
		await this.openResolvedLocation(uri, new vscode.Range(position, position));
	}

	private async openFileAtChange(uriString: string, hunkId: string): Promise<void> {
		const file = this.resolveFile(uriString);
		const hunk = file?.hunks.find((item) => item.id === hunkId);
		const reviewed = hunk ? undefined : file ? [...file.acceptedHunks, ...file.rejectedHunks]
			.find((item) => item.id === hunkId || item.id.endsWith(`-${hunkId}`)) : undefined;
		const resolvedSuggestion = !hunk && !reviewed
			? file?.appliedAiSuggestions.find((item) => item.resolvedToIndex && item.currentHunkId === hunkId)
			: undefined;
		if (!file || (!hunk && !reviewed && !resolvedSuggestion)) {
			return;
		}
		if (resolvedSuggestion) {
			const line = Math.max(0, resolvedSuggestion.appliedHunk.newStart);
			await this.openResolvedLocation(file.uri, new vscode.Range(line, 0, line, 0));
			return;
		}

		await this.openReviewPresentation(file.uri, {
			line: hunk?.newStart ?? reviewed?.displayStart ?? 0,
			column: 0,
		});
	}

	private async refreshAll(): Promise<void> {
		await this.refreshLlmWikiDashboardState();
		await this.ensureVisibleEditorsReviewed();

		if (!this.activeSession) {
			this.closeCompletedReviewEditorsAfterManualRefresh();
			return;
		}

		await this.refreshGitSessionFiles({ source: 'manual' });
		this.closeCompletedReviewEditorsAfterManualRefresh();
	}

	private closeReviewEditors(): void {
		this.reviewWebview.closeAll();
	}

	private closeCompletedReviewEditorsAfterManualRefresh(): void {
		const closedKeys = new Set(this.reviewWebview.closeCompleted().map(uriKey));
		if (!this.currentReviewUri || !closedKeys.has(uriKey(this.currentReviewUri))) {
			return;
		}

		this.currentReviewUri = undefined;
		this.dashboardProvider.refresh();
		void this.refreshLlmWikiDashboardState();
	}

	private async saveLlmWikiConfig(input: LlmConfigInput): Promise<void> {
		try {
			this.llmConfigState = await this.llmConfigStore.save(input);
			await this.refreshLlmWikiDashboardState({ status: 'idle', progress: 'Configuration saved.', error: undefined });
		} catch (error) {
			this.showError(error);
			await this.refreshLlmWikiDashboardState({
				status: 'unconfigured',
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async selectLlmConfigProfile(profileId: string): Promise<void> {
		try {
			this.llmConfigState = await this.llmConfigStore.selectProfile(profileId);
			await this.refreshLlmWikiDashboardState({ status: 'idle', progress: undefined, error: undefined });
		} catch (error) {
			this.showError(error);
			await this.refreshLlmWikiDashboardState({
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async deleteLlmConfigProfile(profileId: string): Promise<void> {
		try {
			const profile = this.llmConfigState.profiles.find((item) => item.id === profileId)
				?? (await this.llmConfigStore.savedConfig()).profiles.find((item) => item.id === profileId);
			const label = profile?.model || 'this model configuration';
			const confirmed = await vscode.window.showWarningMessage(
				`Delete ${label}?`,
				{ modal: true },
				'Delete',
			);
			if (confirmed !== 'Delete') {
				return;
			}
			this.llmConfigState = await this.llmConfigStore.deleteProfile(profileId);
			await this.refreshLlmWikiDashboardState({ status: 'idle', progress: 'Model configuration deleted.', error: undefined });
		} catch (error) {
			this.showError(error);
			await this.refreshLlmWikiDashboardState({
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private agentProjectKey(rootUri: vscode.Uri): string {
		return uriKey(rootUri);
	}

	private projectAgentRuntime(rootUri: vscode.Uri, projectId?: string): ProjectAgentRuntime {
		const projectKey = this.agentProjectKey(rootUri);
		let runtime = this.projectAgentRuntimes.get(projectKey);
		if (!runtime) {
			runtime = {
				projectKey,
				projectId,
				rootUri,
				checkpointSaveQueue: Promise.resolve(),
				loaded: false,
			};
			this.projectAgentRuntimes.set(projectKey, runtime);
		} else if (projectId) {
			runtime.projectId = projectId;
		}
		return runtime;
	}

	private projectAgentTask(rootUri: vscode.Uri): ProjectAgentTask | undefined {
		return this.projectAgentRuntimes.get(this.agentProjectKey(rootUri))?.task;
	}

	private beginProjectAgentTask(
		kind: ProjectAgentTaskKind,
		root: vscode.WorkspaceFolder,
		projectId?: string,
		continueRun = false,
	): ProjectAgentTask | undefined {
		const runtime = this.projectAgentRuntime(root.uri, projectId);
		if (runtime.task) {
			void vscode.window.showInformationMessage(`${root.name} already has an Agent task running.`);
			return undefined;
		}
		const task: ProjectAgentTask = {
			id: continueRun && runtime.run?.kind === kind ? runtime.run.runId : randomUUID(),
			projectKey: runtime.projectKey,
			projectId,
			kind,
			root,
			abortController: new AbortController(),
			done: Promise.resolve(),
		};
		runtime.task = task;
		return task;
	}

	private isCurrentProjectAgentTask(task: ProjectAgentTask): boolean {
		return this.projectAgentRuntimes.get(task.projectKey)?.task === task;
	}

	private async startProjectAgentRun(
		task: ProjectAgentTask,
		event: AgentTraceEvent,
		source: RunLogSource,
		options: { continueExisting?: boolean; metadata?: RunLogMetadata; progress?: string } = {},
	): Promise<void> {
		const runtime = this.projectAgentRuntimes.get(task.projectKey);
		if (!runtime || runtime.task !== task) {
			return;
		}
		const now = new Date().toISOString();
		if (!options.continueExisting || !runtime.run || runtime.run.kind !== task.kind || runtime.run.source !== source) {
			runtime.run = {
				version: 1,
				runId: task.id,
				projectId: task.projectId,
				rootUri: task.root.uri.toString(),
				kind: task.kind,
				source,
				lifecycle: 'running',
				startedAt: now,
				updatedAt: now,
				progress: options.progress,
				sequence: 0,
				entries: [],
			};
		} else {
			runtime.run = {
				...runtime.run,
				lifecycle: 'running',
				updatedAt: now,
				completedAt: undefined,
				progress: options.progress,
				error: undefined,
			};
		}
		this.appendProjectAgentRunLog(task, event, options.metadata, false);
		await this.persistProjectAgentRun(runtime);
		this.scheduleLlmWikiDashboardRefresh();
	}

	private appendProjectAgentRunLog(
		task: ProjectAgentTask,
		event: AgentTraceEvent,
		metadata: RunLogMetadata = {},
		persist = true,
	): void {
		const runtime = this.projectAgentRuntimes.get(task.projectKey);
		const run = runtime?.run;
		if (!runtime || !run || run.runId !== task.id) {
			return;
		}
		const sequence = run.sequence + 1;
		run.sequence = sequence;
		run.updatedAt = new Date().toISOString();
		run.entries = [...run.entries, {
			id: `${run.runId}-${sequence}`,
			sequence,
			timestamp: run.updatedAt,
			source: metadata.source ?? run.source,
			stage: metadata.stage,
			agentId: metadata.agentId,
			parentAgentId: metadata.parentAgentId,
			role: metadata.role,
			segment: metadata.segment,
			fileUri: metadata.fileUri,
			relativePath: metadata.relativePath,
			fileIndex: metadata.fileIndex,
			fileCount: metadata.fileCount,
			kind: event.kind,
			title: event.title,
			summary: event.summary,
			round: event.round,
			status: event.status,
			spawnedAgentId: event.kind === 'tool_result' && event.summary.startsWith('spawn_agent') ? this.spawnedAgentId(event) : undefined,
			details: event.details,
		}];
		if (persist) {
			void this.persistProjectAgentRun(runtime).catch((error) => console.error('[Cli Diff Review] Failed to persist Agent run log', error));
		}
		this.scheduleLlmWikiDashboardRefresh();
	}

	private updateProjectAgentRun(task: ProjectAgentTask, progress?: string, error?: string): void {
		const runtime = this.projectAgentRuntimes.get(task.projectKey);
		if (!runtime?.run || runtime.run.runId !== task.id) {
			return;
		}
		runtime.run.progress = progress;
		runtime.run.error = error;
		runtime.run.updatedAt = new Date().toISOString();
		void this.persistProjectAgentRun(runtime).catch((persistError) => console.error('[Cli Diff Review] Failed to persist Agent progress', persistError));
		this.scheduleLlmWikiDashboardRefresh();
	}

	private async finishProjectAgentRun(
		task: ProjectAgentTask,
		lifecycle: ProjectAgentLifecycle,
		progress?: string,
		error?: string,
	): Promise<void> {
		const runtime = this.projectAgentRuntimes.get(task.projectKey);
		if (!runtime?.run || runtime.run.runId !== task.id) {
			return;
		}
		const now = new Date().toISOString();
		runtime.run = {
			...runtime.run,
			lifecycle,
			progress,
			error,
			updatedAt: now,
			completedAt: now,
		};
		await this.persistProjectAgentRun(runtime);
		this.scheduleLlmWikiDashboardRefresh();
	}

	private persistProjectAgentRun(runtime: ProjectAgentRuntime): Promise<void> {
		return runtime.run ? this.agentRunStore.save(runtime.run) : Promise.resolve();
	}

	private clearProjectAgentTask(task: ProjectAgentTask): void {
		const runtime = this.projectAgentRuntimes.get(task.projectKey);
		if (runtime?.task === task) {
			runtime.task = undefined;
		}
	}

	private async initializeLlmWiki(): Promise<void> {
		let task: ProjectAgentTask | undefined;
		try {
			if (this.showSelectedProjectBusyMessage()) {
				return;
			}
			const config = await this.llmConfigStore.runtimeConfig();
			if (!config) {
				await this.refreshLlmWikiDashboardState({ status: 'unconfigured', error: 'Configure an LLM provider first.' });
				vscode.window.showInformationMessage('Configure an LLM provider before initializing LLM Code Wiki.');
				return;
			}

			const projectRoot = await this.pickAgentProjectFolder(
				'Select a project for LLM Code Wiki initialization',
				async (project) => !this.projectAgentTask(project.rootUri)
					&& (await this.wikiInitializationService.state(project.rootUri))?.status !== 'ready',
			);
			const root = this.hasGitProjects() ? projectRoot : await this.pickWorkspaceFolder('Select a workspace folder for LLM Code Wiki');
			if (!root) {
				await this.refreshLlmWikiDashboardState();
				return;
			}
			const project = this.projectForRoot(root.uri);
			await this.activateAgentProject(project);
			this.wikiRootUri = root.uri;

			if ((await this.wikiInitializationService.state(root.uri))?.status === 'ready') {
				await this.refreshLlmWikiDashboardState({ status: 'initialized', progress: undefined, error: undefined });
				vscode.window.showInformationMessage('LLM Code Wiki is already initialized for this workspace.');
				return;
			}

			const continueExisting = await this.wikiInitializationService.hasPipelineCheckpoint(root.uri, 'initialize');
			const confirmation = await vscode.window.showWarningMessage(
				`${continueExisting ? 'Continue' : 'Initialize'} LLM Code Wiki for “${root.name}”?`,
				{
					modal: true,
					detail: 'Token usage varies with project size and complexity.',
				},
				continueExisting ? 'Continue' : 'Initialize',
			);
			if (confirmation !== (continueExisting ? 'Continue' : 'Initialize')) {
				return;
			}

			task = this.beginProjectAgentTask('initialize', root, project?.id, continueExisting);
			if (!task) {
				return;
			}
			await this.startProjectAgentRun(task, {
				kind: 'run_start',
				title: continueExisting ? 'Wiki initialization continued' : 'Wiki initialization started',
				summary: `${root.name} with ${config.model}`,
				status: 'running',
				details: [this.wikiRunJsonDetail('Operation', {
					operation: 'initialize',
					workspace: root.uri.fsPath,
					provider: config.provider,
					model: config.model,
				})],
			}, 'wiki', { continueExisting, progress: continueExisting ? 'Continuing Wiki initialization' : 'Preparing workspace' });
			await this.refreshLlmWikiDashboardState();
			task.done = this.runLlmWikiInitialization(task, config, createLlmClient(config));
			await task.done;
		} catch (error) {
			if (task) {
				this.clearProjectAgentTask(task);
				await this.finishProjectAgentRun(task, 'failed', undefined, error instanceof Error ? error.message : String(error)).catch(() => undefined);
			}
			this.showError(error);
			await this.refreshLlmWikiDashboardState({
				status: 'failed',
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async cancelLlmWikiInitialization(task = this.visibleProjectAgentTask()): Promise<void> {
		if (!task || task.kind !== 'initialize') {
			return;
		}

		const picked = await vscode.window.showQuickPick([
			{ label: 'Pause', description: 'Keep generated Code Wiki skill files', mode: 'pause' as const },
			{ label: 'Revert', description: 'Delete the workspace Code Wiki skill folder', mode: 'revert' as const },
		], { placeHolder: 'Cancel LLM Code Wiki initialization' });
		if (!picked) {
			return;
		}

		task.cancelMode = picked.mode;
		this.updateProjectAgentRun(task, picked.mode === 'revert' ? 'Cancelling and reverting' : 'Cancelling');
		task.abortController.abort();
		await task.done.catch(() => undefined);

		if (picked.mode === 'revert') {
			try {
				await this.wikiInitializationService.deleteWiki(task.root.uri);
				this.appendProjectAgentRunLog(task, {
					kind: 'run_error',
					title: 'Initialization reverted',
					summary: 'Deleted the generated Code Wiki skill folder',
					status: 'info',
					details: [this.wikiRunTextDetail('Result', 'Initialization reverted and the Code Wiki skill was removed.')],
				});
				await this.finishProjectAgentRun(task, 'cancelled', 'Initialization reverted.');
				await this.refreshLlmWikiDashboardState();
				vscode.window.showInformationMessage(`${task.root.name}: LLM Code Wiki initialization reverted.`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.showError(new Error(`${task.root.name}: ${message}`));
				this.appendProjectAgentRunLog(task, {
					kind: 'run_error',
					title: 'Revert failed',
					summary: message,
					status: 'error',
					details: [this.wikiRunTextDetail('Error', message)],
				});
				await this.finishProjectAgentRun(task, 'failed', undefined, message);
				await this.refreshLlmWikiDashboardState();
			}
			return;
		}

		await this.finishProjectAgentRun(task, 'paused', 'Initialization paused.');
		await this.refreshLlmWikiDashboardState();
	}

	private async runLlmWikiInitialization(task: ProjectAgentTask, config: LlmRuntimeConfig, client: LlmClient): Promise<void> {
		try {
			const result = await this.wikiInitializationService.initialize({
				root: task.root,
				config,
				client,
				concurrency: this.agentConcurrency(),
				signal: task.abortController.signal,
				onProgress: (progress) => {
					if (this.isCurrentProjectAgentTask(task)) {
						this.updateProjectAgentRun(task, progress.message);
					}
				},
				onTrace: (event, context) => {
					if (this.isCurrentProjectAgentTask(task)) {
						this.appendProjectAgentRunLog(task, event, this.wikiRunLogMetadata(context));
					}
				},
				onCheckpoint: () => {
					if (this.isCurrentProjectAgentTask(task)) {
						this.scheduleLlmWikiDashboardRefresh();
					}
				},
			});
			if (this.isCurrentProjectAgentTask(task)) {
				const progress = result.summary || `Generated ${result.fileCount} wiki files.`;
				this.appendProjectAgentRunLog(task, {
					kind: 'run_complete',
					title: 'Wiki initialized',
					summary: progress,
					status: 'success',
					details: [this.wikiRunJsonDetail('Result', result)],
				});
				await this.finishProjectAgentRun(task, 'completed', progress);
				vscode.window.showInformationMessage(`${task.root.name}: LLM Code Wiki initialized (${result.fileCount} files).`);
			}
		} catch (error) {
			if (isAbortError(error)) {
				if (this.isCurrentProjectAgentTask(task)) {
					const paused = task.cancelMode === 'pause';
					this.appendProjectAgentRunLog(task, {
						kind: 'run_error',
						title: paused ? 'Initialization paused' : 'Initialization cancelled',
						summary: paused ? 'Generated files were kept.' : 'Initialization was cancelled.',
						status: 'info',
						details: [this.wikiRunTextDetail('Result', paused ? 'Initialization paused.' : 'Initialization cancelled.')],
					});
					await this.finishProjectAgentRun(task, paused ? 'paused' : 'cancelled', paused ? 'Initialization paused.' : 'Initialization cancelled.');
				}
				return;
			}
			if (this.isCurrentProjectAgentTask(task)) {
				const message = error instanceof Error ? error.message : String(error);
				this.appendProjectAgentRunLog(task, {
					kind: 'run_error',
					title: 'Wiki initialization failed',
					summary: message,
					status: 'error',
					details: [this.wikiRunTextDetail('Error', message)],
				});
				await this.finishProjectAgentRun(task, 'failed', undefined, message);
			}
			this.showError(new Error(`${task.root.name}: ${error instanceof Error ? error.message : String(error)}`));
		} finally {
			this.clearProjectAgentTask(task);
			await this.refreshLlmWikiDashboardState();
		}
	}

	private async updateLlmWiki(): Promise<void> {
		let task: ProjectAgentTask | undefined;
		try {
			if (this.showSelectedProjectBusyMessage()) {
				return;
			}
			const config = await this.requireLlmConfig();
			const projectRoot = await this.pickAgentProjectFolder(
				'Select a project for LLM Code Wiki update',
				async (project) => {
					const session = this.projectSession(project);
					const state = await this.wikiInitializationService.state(project.rootUri);
					const hasCheckpoint = await this.wikiInitializationService.hasPipelineCheckpoint(project.rootUri, 'update');
					const interruptedUpdate = this.projectAgentRuntimes.get(this.agentProjectKey(project.rootUri))?.run;
					return !this.projectAgentTask(project.rootUri)
						&& (state?.status === 'ready' || hasCheckpoint || (interruptedUpdate?.kind === 'update' && interruptedUpdate.lifecycle === 'interrupted'))
						&& !sourcePendingFiles(session).length
						&& (hasCheckpoint || state?.status !== 'ready' || await this.wikiInitializationService.needsUpdate(reviewProjectFolder(project)));
				},
			);
			const root = this.hasGitProjects() ? projectRoot : await this.pickWorkspaceFolder('Select a workspace folder for LLM Code Wiki update');
			if (!config || !root) {
				return;
			}
			const project = this.projectForRoot(root.uri);
			await this.activateAgentProject(project);
			if (this.hasPendingReviewChangesForRoot(root.uri)) {
				vscode.window.showInformationMessage('Finish all pending review changes before updating LLM Code Wiki.');
				return;
			}
			const continueExisting = await this.wikiInitializationService.hasPipelineCheckpoint(root.uri, 'update');
			task = this.beginProjectAgentTask('update', root, project?.id, continueExisting);
			if (!task) {
				return;
			}
			this.wikiRootUri = root.uri;
			await this.startProjectAgentRun(task, {
				kind: 'run_start',
				title: continueExisting ? 'Wiki update continued' : 'Wiki update started',
				summary: `${root.name} with ${config.model}`,
				status: 'running',
				details: [this.wikiRunJsonDetail('Operation', {
					operation: 'update',
					workspace: root.uri.fsPath,
					provider: config.provider,
					model: config.model,
				})],
			}, 'wiki', {
				continueExisting,
				progress: continueExisting ? 'Continuing Wiki update' : 'Preparing Wiki update',
			});
			await this.refreshLlmWikiDashboardState();
			task.done = this.runLlmWikiUpdate(task, config, createLlmClient(config));
			await task.done;
		} catch (error) {
			if (task) {
				this.clearProjectAgentTask(task);
				await this.finishProjectAgentRun(task, 'failed', undefined, error instanceof Error ? error.message : String(error)).catch(() => undefined);
			}
			this.showError(error);
		}
	}

	private async runLlmWikiUpdate(task: ProjectAgentTask, config: LlmRuntimeConfig, client: LlmClient): Promise<void> {
		try {
			const result = await this.wikiInitializationService.update({
				root: task.root,
				config,
				client,
				concurrency: this.agentConcurrency(),
				signal: task.abortController.signal,
				onProgress: (progress) => this.isCurrentProjectAgentTask(task)
					&& this.updateProjectAgentRun(task, progress.message),
				onTrace: (event, context) => {
					if (this.isCurrentProjectAgentTask(task)) {
						this.appendProjectAgentRunLog(task, event, this.wikiRunLogMetadata(context));
					}
				},
				onCheckpoint: () => {
					if (this.isCurrentProjectAgentTask(task)) {
						this.scheduleLlmWikiDashboardRefresh();
					}
				},
			});
			if (this.isCurrentProjectAgentTask(task)) {
				this.appendProjectAgentRunLog(task, {
					kind: 'run_complete',
					title: 'Wiki update completed',
					summary: result.summary,
					status: 'success',
					details: [this.wikiRunJsonDetail('Result', result)],
				});
				await this.finishProjectAgentRun(task, 'completed', result.summary);
				vscode.window.showInformationMessage(`${task.root.name}: ${result.summary}`);
			}
		} catch (error) {
			if (isAbortError(error)) {
				if (this.isCurrentProjectAgentTask(task)) {
					this.appendProjectAgentRunLog(task, {
						kind: 'run_error',
						title: 'Wiki update cancelled',
						summary: 'Wiki update cancelled.',
						status: 'info',
						details: [this.wikiRunTextDetail('Result', 'Wiki update cancelled.')],
					});
					await this.finishProjectAgentRun(task, 'cancelled', 'Wiki update cancelled.');
				}
			} else {
				const message = error instanceof Error ? error.message : String(error);
				this.showError(new Error(`${task.root.name}: ${message}`));
				this.appendProjectAgentRunLog(task, {
					kind: 'run_error',
					title: 'Wiki update failed',
					summary: message,
					status: 'error',
					details: [this.wikiRunTextDetail('Error', message)],
				});
				await this.finishProjectAgentRun(task, 'failed', undefined, message);
			}
		} finally {
			this.clearProjectAgentTask(task);
			await this.refreshLlmWikiDashboardState();
		}
	}

	private async generateAiReview(mode?: 'regenerate'): Promise<void> {
		let task: ProjectAgentTask | undefined;
		try {
			if (this.showSelectedProjectBusyMessage()) {
				return;
			}
			const config = await this.requireLlmConfig();
			const project = await this.pickAgentProject(
				'Select a project for AI review',
				(candidate) => Promise.resolve(!this.projectAgentTask(candidate.rootUri)
					&& sourcePendingFiles(this.projectSession(candidate)).length > 0),
			);
			if (this.hasGitProjects() && !project) {
				vscode.window.showInformationMessage('No pending source chunks to review in the selected project.');
				return;
			}
			const session = project ? this.projectSession(project) : this.visibleReviewSession();
			const files = session ? sourcePendingFiles(session) : [];
			if (!config || !session || files.length === 0) {
				vscode.window.showInformationMessage('No pending source chunks to review.');
				return;
			}
			const root = project
				? reviewProjectFolder(project)
				: vscode.workspace.getWorkspaceFolder(session.rootUri)
					?? vscode.workspace.workspaceFolders?.find((folder) => uriKey(folder.uri) === uriKey(session.rootUri));
			if (!root) {
				throw new Error('The active review workspace is not available.');
			}
			await this.activateAgentProject(project);
			const includeWikiTools = (await this.wikiInitializationService.state(root.uri))?.status === 'ready';
			const language = vscode.workspace.getConfiguration('cliDiff').get<AiReviewLanguage>('aiReviewLanguage', 'zh-CN');
			const maxRounds = this.aiReviewMaxRounds();
			const storedReview = this.aiReviewStore.load(session);
			if (mode === 'regenerate' && storedReview?.status === 'partial') {
				const confirmed = await vscode.window.showWarningMessage(
					'Regenerate AI review?',
					{
						modal: true,
						detail: 'Current AI review progress and partial results will be discarded.',
					},
					'Regenerate',
				);
				if (confirmed !== 'Regenerate') {
					return;
				}
			}
			const existingReview = mode === 'regenerate'
				? undefined
				: storedReview?.status === 'partial' ? await this.aiReviewStore.hydrate(storedReview) : undefined;
			task = this.beginProjectAgentTask('review', root, project?.id, Boolean(existingReview));
			if (!task) {
				return;
			}
			if (!existingReview) {
				await this.aiReviewStore.clear(session.rootUri);
			}
			const startEvent: AgentTraceEvent = {
				kind: 'run_start',
				title: existingReview ? 'AI review continued' : 'AI review started',
				summary: `${files.length} file${files.length === 1 ? '' : 's'} with ${config.model}`,
				status: 'running',
				details: [this.wikiRunJsonDetail('Operation', {
					operation: 'review',
					workspace: root.uri.fsPath,
					provider: config.provider,
					model: config.model,
					language,
					maxRounds: maxRounds === 'unlimited' ? 'unlimited' : maxRounds,
					mode: existingReview ? 'continue' : mode === 'regenerate' ? 'regenerate' : 'generate',
					wikiContext: includeWikiTools ? 'enabled' : 'disabled',
					completedFiles: existingReview?.completedFiles.length ?? 0,
					files: files.map((file) => ({ uri: file.uri.toString(), relativePath: file.relativePath, chunks: file.hunks.length })),
				})],
			};
			if (existingReview) {
				await this.startProjectAgentRun(task, startEvent, 'review', {
					continueExisting: true,
					metadata: {
						source: 'review',
						stage: 'main',
						agentId: 'main',
					},
					progress: 'Continuing AI review',
				});
			} else {
				await this.startProjectAgentRun(task, startEvent, 'review', { progress: 'Preparing AI review' });
			}
			this.updateProjectAgentRun(task, existingReview ? 'Continuing AI review' : 'Preparing AI review');
			await this.refreshLlmWikiDashboardState();
			task.done = this.runAiReview(task, config, createLlmClient(config), session, language, maxRounds, includeWikiTools, existingReview);
			await task.done;
		} catch (error) {
			if (task) {
				this.clearProjectAgentTask(task);
				await this.finishProjectAgentRun(task, 'failed', undefined, error instanceof Error ? error.message : String(error)).catch(() => undefined);
			}
			this.showError(error);
		}
	}

	private async aiReviewKnowledgeFreshness(task: ProjectAgentTask, includeWikiTools: boolean): Promise<WikiFreshnessAssessment> {
		if (includeWikiTools) {
			return this.wikiInitializationService.assessFreshness(task.root, task.abortController.signal);
		}
		return {
			status: 'unknown',
			checkedAt: new Date().toISOString(),
			addedSourcePaths: [],
			modifiedSourcePaths: [],
			deletedSourcePaths: [],
			totalChangedSourceCount: 0,
			reason: 'Wiki is not initialized for this review root.',
		};
	}

	private async runAiReview(
		task: ProjectAgentTask,
		config: LlmRuntimeConfig,
		client: LlmClient,
		session: ReviewSession,
		language: AiReviewLanguage,
		maxRounds: number | 'unlimited',
		includeWikiTools: boolean,
		existingReview?: StoredAiReview,
	): Promise<void> {
		try {
			const knowledgeFreshness = await this.aiReviewKnowledgeFreshness(task, includeWikiTools);
			const result = await this.codeReviewAgentService.review({
				session,
				root: task.root,
				config,
				client,
				language,
				existingReview,
				includeWikiTools,
                knowledgeFreshness,
                totalBudgetTokens: vscode.workspace.getConfiguration('cliDiff', task.root.uri).get<number>('aiReviewTotalBudgetTokens', 1000000),
                childConcurrency: vscode.workspace.getConfiguration('cliDiff', task.root.uri).get<number>('aiReviewChildConcurrency', 5),
                autoCompress: vscode.workspace.getConfiguration('cliDiff', task.root.uri).get<boolean>('aiReviewAutoCompress', false),
                changeNotificationLimit: vscode.workspace.getConfiguration('cliDiff', task.root.uri).get<number>('aiReviewChangeNotificationLimit', 5),
                refreshSession: async () => {
                 await this.requestGitSessionRefresh();
                 const current = this.activeSession;
                 if (!current) { throw new Error('Review session closed'); }
                 return { ...session, files: new Map([...current.files].filter(([, file]) => task.projectId ? file.projectId === task.projectId : file.uri.fsPath.startsWith(task.root.uri.fsPath + path.sep))) };
                },
                maxRounds,
				signal: task.abortController.signal,
				onProgress: (message) => this.isCurrentProjectAgentTask(task)
					&& this.updateProjectAgentRun(task, message),
				onTrace: (event, context) => {
					if (this.isCurrentProjectAgentTask(task)) {
						this.appendProjectAgentRunLog(task, event, this.reviewRunLogMetadata(context));
					}
				},
				onFileComplete: async (review) => {
					if (this.isCurrentProjectAgentTask(task)) {
						await this.aiReviewStore.save(session, review);
						this.treeProvider.refresh();
						this.updateProjectAgentRun(task, `AI review progress: ${review.completedFiles.length} file${review.completedFiles.length === 1 ? '' : 's'} completed.`);
					}
				},
				onCheckpoint: (review) => {
					const runtime = this.projectAgentRuntimes.get(task.projectKey);
					if (!runtime) {
						return Promise.resolve();
					}
					runtime.checkpointSaveQueue = runtime.checkpointSaveQueue.then(async () => {
						if (this.isCurrentProjectAgentTask(task)) {
							await this.aiReviewStore.save(session, review);
							this.scheduleLlmWikiDashboardRefresh();
						}
					});
					return runtime.checkpointSaveQueue;
				},
			});
			if (this.isCurrentProjectAgentTask(task)) {
				await this.aiReviewStore.save(session, result);
				this.treeProvider.refresh();
				this.appendProjectAgentRunLog(task, {
					kind: 'run_complete',
					title: 'AI review completed',
					summary: `${result.findings.length} finding${result.findings.length === 1 ? '' : 's'} accepted`,
					status: 'success',
					details: [this.wikiRunJsonDetail('Result', result)],
				});
				await this.finishProjectAgentRun(task, result.status === 'complete' ? 'completed' : 'failed', result.summary ?? `AI review completed (${result.findings.length} findings).`, result.status === 'partial' ? 'Partial review; continue to resolve remaining scope.' : undefined);
				vscode.window.showInformationMessage(`${task.root.name}: AI review completed (${result.findings.length} findings).`);
			}
		} catch (error) {
			if (isAbortError(error)) {
				if (this.isCurrentProjectAgentTask(task)) {
					this.appendProjectAgentRunLog(task, {
						kind: 'run_error',
						title: 'AI review cancelled',
						summary: 'AI review cancelled.',
						status: 'info',
						details: [this.wikiRunTextDetail('Result', 'AI review cancelled.')],
					});
					await this.finishProjectAgentRun(task, 'cancelled', 'AI review cancelled.');
				}
			} else {
				if (error instanceof AiReviewPartialError) {
					await this.aiReviewStore.save(session, error.review);
					this.treeProvider.refresh();
				}
				const message = error instanceof Error ? error.message : String(error);
				this.showError(new Error(`${task.root.name}: ${message}`));
				this.appendProjectAgentRunLog(task, {
					kind: 'run_error',
					title: 'AI review failed',
					summary: message,
					status: 'error',
					details: [this.wikiRunTextDetail('Error', message)],
				});
				await this.finishProjectAgentRun(task, 'failed', undefined, message);
			}
		} finally {
			this.clearProjectAgentTask(task);
			await this.refreshLlmWikiDashboardState();
		}
	}

	private async cancelCurrentAgent(): Promise<void> {
		const task = await this.pickRunningProjectAgentTask();
		if (!task) {
			return;
		}
		if (task.kind === 'initialize') {
			await this.cancelLlmWikiInitialization();
			return;
		}
		this.updateProjectAgentRun(task, 'Cancelling Agent');
		task.abortController.abort();
		await task.done.catch(() => undefined);
		await this.refreshLlmWikiDashboardState();
	}

	private async openAiReviewFinding(uriString: string, hunkId: string): Promise<void> {
		const file = this.activeSession?.files.get(uriKey(vscode.Uri.parse(uriString)));
		if (!file) {
			return;
		}
		const matchesIdentity = (candidate: ReviewHunk): boolean => (
			candidate.id === hunkId
			|| candidate.sourceHunkId === hunkId
			|| candidate.reviewItemId === hunkId
		);
		const hunk = file.hunks.find(matchesIdentity);
		const reviewed = hunk ? undefined : [...file.acceptedHunks, ...file.rejectedHunks]
			.find((candidate) => matchesIdentity(candidate) || candidate.id.endsWith(`-${hunkId}`));
		await this.openReviewPresentation(file.uri, {
			line: hunk?.newStart ?? reviewed?.displayStart ?? 0,
			column: 0,
		});
	}

	private async applyAiSuggestion(uriString: string, hunkId: string, suggestionId: string): Promise<void> {
		await this.enqueueFileOperation(this.operationUri(uriString), () => this.applyAiSuggestionCore(uriString, hunkId, suggestionId));
	}

	private async applyAiSuggestionCore(uriString: string, hunkId: string, suggestionId: string): Promise<void> {
		try {
			if (!this.activeSession) {
				return;
			}
			const file = this.resolveFile(uriString);
			const reviewSession = file ? this.sessionForFile(file) : undefined;
			const storedReview = this.aiReviewStore.load(reviewSession);
			const suggestion = storedReview?.suggestions.find((item) => item.id === suggestionId && item.uri === uriString);
			const hunk = file?.hunks.find((item) => item.id === hunkId);
			if (!file || !suggestion || !hunk) {
				vscode.window.showInformationMessage('No AI suggestion selected.');
				return;
			}
			if (hunk.kind === 'delete') {
				vscode.window.showInformationMessage('AI code suggestions are not available for deleted chunks.');
				return;
			}
			if (!this.ensureFileCleanForReviewMutation(file)) {
				return;
			}
			const current = await this.readCurrentText(file.uri);
			if (!current.exists || !this.originalHunkSideMatches(current.text, hunk, 'new', hunk.newStart)) {
				await this.refreshFile(file.uri, { reconcileExternalChanges: false });
				return;
			}

			if (suggestion.expectedFileHash && reviewContentHash(current.text) !== suggestion.expectedFileHash) { throw new Error('代码已变化，此建议已过期；请继续审阅。'); }
			const replacementText = normalizeAiSuggestionReplacementText(suggestion.replacementText, hunk);
			const currentText = replaceLineBlock(current.text, hunk.newStart, hunk.newLines, replacementText);
			const otherHunks = file.hunks.filter((candidate) => candidate.id !== hunk.id).map((candidate) => ({ ...candidate }));
			await this.writeCurrentFileText(file.uri, currentText);
			await this.refreshGitReviewFile(file.uri, { refreshUi: false });
			let refreshedFile = this.resolveFile(uriString);
			if (!refreshedFile) {
				const actual = await this.readCurrentText(file.uri, { preferDisk: true });
				const expected = replaceLineBlock(current.text, hunk.newStart, hunk.newLines, hunk.oldText);
				if (actual.exists && actual.text === expected) {
					refreshedFile = this.createResolvedSuggestionFileState(file, actual.text);
					this.activeSession.files.set(uriKey(file.uri), refreshedFile);
				}
			}
			const appliedResolution: SuggestionMappingResult = refreshedFile
				? this.findRegeneratedSuggestionHunks(refreshedFile, hunk, otherHunks, current.text)
				: {
					ok: false,
					reason: 'no-candidate',
					diagnostics: this.emptySuggestionMappingDiagnostics(hunk, otherHunks.length),
				};
			if (!refreshedFile || !appliedResolution.ok) {
				await this.writeCurrentFileText(file.uri, current.text);
				await this.refreshGitReviewFile(file.uri);
				console.error('[Cli Diff Review] AI suggestion mapping failed', {
					relativePath: file.relativePath,
					suggestionId,
					hunkId,
					reason: appliedResolution.ok ? 'no-candidate' : appliedResolution.reason,
					diagnostics: appliedResolution.ok
						? this.emptySuggestionMappingDiagnostics(hunk, otherHunks.length)
						: appliedResolution.diagnostics,
				});
				throw new Error('The AI suggestion overlaps other working-tree changes and could not be isolated safely. The file was restored without applying it.');
			}
			const appliedMembers = appliedResolution.members;
			const reviewItemId = hunk.reviewItemId ?? hunk.sourceHunkId ?? hunk.id;
			const resolvedToIndex = appliedResolution.effect === 'resolved-to-index';
			const appliedHunk = resolvedToIndex
				? this.createResolvedSuggestionHunk(hunk, replacementText, reviewItemId)
				: this.createLogicalSuggestionHunk(refreshedFile, hunk, appliedMembers, reviewItemId);
			if (!resolvedToIndex) {
				const memberIds = new Set(appliedMembers.map((member) => member.id));
				refreshedFile.hunks = [
					...refreshedFile.hunks.filter((candidate) => !memberIds.has(candidate.id)),
					appliedHunk,
				].sort((left, right) => left.newStart - right.newStart || left.id.localeCompare(right.id));
			}
			refreshedFile.appliedAiSuggestions = [
				...refreshedFile.appliedAiSuggestions.filter((item) => item.suggestionId !== suggestionId),
				{
					suggestionId,
					sourceHunkId: hunkId,
					currentHunkId: appliedHunk.id,
					reviewItemId,
					originalHunk: { ...hunk },
					replacementText,
					appliedHunk: { ...appliedHunk },
					appliedHunks: appliedMembers.map((member) => ({ ...member })),
					appliedText: appliedHunk.newText,
					appliedWorkingText: refreshedFile.newText,
					undoWorkingText: appliedResolution.undoText,
					resolvedToIndex,
					appliedAt: Date.now(),
				},
			];
			this.touchFileRevision(refreshedFile);
			await this.saveAiReviewWithCurrentSignature(storedReview, this.sessionForFile(refreshedFile));
			this.refreshUi();
			await this.refreshLlmWikiDashboardState();
		} catch (error) {
			this.showError(error);
		}
	}

	private async undoAiSuggestion(uriString: string, hunkId: string, suggestionId: string): Promise<void> {
		await this.enqueueFileOperation(this.operationUri(uriString), () => this.undoAiSuggestionCore(uriString, hunkId, suggestionId));
	}

	private async undoAiSuggestionCore(uriString: string, hunkId: string, suggestionId: string): Promise<void> {
		try {
			if (!this.activeSession) {
				return;
			}
			const file = this.resolveFile(uriString);
			const applied = file?.appliedAiSuggestions.find((item) => item.suggestionId === suggestionId && item.currentHunkId === hunkId);
			if (!file || !applied) {
				vscode.window.showInformationMessage('No applied AI suggestion selected.');
				return;
			}
			if (!this.ensureFileCleanForReviewMutation(file)) {
				return;
			}
			const reviewSession = this.sessionForFile(file);
			const storedReview = this.aiReviewStore.load(reviewSession);
			await this.restoreAppliedSuggestionText(file, applied);
			await this.refreshGitReviewFile(file.uri);
			const restoredFile = this.resolveFile(uriString);
			await this.saveAiReviewWithCurrentSignature(storedReview, restoredFile ? this.sessionForFile(restoredFile) : reviewSession);
			this.refreshReviewPresentation(file.uri);
			await this.refreshLlmWikiDashboardState();
		} catch (error) {
			this.showError(error);
		}
	}

	private async openWikiIndex(): Promise<void> {
		const projectRoot = await this.pickAgentProjectFolder(
			'Select a project Wiki to open',
			async (project) => this.wikiInitializationService.wikiExists(project.rootUri),
		);
		const root = this.hasGitProjects() ? projectRoot : this.dashboardWikiRootFolder();
		if (!root) {
			vscode.window.showInformationMessage('Open a workspace folder before opening the Wiki.');
			return;
		}

		const indexUri = vscode.Uri.joinPath(root.uri, ...wikiReferencesPath.split('/'), 'index.md');
		try {
			await vscode.workspace.fs.stat(indexUri);
		} catch {
			vscode.window.showInformationMessage('Initialize LLM Code Wiki before opening the Wiki home page.');
			return;
		}
		await vscode.commands.executeCommand('vscode.open', indexUri);
	}

	private visibleReviewSession(): ReviewSession | undefined {
		const session = this.activeSession;
		const project = currentReviewProject(session);
		return session && project ? projectReviewSession(session, project) : session;
	}

	private dashboardStoredAiReview(): StoredAiReview | undefined {
		const session = this.activeSession;
		if (!session) {
			return undefined;
		}
		if (session.mode !== 'git' || session.trackingTarget?.kind !== 'aggregate' || !session.projects?.length) {
			return this.aiReviewStore.load(this.visibleReviewSession());
		}
		const reviews = session.projects
			.map((project) => this.aiReviewStore.load(projectReviewSession(session, project)))
			.filter((review): review is StoredAiReview => Boolean(review));
		if (reviews.length === 0) {
			return undefined;
		}
		const freshness = reviews
			.map((review) => review.knowledgeFreshness)
			.filter((value): value is NonNullable<StoredAiReview['knowledgeFreshness']> => Boolean(value));
		const knowledgeFreshness = freshness.find((value) => value.status === 'stale')
			?? freshness.find((value) => value.status === 'unknown')
			?? freshness[0];
		return {
			signature: reviews.map((review) => review.signature).join('\n'),
			findings: reviews.flatMap((review) => review.findings),
			suggestions: reviews.flatMap((review) => review.suggestions),
			fileResults: reviews.flatMap((review) => review.fileResults),
			generatedAt: reviews.map((review) => review.generatedAt).sort().at(-1) ?? new Date(0).toISOString(),
			status: reviews.every((review) => review.status === 'complete') ? 'complete' : 'partial',
			completedFiles: reviews.flatMap((review) => review.completedFiles),
			summary: reviews.map((review) => review.summary).filter(Boolean).join('\n') || undefined,
			knowledgeFreshness,
			knowledgeClaims: reviews.flatMap((review) => review.knowledgeClaims ?? []),

			failedFile: reviews.find((review) => review.failedFile)?.failedFile,
			error: reviews.find((review) => review.error)?.error,
		};
	}

	private projectSession(project: ReviewProject): ReviewSession | undefined {
		return this.activeSession ? projectReviewSession(this.activeSession, project) : undefined;
	}

	private projectForRoot(rootUri: vscode.Uri): ReviewProject | undefined {
		return this.activeSession?.projects?.find((project) => this.agentProjectKey(project.rootUri) === this.agentProjectKey(rootUri));
	}

	private showSelectedProjectBusyMessage(): boolean {
		const project = currentReviewProject(this.activeSession);
		if (!project || !this.projectAgentTask(project.rootUri)) {
			return false;
		}
		vscode.window.showInformationMessage(`${project.name} already has an Agent task running.`);
		return true;
	}

	private async activateAgentProject(project: ReviewProject | undefined): Promise<void> {
		const session = this.activeSession;
		if (!project || !session || !hasAggregateReviewTarget(session)) {
			return;
		}
		session.trackingTarget = { kind: 'project', projectId: project.id };
		await this.context.workspaceState.update(trackingTargetStorageKey(session.rootUri), project.id);
		if (this.currentReviewUri && !visibleReviewFiles(session).some((file) => uriKey(file.uri) === uriKey(this.currentReviewUri as vscode.Uri))) {
			this.currentReviewUri = undefined;
		}
		await this.refreshLlmWikiDashboardState();
		this.refreshUi();
	}

	private visibleProjectAgentTask(): ProjectAgentTask | undefined {
		const rootUri = this.dashboardWikiRootUri();
		return rootUri ? this.projectAgentTask(rootUri) : undefined;
	}

	private async pickRunningProjectAgentTask(): Promise<ProjectAgentTask | undefined> {
		const visible = this.visibleProjectAgentTask();
		if (visible) {
			return visible;
		}
		const tasks = [...this.projectAgentRuntimes.values()]
			.map((runtime) => runtime.task)
			.filter((task): task is ProjectAgentTask => Boolean(task));
		if (tasks.length === 0) {
			return undefined;
		}
		if (tasks.length === 1) {
			return tasks[0];
		}
		const picked = await vscode.window.showQuickPick(tasks.map((task) => ({
			label: task.root.name,
			description: task.kind === 'review' ? 'AI Review' : task.kind === 'update' ? 'Wiki Update' : 'Wiki Initialization',
			task,
		})), { placeHolder: 'Select the project Agent task to cancel' });
		return picked?.task;
	}

	private async loadProjectAgentRuns(projects: ReviewProject[]): Promise<void> {
		await Promise.all(projects.map(async (project) => {
			const runtime = this.projectAgentRuntime(project.rootUri, project.id);
			if (runtime.loaded || runtime.task) {
				return;
			}
			runtime.loaded = true;
			const stored = await this.agentRunStore.load(project.rootUri);
			if (!stored) {
				return;
			}
			runtime.run = stored;
			if (stored.lifecycle !== 'running') {
				return;
			}
			const now = new Date().toISOString();
			const sequence = stored.sequence + 1;
			runtime.run = {
				...stored,
				lifecycle: 'interrupted',
				updatedAt: now,
				completedAt: now,
				progress: stored.kind === 'review'
					? 'AI review was interrupted. Continue from the latest compatible checkpoint.'
					: stored.kind === 'update' ? 'Wiki update was interrupted. Retry the update.' : 'Wiki initialization was interrupted.',
				error: undefined,
				sequence,
				entries: [...stored.entries, {
					id: `${stored.runId}-${sequence}`,
					sequence,
					timestamp: now,
					source: stored.source,
					kind: 'run_error',
					title: 'Agent run interrupted',
					summary: 'The Extension Host stopped before this Agent run completed.',
					status: 'info',
					details: [this.wikiRunTextDetail('Result', 'The previous Agent process is no longer running. No task was restarted automatically.')],
				}],
			};
			await this.persistProjectAgentRun(runtime);
			if (stored.kind === 'update') {
				await this.wikiInitializationService.recoverInterruptedUpdate(project.rootUri);
			} else if (stored.kind === 'initialize') {
				await this.wikiInitializationService.recoverInterruptedInitialization(project.rootUri);
			}
		}));
	}

	private async interruptRemovedProjectAgents(previous: ReviewProject[], current: ReviewProject[]): Promise<void> {
		const currentKeys = new Set(current.map((project) => this.agentProjectKey(project.rootUri)));
		for (const project of previous) {
			const projectKey = this.agentProjectKey(project.rootUri);
			if (currentKeys.has(projectKey)) {
				continue;
			}
			const runtime = this.projectAgentRuntimes.get(projectKey);
			const task = runtime?.task;
			if (!runtime || !task) {
				continue;
			}
			task.abortController.abort();
			this.appendProjectAgentRunLog(task, {
				kind: 'run_error',
				title: 'Project no longer available',
				summary: 'The project disappeared from the active Git session.',
				status: 'error',
				details: [this.wikiRunTextDetail('Result', 'Only this project Agent task was interrupted.')],
			});
			await this.finishProjectAgentRun(task, 'interrupted', undefined, 'Project no longer available.');
			this.clearProjectAgentTask(task);
		}
	}

	private async pickAgentProject(
		placeHolder: string,
		isEligible: (project: ReviewProject) => Promise<boolean>,
	): Promise<ReviewProject | undefined> {
		const session = this.activeSession;
		if (!session || session.mode !== 'git' || !session.projects?.length) {
			return undefined;
		}
		const selected = currentReviewProject(session);
		if (selected) {
			if (await isEligible(selected)) {
				return selected;
			}
			vscode.window.showInformationMessage(`${selected.name} is not currently eligible for this action.`);
			return undefined;
		}
		const eligible: ReviewProject[] = [];
		for (const project of session.projects) {
			if (await isEligible(project)) {
				eligible.push(project);
			}
		}
		if (eligible.length === 0) {
			vscode.window.showInformationMessage('No project is currently eligible for this action.');
			return undefined;
		}
		const picked = await vscode.window.showQuickPick(eligible.map((project) => ({
			label: project.name,
			description: project.rootUri.fsPath,
			project,
		})), { placeHolder });
		return picked?.project;
	}

	private async pickAgentProjectFolder(
		placeHolder: string,
		isEligible: (project: ReviewProject) => Promise<boolean>,
	): Promise<vscode.WorkspaceFolder | undefined> {
		const project = await this.pickAgentProject(placeHolder, isEligible);
		return project ? reviewProjectFolder(project) : undefined;
	}

	private hasGitProjects(): boolean {
		return this.activeSession?.mode === 'git' && Boolean(this.activeSession.projects?.length);
	}

	private hasPendingReviewChangesForRoot(rootUri: vscode.Uri): boolean {
		const project = this.activeSession?.projects?.find((candidate) => uriKey(candidate.rootUri) === uriKey(rootUri));
		return project ? sourcePendingFiles(this.projectSession(project)).length > 0 : this.hasPendingReviewChanges();
	}

	private async requireLlmConfig(): Promise<LlmRuntimeConfig | undefined> {
		const config = await this.llmConfigStore.runtimeConfig();
		if (!config) {
			await this.refreshLlmWikiDashboardState({ status: 'unconfigured', error: 'Configure an LLM provider first.' });
			vscode.window.showInformationMessage('Configure an LLM provider first.');
		}
		return config;
	}


	private agentConcurrency(): number {
		const configured = vscode.workspace.getConfiguration('cliDiff').get<number>('agentConcurrency', 3);
		return typeof configured === 'number' && Number.isFinite(configured)
			? Math.max(0, Math.floor(configured))
			: 3;
	}
	private aiReviewMaxRounds(): number | 'unlimited' {
		const configured = vscode.workspace.getConfiguration('cliDiff').get<number>('aiReviewMaxRounds', 32);
		if (configured === 0) {
			return 'unlimited';
		}
		return Math.max(1, Math.floor(configured));
	}

	private hasPendingReviewChanges(): boolean {
		return visibleReviewFiles(this.activeSession).some((file) => file.hunks.length > 0);
	}

	private gitWorkspaceFolderForReviewFile(file: ReviewFileState): vscode.WorkspaceFolder | undefined {
		const project = file.projectId
			? this.activeSession?.projects?.find((candidate) => candidate.id === file.projectId)
			: this.gitProjectForUri(file.uri);
		if (project) {
			return reviewProjectFolder(project);
		}
		return this.activeGitWorkspaceFolder();
	}

	private requireGitFolder(file: ReviewFileState): vscode.WorkspaceFolder {
		const folder = this.gitWorkspaceFolderForReviewFile(file);
		if (!folder) {
			throw new Error(`No Git repository found for ${file.relativePath}.`);
		}
		return folder;
	}

	private requireGitProject(file: ReviewFileState): ReviewProject {
		const project = this.activeSession?.projects?.find((candidate) => candidate.id === file.projectId)
			?? this.gitProjectForUri(file.uri);
		if (!project) {
			throw new Error(`No Git project found for ${file.relativePath}.`);
		}
		return project;
	}

	private async ensureGitHeadUnchanged(file: ReviewFileState, folder: vscode.WorkspaceFolder): Promise<string> {
		const project = this.requireGitProject(file);
		const currentHead = await this.gitService.headOid(folder);
		const expectedHead = file.headOid ?? project.headOid;
		if (expectedHead !== undefined && expectedHead !== currentHead) {
			await this.refreshGitSessionFiles({ source: 'gitIndexChanged' });
			throw new Error('Git history changed. The review session was rebuilt; select the change again.');
		}
		project.headOid = currentHead;
		return currentHead;
	}

	private requireGitHunk(hunk: ReviewHunk): GitReviewHunk {
		if (!hunk.patch || !hunk.fingerprint || !hunk.projectId) {
			throw new Error('The selected change is no longer backed by a current Git patch. Refresh and try again.');
		}
		return hunk as GitReviewHunk;
	}

	private async refreshGitSessionFiles(request: GitSessionRefreshRequest): Promise<void> {
		if (request.source === 'manual') {
			await this.requestGitSessionRefresh();
			await this.flushReviewedChangesToIndex();
		}
		await this.requestGitSessionRefresh();
	}

	private async requestGitSessionRefresh(): Promise<void> {
		this.gitRefreshRequested = true;
		while (this.gitRefreshRequested || this.gitRefreshInFlight) {
			if (!this.gitRefreshInFlight) {
				this.gitRefreshInFlight = this.runGitRefreshLoop();
			}
			const activeRefresh = this.gitRefreshInFlight;
			try {
				await activeRefresh;
			} finally {
				if (this.gitRefreshInFlight === activeRefresh) {
					this.gitRefreshInFlight = undefined;
				}
			}
		}
	}

	private async flushReviewedChangesToIndex(): Promise<void> {
		const session = this.activeSession;
		if (!session || session.mode !== 'git') {
			return;
		}
		const failures: string[] = [];
		for (const project of session.projects ?? []) {
			const projectFiles = [...session.files.values()].filter((file) => file.projectId === project.id);
			const files = projectFiles.filter((file) => file.acceptedHunks.length > 0 || file.rejectedHunks.length > 0);
			const resolvedFiles = projectFiles.filter((file) => file.appliedAiSuggestions.some((suggestion) => suggestion.resolvedToIndex));
			if (files.length === 0) {
				if (resolvedFiles.some((file) => this.isOpenDocumentDirty(file.uri))) {
					failures.push(`${project.name}: save or revert reviewed files before Refresh.`);
					continue;
				}
				this.clearResolvedSuggestionRecords(projectFiles);
				continue;
			}
			if ([...files, ...resolvedFiles].some((file) => this.isOpenDocumentDirty(file.uri))) {
				failures.push(`${project.name}: save or revert reviewed files before Refresh.`);
				continue;
			}
			const folder = reviewProjectFolder(project);
			try {
				const headOid = await this.gitService.headOid(folder);
				if (project.headOid !== undefined && project.headOid !== headOid) {
					throw new Error('Git history changed; the review session must be rebuilt.');
				}
				const accepted = files.flatMap((file) => file.acceptedHunks
					.filter((hunk) => hunk.operable !== false)
					.map((hunk) => this.requireGitHunk(hunk)));
				const acceptedIds = files.flatMap((file) => file.acceptedHunks.map((hunk) => hunk.id));
				if (accepted.length > 0) {
					const patch = this.gitService.combinePatches(accepted);
					await this.gitService.applyPatch(folder, patch, { cached: true, check: true });
					await this.gitReviewJournal.setAcceptState(project, headOid, acceptedIds, 'flushing');
					try {
						await this.gitService.applyPatch(folder, patch, { cached: true });
					} catch (error) {
						await this.gitReviewJournal.setAcceptState(project, headOid, acceptedIds, 'reviewed');
						throw error;
					}
				}
				await this.gitReviewJournal.clear(project, headOid);
				this.clearResolvedSuggestionRecords(projectFiles);
			} catch (error) {
				failures.push(`${project.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (failures.length > 0) {
			void vscode.window.showWarningMessage(`Some reviewed changes could not be staged:\n${failures.join('\n')}`);
		}
	}

	private clearResolvedSuggestionRecords(files: ReviewFileState[]): void {
		for (const file of files) {
			file.appliedAiSuggestions = file.appliedAiSuggestions.filter((suggestion) => !suggestion.resolvedToIndex);
		}
	}

	private async runGitRefreshLoop(): Promise<void> {
		while (this.gitRefreshRequested) {
			this.gitRefreshRequested = false;
			await this.refreshGitSessionFilesOnce();
		}
	}

	private async refreshGitSessionFilesOnce(): Promise<void> {
		if (!this.activeSession || this.activeSession.mode !== 'git') {
			return;
		}

		const workspaceRoot = this.activeGitWorkspaceFolder();
		if (!workspaceRoot) {
			return;
		}

		const previousFiles = this.activeSession.files;
		const previousProjects = this.activeSession.projects ?? [];
		const projects = await this.gitService.discoverProjects(workspaceRoot);
		await this.validateBranchExtractions(projects);
		await this.interruptRemovedProjectAgents(previousProjects, projects);
		await this.loadProjectAgentRuns(projects);
		const pairs = await this.createProjectFilePairs(projects);
		const nextFiles = new Map<string, ReviewFileState>();
		for (const pair of pairs) {
			const key = uriKey(pair.uri);
			const file = this.createFileState(pair);
			if (file.hunks.length > 0 || file.acceptedHunks.length > 0 || file.skippedReason) {
				const previous = previousFiles.get(key);
				if (previous) {
					file.revision = previous.revision;
				}
				nextFiles.set(key, file);
			}
		}
		await this.attachRejectedJournals(nextFiles, projects);
		for (const [key, previous] of previousFiles) {
			if (nextFiles.has(key) || !previous.appliedAiSuggestions.some((suggestion) => suggestion.resolvedToIndex)) {
				continue;
			}
			const project = projects.find((candidate) => candidate.id === previous.projectId);
			const retained = project ? await this.retainResolvedSuggestionFile(previous, project) : undefined;
			if (retained) {
				nextFiles.set(key, retained);
			}
		}
		for (const [key, file] of nextFiles) {
			const previous = previousFiles.get(key);
			if (previous) {
				this.restoreStableReviewItemIdentities(file, previous);
				this.restoreAppliedSuggestionGroups(file, previous);
				this.restoreAcceptedAiSuggestions(file, previous);
			}
			if (previous && gitReviewFileStateFingerprint(previous) !== gitReviewFileStateFingerprint(file)) {
				file.revision = previous.revision + 1;
			}
		}
		this.activeSession.files = nextFiles;
		this.activeSession.projects = projects;
		await this.ensureTrackingTargetAvailable();
		this.refreshUi();
	}

	private async refreshGitReviewFile(uri: vscode.Uri, options: { refreshUi?: boolean } = {}): Promise<void> {
		const session = this.activeSession;
		if (!session || session.mode !== 'git' || this.isOpenDocumentDirty(uri)) {
			return;
		}
		const project = this.gitProjectForUri(uri);
		if (!project) {
			return;
		}
		const key = uriKey(uri);
		const previous = session.files.get(key);
		if (!previous) {
			const relative = relativePath(project.rootUri, uri);
			if (shouldSkipReviewPath(relative) || await isGitIgnoredReviewPath(project.rootUri.fsPath, relative)) {
				return;
			}
		}
		const pair = await this.createGitFilePair(uri, { preferDisk: true });
		const refreshed = new Map<string, ReviewFileState>();
		if (pair) {
			project.headOid = pair.headOid ?? project.headOid;
			const file = this.createFileState(pair);
			if (file.hunks.length > 0 || file.acceptedHunks.length > 0 || file.skippedReason) {
				refreshed.set(key, file);
			}
		}
		await this.attachRejectedJournals(refreshed, [project], uri);
		let file = refreshed.get(key);
		if (!file && previous?.appliedAiSuggestions.some((suggestion) => suggestion.resolvedToIndex)) {
			file = await this.retainResolvedSuggestionFile(previous, project);
		}
		if (!file) {
			session.files.delete(key);
		} else {
			if (previous) {
				file.revision = previous.revision;
				this.restoreStableReviewItemIdentities(file, previous);
				this.restoreAppliedSuggestionGroups(file, previous);
				this.restoreAcceptedAiSuggestions(file, previous);
				if (gitReviewFileStateFingerprint(previous) !== gitReviewFileStateFingerprint(file)) {
					file.revision += 1;
				}
			}
			session.files.set(key, file);
		}
		if (options.refreshUi !== false) {
			this.refreshUi();
		}
	}

	private restoreAcceptedAiSuggestions(file: ReviewFileState, previous: ReviewFileState): void {
		for (const accepted of file.acceptedHunks) {
			accepted.appliedAiSuggestion = previous.acceptedHunks.find((candidate) => candidate.fingerprint === accepted.fingerprint)?.appliedAiSuggestion
				?? previous.appliedAiSuggestions.find((suggestion) => suggestion.appliedHunk.fingerprint === accepted.fingerprint)
				?? accepted.appliedAiSuggestion;
		}
	}

	private restoreStableReviewItemIdentities(file: ReviewFileState, previous: ReviewFileState): void {
		const currentDecisionIds = new Set([...file.acceptedHunks, ...file.rejectedHunks].flatMap((hunk) => [
			hunk.reviewItemId,
			hunk.sourceHunkId,
		].filter((value): value is string => Boolean(value))));
		const previousCandidates = [...previous.hunks, ...previous.acceptedHunks, ...previous.rejectedHunks]
			.filter((hunk) => !currentDecisionIds.has(hunk.reviewItemId ?? hunk.sourceHunkId ?? hunk.id));
		const previousGroups = new Map<string, ReviewHunk[]>();
		const currentGroups = new Map<string, ReviewHunk[]>();
		for (const hunk of previousCandidates) {
			const key = this.reviewHunkContentKey(hunk);
			previousGroups.set(key, [...(previousGroups.get(key) ?? []), hunk]);
		}
		for (const hunk of file.hunks) {
			const key = this.reviewHunkContentKey(hunk);
			currentGroups.set(key, [...(currentGroups.get(key) ?? []), hunk]);
		}
		for (const [key, current] of currentGroups) {
			const previousGroup = previousGroups.get(key);
			if (!previousGroup || previousGroup.length !== current.length) {
				continue;
			}
			const previousSorted = [...previousGroup].sort((left, right) => left.oldStart - right.oldStart || left.newStart - right.newStart);
			const currentSorted = [...current].sort((left, right) => left.oldStart - right.oldStart || left.newStart - right.newStart);
			for (let index = 0; index < currentSorted.length; index += 1) {
				const prior = previousSorted[index];
				const sourceHunkId = prior.sourceHunkId ?? prior.id;
				currentSorted[index].sourceHunkId = sourceHunkId;
				currentSorted[index].reviewItemId = prior.reviewItemId ?? sourceHunkId;
			}
		}
	}

	private reviewHunkContentKey(hunk: ReviewHunk): string {
		return [hunk.kind, hunk.oldText, hunk.newText].join('\0');
	}

	private restoreAppliedSuggestionGroups(file: ReviewFileState, previous: ReviewFileState): void {
		const restored: AppliedAiSuggestion[] = [];
		for (const applied of previous.appliedAiSuggestions) {
			if (applied.resolvedToIndex) {
				if (this.lineBlockAtCoordinateMatches(
					file.newText,
					applied.appliedHunk.newStart,
					applied.appliedHunk.newLines,
					applied.appliedHunk.newText,
				)) {
					restored.push(applied);
				}
				continue;
			}
			const members: GitReviewHunk[] = [];
			const used = new Set<string>();
			for (const saved of this.appliedSuggestionMembers(applied)) {
				const match = file.hunks.find((candidate) => !used.has(candidate.id)
					&& candidate.fingerprint === saved.fingerprint
					&& (candidate.occurrence ?? 0) === (saved.occurrence ?? 0));
				if (!match) {
					members.length = 0;
					break;
				}
				used.add(match.id);
				members.push(this.requireGitHunk(match));
			}
			if (members.length === 0) {
				continue;
			}
			const reviewItemId = applied.reviewItemId ?? applied.sourceHunkId;
			const logical = this.createLogicalSuggestionHunk(file, applied.originalHunk, members, reviewItemId);
			file.hunks = [
				...file.hunks.filter((candidate) => !used.has(candidate.id)),
				logical,
			].sort((left, right) => left.newStart - right.newStart || left.id.localeCompare(right.id));
			restored.push({
				...applied,
				currentHunkId: logical.id,
				reviewItemId,
				appliedHunk: logical,
				appliedHunks: members,
				appliedText: logical.newText,
			});
		}
		file.appliedAiSuggestions = restored;
	}

	private async refreshFile(uri: vscode.Uri, options: { reconcileExternalChanges?: boolean; preferDisk?: boolean } = {}): Promise<void> {
		if (uri.scheme !== 'file') {
			return;
		}

		if (!this.activeSession) {
			await this.ensureGitReviewForUri(uri, { preferDisk: options.preferDisk });
			return;
		}
		if (this.activeSession.mode === 'git') {
			if (!this.isOpenDocumentDirty(uri)) {
				await this.refreshGitReviewFile(uri);
			}
			return;
		}

		const key = uriKey(uri);
		if (options.reconcileExternalChanges !== false && this.isOpenDocumentDirty(uri)) {
			return;
		}

		let file = this.activeSession.files.get(key);
		if (!file) {
			return;
		}

		const previousState = this.fileStateFingerprint(file);
		const current = await this.readCurrentText(uri, { preferDisk: options.preferDisk });
		if (options.reconcileExternalChanges !== false && current.text !== file.newText && this.decisionHunks(file).length > 0) {
			const externalHunks: ReviewHunk[] = [];
			this.reconcileDecisionHunksForExternalChanges(file, externalHunks);
		}
		file.newText = current.text;
		file.currentExists = current.exists;
		const diff: { hunks: ReviewHunk[]; skippedReason?: string } = { hunks: [] };
		file.hunks = diff.hunks;
		this.normalizeReviewedDuplicateHunks(file);
		file.appliedAiSuggestions = file.appliedAiSuggestions.filter((suggestion) => file.hunks.some((hunk) => (
			hunk.id === suggestion.currentHunkId
			&& hunk.newText === suggestion.appliedHunk.newText
		)));
		file.skippedReason = diff.skippedReason;
		if (file.hunks.length === 0 && this.decisionHunks(file).length === 0 && !file.skippedReason) {
			this.activeSession.files.delete(key);
		}
		if (previousState !== this.fileStateFingerprint(file)) {
			this.touchFileRevision(file);
		}
		this.refreshUi();
	}

	private isReviewableFile(file: ReviewFileState | undefined): file is ReviewFileState {
		return Boolean(file && (
			file.hunks.length > 0
			|| file.acceptedHunks.length > 0
			|| file.rejectedHunks.length > 0
			|| file.appliedAiSuggestions.some((suggestion) => suggestion.resolvedToIndex)
			|| file.skippedReason
		));
	}

	private refreshUi(): void {
		this.treeProvider.refresh();
		this.refreshReviewPresentation();
		this.dashboardProvider.refresh();
		this.scheduleLlmWikiDashboardRefresh();
	}

	private refreshDebounceMs(): number {
		const configured = vscode.workspace.getConfiguration('cliDiff').get<number>('refreshDebounceMs', 500);
		return typeof configured === 'number' && Number.isFinite(configured)
			? Math.max(0, Math.floor(configured))
			: 500;
	}

	private scheduleLlmWikiDashboardRefresh(): void {
		this.llmDashboardRefreshPending = true;
		if (this.llmDashboardRefreshTimer) {
			return;
		}
		this.llmDashboardRefreshTimer = setTimeout(() => {
			void this.flushLlmWikiDashboardRefresh();
		}, this.refreshDebounceMs());
	}

	private async flushLlmWikiDashboardRefresh(): Promise<void> {
		this.llmDashboardRefreshPending = false;
		try {
			await this.refreshLlmWikiDashboardState();
		} finally {
			this.llmDashboardRefreshTimer = undefined;
			if (this.llmDashboardRefreshPending) {
				this.scheduleLlmWikiDashboardRefresh();
			}
		}
	}

	private refreshReviewPresentation(uri?: vscode.Uri): void {
		this.reviewWebview.refresh(uri);
	}

	private wikiRunTextDetail(label: string, content: string): AgentTraceEvent['details'][number] {
		return { label, format: 'text', content };
	}

	private wikiRunJsonDetail(label: string, value: unknown): AgentTraceEvent['details'][number] {
		try {
			return { label, format: 'json', content: JSON.stringify(value, undefined, 2) };
		} catch (error) {
			return { label, format: 'text', content: error instanceof Error ? error.message : String(error) };
		}
	}

    private spawnedAgentId(event: AgentTraceEvent): string | undefined {
        try { return JSON.parse(event.details[0]?.content ?? '{}').result?.agentId; } catch { return undefined; }
    }

	private reviewRunLogMetadata(context: CodeReviewTraceContext): RunLogMetadata {
		return {
			source: 'review',
			agentId: context.agentId,
			parentAgentId: context.parentAgentId,
			role: context.role,
			segment: context.segment,
			stage: context.stage,
			fileUri: context.fileUri,
			relativePath: context.relativePath,
			fileIndex: context.fileIndex,
			fileCount: context.fileCount,
		};
	}

	private wikiRunLogMetadata(context: WikiAgentTraceContext): RunLogMetadata {
		const identity = context.stage === 'module' ? context.moduleId ?? context.moduleName ?? 'module' : context.stage;
		return {
			source: 'wiki',
			stage: context.stage,
			fileUri: `wiki-agent://${context.stage}/${encodeURIComponent(identity)}`,
			relativePath: context.stage === 'plan'
				? 'Planner'
				: context.stage === 'integration' ? 'Wiki Integration' : `Module · ${context.moduleName ?? context.moduleId ?? 'Unknown'}`,
			fileIndex: context.moduleIndex,
			fileCount: context.moduleCount,
		};
	}

	private async refreshLlmWikiDashboardState(update: Partial<LlmWikiDashboardState> = {}): Promise<void> {
		const generation = ++this.llmDashboardRefreshGeneration;
		this.llmConfigState = await this.llmConfigStore.savedConfig();
		const workspaceAvailable = Boolean(vscode.workspace.workspaceFolders?.length);
		const root = this.dashboardWikiRootFolder();
		const aggregateProjects = this.activeSession?.mode === 'git' && this.activeSession.trackingTarget?.kind === 'aggregate'
			? this.activeSession.projects ?? []
			: [];
		const aggregateWikiStates = await Promise.all(aggregateProjects.map(async (project) => ({
			project,
			exists: await this.wikiInitializationService.wikiExists(project.rootUri),
			state: await this.wikiInitializationService.state(project.rootUri),
		})));
		const wikiExists = root
			? await this.wikiInitializationService.wikiExists(root.uri)
			: aggregateWikiStates.some((item) => item.exists);
		const wikiState = root ? await this.wikiInitializationService.state(root.uri) : undefined;
		const runtime = root ? this.projectAgentRuntimes.get(this.agentProjectKey(root.uri)) : undefined;
		const visibleSession = this.visibleReviewSession();
		const pendingSourceFiles = sourcePendingFiles(visibleSession);
		const pendingSourceCount = aggregateProjects.length > 0
			? aggregateProjects
				.filter((project) => !this.projectAgentTask(project.rootUri))
				.flatMap((project) => sourcePendingFiles(this.projectSession(project)))
				.reduce((total, file) => total + file.hunks.length, 0)
			: pendingSourceFiles.reduce((total, file) => total + file.hunks.length, 0);
		const hasPending = this.hasPendingReviewChanges();
		const storedReview = this.dashboardStoredAiReview();
		const aiReviewStatus = storedReview?.status ?? 'none';
		const aiReviewCompletedFileCount = storedReview?.completedFiles.length ?? 0;
		const aiReviewTotalFileCount = pendingSourceFiles.length;
		const reviewFindings = storedReview && visibleSession
			? sortFindings(storedReview.findings, visibleSession.files.values())
			: [];
		const reviewSuggestions = storedReview
			? [...storedReview.suggestions].sort((left, right) => left.relativePath.localeCompare(right.relativePath)
				|| left.line - right.line
				|| left.generationOrder - right.generationOrder)
			: [];
		const aiReviewFileResults = storedReview
			? [...storedReview.fileResults].sort((left, right) => left.relativePath.localeCompare(right.relativePath))
			: [];
		const findings = this.currentReviewUri && visibleSession
			? sortFindings(
				reviewFindings.filter((finding) => uriKey(vscode.Uri.parse(finding.uri)) === uriKey(this.currentReviewUri as vscode.Uri)),
				visibleSession.files.values(),
			)
			: [];
		const wikiInitializationContinuation = Boolean(root
			&& await this.wikiInitializationService.hasPipelineCheckpoint(root.uri, 'initialize'));
		const wikiUpdateContinuation = Boolean(root
			&& await this.wikiInitializationService.hasPipelineCheckpoint(root.uri, 'update'));
		let wikiNeedsUpdate = wikiUpdateContinuation
			|| Boolean(this.llmConfigState.configured && root && wikiState?.status === 'ready' && !hasPending && !runtime?.task
				&& await this.wikiInitializationService.needsUpdate(root));
		if (this.llmConfigState.configured && !root) {
			for (const item of aggregateWikiStates) {
				const hasUpdateCheckpoint = await this.wikiInitializationService.hasPipelineCheckpoint(item.project.rootUri, 'update');
				if ((item.state?.status === 'ready' || hasUpdateCheckpoint)
					&& !this.projectAgentTask(item.project.rootUri)
					&& sourcePendingFiles(this.projectSession(item.project)).length === 0
					&& (hasUpdateCheckpoint || await this.wikiInitializationService.needsUpdate(reviewProjectFolder(item.project)))) {
					wikiNeedsUpdate = true;
					break;
				}
			}
		}
		let status: LlmWikiDashboardState['status'] = update.status ?? 'idle';

		if (!this.llmConfigState.configured) {
			status = 'unconfigured';
		} else if (runtime?.task) {
			status = runtime.task.kind === 'review' ? 'reviewing' : runtime.task.kind === 'update' ? 'updating' : 'initializing';
		} else if (runtime?.run?.lifecycle === 'interrupted' && runtime.run.kind === 'initialize') {
			status = 'paused';
		} else if (runtime?.run?.lifecycle === 'failed' || runtime?.run?.lifecycle === 'interrupted') {
			status = 'failed';
		} else if (runtime?.run?.lifecycle === 'paused') {
			status = 'paused';
		} else if (wikiState?.status === 'ready' || (aggregateWikiStates.length > 0 && aggregateWikiStates.every((item) => item.state?.status === 'ready'))) {
			status = 'initialized';
		} else if (wikiState?.status === 'paused') {
			status = 'paused';
		} else if (wikiState?.status === 'failed') {
			status = 'failed';
		} else if (!['idle', 'paused', 'failed'].includes(status)) {
			status = 'idle';
		}

		const visibleReviewFindings = update.reviewFindings ?? reviewFindings;
		const visibleReviewSuggestions = update.reviewSuggestions ?? reviewSuggestions;
		const projectAgents = this.projectAgentSummaries(aggregateProjects, visibleReviewFindings, visibleReviewSuggestions);
		if (generation !== this.llmDashboardRefreshGeneration) {
			return;
		}
		this.llmWikiState = {
			configured: this.llmConfigState.configured,
			provider: this.llmConfigState.provider,
			baseUrl: this.llmConfigState.baseUrl,
			model: this.llmConfigState.model,
			hasApiKey: this.llmConfigState.hasApiKey,
			workspaceAvailable,
			wikiExists: wikiExists || status === 'initialized',
			status,
			progress: runtime?.run?.progress ?? update.progress,
			error: runtime?.run?.error ?? update.error,
			pendingSourceCount,
			wikiNeedsUpdate,
			wikiInitializationAvailable: root
				? wikiState?.status !== 'ready'
				: aggregateWikiStates.some((item) => item.state?.status !== 'ready'),
			wikiInitializationContinuation,
			wikiUpdateAvailable: wikiNeedsUpdate,
			wikiUpdateContinuation,
			wikiOpenAvailable: wikiExists,
			findings,
			jsonOutputEnabled: this.llmConfigState.jsonOutputEnabled,
			thinkingMode: this.llmConfigState.thinkingMode,
			strictTools: this.llmConfigState.strictTools,
			contextWindowTokens: this.llmConfigState.contextWindowTokens,
			compressionThresholdPercent: this.llmConfigState.compressionThresholdPercent,
			maxOutputTokens: this.llmConfigState.maxOutputTokens,
			activeProfileId: this.llmConfigState.activeProfileId,
			profiles: this.llmConfigState.profiles,
			runLog: runtime?.run?.entries ?? [],
			runLogSource: runtime?.run?.source,
			reviewFindings: visibleReviewFindings,
			reviewSuggestions: visibleReviewSuggestions,
			aiReviewFileResults: update.aiReviewFileResults ?? aiReviewFileResults,
			aiReviewStatus: update.aiReviewStatus ?? aiReviewStatus,
			aiReviewCompletedFileCount: update.aiReviewCompletedFileCount ?? aiReviewCompletedFileCount,
			aiReviewTotalFileCount: update.aiReviewTotalFileCount ?? aiReviewTotalFileCount,
			aiReviewError: update.aiReviewError ?? storedReview?.error,
			aiReviewSummary: storedReview?.summary,
			aiReviewUsage: storedReview?.agentState?.usage,
			aiReviewNotificationCount: storedReview?.agentState?.notifications,
			aiReviewChildCount: storedReview?.agentState ? Object.values(storedReview.agentState.tasks).filter((task) => task.parentId).length : undefined,
			aiReviewKnowledgeFreshness: storedReview?.knowledgeFreshness,
			agentProjectKey: root ? this.agentProjectKey(root.uri) : undefined,
			aggregateProjectView: aggregateProjects.length > 0,
			projectAgents,
		};
		this.dashboardProvider.refresh();
	}

	private projectAgentSummaries(
		projects: ReviewProject[],
		findings: StoredAiReview['findings'],
		suggestions: StoredAiReview['suggestions'],
	): ProjectAgentSummary[] {
		return projects.map((project) => {
			const runtime = this.projectAgentRuntimes.get(this.agentProjectKey(project.rootUri));
			const lifecycle: ProjectAgentSummary['lifecycle'] = runtime?.task ? 'running' : runtime?.run?.lifecycle ?? 'idle';
			const files = this.projectSession(project)?.files.values() ?? [];
			let pendingCount = 0;
			let acceptedCount = 0;
			let rejectedCount = 0;
			const fileUris = new Set<string>();
			for (const file of files) {
				fileUris.add(uriKey(file.uri));
				const reviewedIdentities = new Set([...file.acceptedHunks, ...file.rejectedHunks].map(reviewHunkIdentity));
				pendingCount += file.hunks.filter((hunk) => !reviewedIdentities.has(reviewHunkIdentity(hunk))).length;
				acceptedCount += file.acceptedHunks.length;
				rejectedCount += file.rejectedHunks.length;
			}
			const findingCount = findings.filter((finding) => fileUris.has(uriKey(vscode.Uri.parse(finding.uri)))).length;
			const suggestionCount = suggestions.filter((suggestion) => fileUris.has(uriKey(vscode.Uri.parse(suggestion.uri)))).length;
			return {
				projectId: project.id,
				projectName: project.name,
				branchName: project.branchName,
				rootUri: project.rootUri.toString(),
				taskKind: runtime?.task?.kind ?? runtime?.run?.kind,
				lifecycle,
				pendingCount,
				acceptedCount,
				rejectedCount,
				findingCount,
				suggestionCount,
				progress: runtime?.run?.progress,
				error: runtime?.run?.error,
				running: Boolean(runtime?.task),
				hasRunLog: Boolean(runtime?.run?.entries.length),
			};
		}).sort((left, right) => Number(right.running) - Number(left.running) || left.projectName.localeCompare(right.projectName));
	}

	private async dashboardWikiExists(): Promise<boolean> {
		const rootUri = this.dashboardWikiRootUri();
		return rootUri ? this.wikiInitializationService.wikiExists(rootUri) : false;
	}

	private dashboardWikiRootUri(): vscode.Uri | undefined {
		const folders = vscode.workspace.workspaceFolders ?? [];
		const selectedProject = currentReviewProject(this.activeSession);
		if (selectedProject) {
			return selectedProject.rootUri;
		}
		if (this.activeSession?.mode === 'git' && this.activeSession.trackingTarget?.kind === 'aggregate') {
			return undefined;
		}
		if (this.wikiRootUri && folders.some((folder) => uriKey(folder.uri) === uriKey(this.wikiRootUri as vscode.Uri))) {
			return this.wikiRootUri;
		}
		if (this.activeSession && folders.some((folder) => uriKey(folder.uri) === uriKey(this.activeSession?.rootUri as vscode.Uri))) {
			return this.activeSession.rootUri;
		}
		return folders.length === 1 ? folders[0].uri : undefined;
	}

	private dashboardWikiRootFolder(): vscode.WorkspaceFolder | undefined {
		const rootUri = this.dashboardWikiRootUri();
		if (!rootUri) {
			return undefined;
		}
		const project = this.activeSession?.projects?.find((candidate) => uriKey(candidate.rootUri) === uriKey(rootUri));
		return project
			? reviewProjectFolder(project)
			: vscode.workspace.workspaceFolders?.find((folder) => uriKey(folder.uri) === uriKey(rootUri));
	}

	private setCurrentReviewUri(uri: vscode.Uri): void {
		if (this.currentReviewUri && uriKey(this.currentReviewUri) === uriKey(uri)) {
			return;
		}
		this.currentReviewUri = uri;
		this.dashboardProvider.refresh();
		this.scheduleLlmWikiDashboardRefresh();
	}

	private activeGitWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
		if (!this.activeSession || this.activeSession.mode !== 'git') {
			return undefined;
		}

		return vscode.workspace.getWorkspaceFolder(this.activeSession.rootUri)
			?? vscode.workspace.workspaceFolders?.find((workspaceFolder) => uriKey(workspaceFolder.uri) === uriKey(this.activeSession?.rootUri ?? workspaceFolder.uri));
	}

	private gitProjectForUri(uri: vscode.Uri): ReviewProject | undefined {
		return this.activeSession?.projects?.find((project) => uriIsInside(project.rootUri, uri));
	}

	private scheduleGitSessionRefresh(): void {
		if (!this.activeSession || this.activeSession.mode !== 'git' || this.gitMutationDepth > 0) {
			return;
		}

		if (this.gitRefreshTimer) {
			clearTimeout(this.gitRefreshTimer);
		}

		this.gitRefreshTimer = setTimeout(() => {
			this.gitRefreshTimer = undefined;
			void this.refreshGitSessionFiles({ source: 'gitIndexChanged' });
		}, this.refreshDebounceMs());
	}

	private touchFileRevision(file: ReviewFileState): void {
		file.revision += 1;
	}

	private findRegeneratedSuggestionHunks(
		file: ReviewFileState,
		originalHunk: ReviewHunk,
		otherHunks: ReviewHunk[],
		beforeText: string,
	): SuggestionMappingResult {
		const gitHunks = file.hunks.map((hunk) => this.requireGitHunk(hunk));
		const withoutOriginalHunk = replaceLineBlock(
			beforeText,
			originalHunk.newStart,
			originalHunk.newLines,
			originalHunk.oldText,
		);
		const matchesExpectedReference = file.newText === withoutOriginalHunk;
		const preservedOtherIds = new Set<string>();
		for (const previous of otherHunks) {
			const match = gitHunks.find((candidate) => candidate.fingerprint === previous.fingerprint
				&& (candidate.occurrence ?? 0) === (previous.occurrence ?? 0));
			if (match) {
				preservedOtherIds.add(match.id);
			}
		}
		const candidates = gitHunks.filter((candidate) => !preservedOtherIds.has(candidate.id)
			&& this.gitHunkTouchesBaselineScope(candidate, originalHunk))
			.sort((left, right) => left.oldStart - right.oldStart || left.newStart - right.newStart || left.id.localeCompare(right.id));
		const outsideScopeCandidateCount = gitHunks.filter((candidate) => !preservedOtherIds.has(candidate.id)
			&& !this.gitHunkTouchesBaselineScope(candidate, originalHunk)).length;
		const diagnostics: SuggestionMappingDiagnostics = {
			original: {
				kind: originalHunk.kind,
				oldStart: originalHunk.oldStart,
				oldLines: originalHunk.oldLines,
				newStart: originalHunk.newStart,
				newLines: originalHunk.newLines,
			},
			regeneratedHunkCount: gitHunks.length,
			regeneratedHunks: gitHunks.map((candidate) => ({
				fingerprint: candidate.fingerprint,
				occurrence: candidate.occurrence,
				kind: candidate.kind,
				oldStart: candidate.oldStart,
				oldLines: candidate.oldLines,
				newStart: candidate.newStart,
				newLines: candidate.newLines,
				disposition: preservedOtherIds.has(candidate.id)
					? 'preserved-other'
					: this.gitHunkTouchesBaselineScope(candidate, originalHunk)
						? 'candidate'
						: 'outside-target-scope',
			})),
			preservedOtherHunkCount: preservedOtherIds.size,
			outsideScopeCandidateCount,
			referenceCompared: true,
			matchesExpectedReference,
			resolvedToIndex: matchesExpectedReference && candidates.length === 0,
			candidateCount: candidates.length,
			candidates: candidates.map((candidate) => ({
				fingerprint: candidate.fingerprint,
				occurrence: candidate.occurrence,
				oldStart: candidate.oldStart,
				oldLines: candidate.oldLines,
				newStart: candidate.newStart,
				newLines: candidate.newLines,
			})),
			otherPendingCount: otherHunks.length,
			validGroupCount: 0,
			overlappingGroupCount: 0,
			targetResidualRanges: [],
			otherResidualRanges: [],
		};
		if (diagnostics.resolvedToIndex) {
			return { ok: true, effect: 'resolved-to-index', members: [], undoText: beforeText };
		}
		if (candidates.length === 0) {
			return { ok: false, reason: 'no-candidate', diagnostics };
		}
		const validGroups: Array<{ members: GitReviewHunk[]; undoText: string }> = [];
		for (let start = 0; start < candidates.length; start += 1) {
			for (let end = start; end < candidates.length; end += 1) {
				const members = candidates.slice(start, end + 1);
				if (members.some((member) => otherHunks.some((other) => this.gitHunkTouchesBaselineScope(member, other)))) {
					diagnostics.overlappingGroupCount += 1;
					continue;
				}
				let withoutAppliedSuggestion = file.newText;
				for (const member of [...members].sort((left, right) => right.newStart - left.newStart)) {
					withoutAppliedSuggestion = replaceLineBlock(withoutAppliedSuggestion, member.newStart, member.newLines, member.oldText);
				}
				const residualChanges = computeLineDiff(file.uri.toString(), withoutOriginalHunk, withoutAppliedSuggestion);
				const targetResiduals = residualChanges.filter((change) => this.lineSpansTouch(
					change.oldStart,
					change.oldLines,
					originalHunk.newStart,
					originalHunk.oldLines,
				));
				if (targetResiduals.length > 0) {
					diagnostics.targetResidualRanges.push(...targetResiduals.map((change) => this.suggestionMappingRange(change)));
					continue;
				}
				const otherResiduals = residualChanges.filter((change) => otherHunks.some((other) => this.lineSpansTouch(
					change.oldStart,
					change.oldLines,
					other.newStart,
					other.newLines,
				)));
				if (otherResiduals.length > 0) {
					diagnostics.otherResidualRanges.push(...otherResiduals.map((change) => this.suggestionMappingRange(change)));
					continue;
				}
				const residualEdits = residualChanges.map((change) => ({
					oldStart: change.oldStart,
					oldLines: change.oldLines,
					newLines: change.newLines,
				}));
				const restoredStart = mapLineAfterFileEdits(originalHunk.newStart, residualEdits);
				validGroups.push({
					members,
					undoText: replaceLineBlock(
						withoutAppliedSuggestion,
						restoredStart,
						originalHunk.oldLines,
						originalHunk.newText,
					),
				});
			}
		}
		diagnostics.validGroupCount = validGroups.length;
		const smallestSize = Math.min(...validGroups.map((group) => group.members.length));
		const smallestGroups = validGroups.filter((group) => group.members.length === smallestSize);
		if (smallestGroups.length === 1) {
			return { ok: true, effect: 'git-hunks', ...smallestGroups[0] };
		}
		const reason: SuggestionMappingFailureReason = smallestGroups.length > 1
			? 'ambiguous'
			: diagnostics.targetResidualRanges.length > 0
				? 'target-residual'
				: diagnostics.otherResidualRanges.length > 0
					? 'other-hunk-residual'
					: 'other-hunk-overlap';
		return { ok: false, reason, diagnostics };
	}

	private suggestionMappingRange(hunk: ReviewHunk): Pick<ReviewHunk, 'oldStart' | 'oldLines' | 'newStart' | 'newLines'> {
		return {
			oldStart: hunk.oldStart,
			oldLines: hunk.oldLines,
			newStart: hunk.newStart,
			newLines: hunk.newLines,
		};
	}

	private emptySuggestionMappingDiagnostics(originalHunk: ReviewHunk, otherPendingCount: number): SuggestionMappingDiagnostics {
		return {
			original: {
				kind: originalHunk.kind,
				oldStart: originalHunk.oldStart,
				oldLines: originalHunk.oldLines,
				newStart: originalHunk.newStart,
				newLines: originalHunk.newLines,
			},
			regeneratedHunkCount: 0,
			regeneratedHunks: [],
			preservedOtherHunkCount: 0,
			outsideScopeCandidateCount: 0,
			referenceCompared: false,
			matchesExpectedReference: false,
			resolvedToIndex: false,
			candidateCount: 0,
			candidates: [],
			otherPendingCount,
			validGroupCount: 0,
			overlappingGroupCount: 0,
			targetResidualRanges: [],
			otherResidualRanges: [],
		};
	}

	private gitHunkTouchesBaselineScope(candidate: ReviewHunk, scope: ReviewHunk): boolean {
		if (scope.oldLines === 0) {
			return candidate.oldLines === 0
				? candidate.oldStart === scope.oldStart
				: candidate.oldStart <= scope.oldStart && scope.oldStart <= candidate.oldStart + candidate.oldLines;
		}
		if (candidate.oldLines === 0) {
			return scope.oldStart <= candidate.oldStart && candidate.oldStart <= scope.oldStart + scope.oldLines;
		}
		return candidate.oldStart < scope.oldStart + scope.oldLines
			&& scope.oldStart < candidate.oldStart + candidate.oldLines;
	}

	private createLogicalSuggestionHunk(
		file: ReviewFileState,
		originalHunk: ReviewHunk,
		members: GitReviewHunk[],
		reviewItemId: string,
	): GitReviewHunk {
		if (members.length === 1) {
			return {
				...members[0],
				sourceHunkId: originalHunk.sourceHunkId ?? originalHunk.id,
				reviewItemId,
				memberHunks: members,
			};
		}
		const oldStart = Math.min(...members.map((member) => member.oldStart));
		const oldEnd = Math.max(...members.map((member) => member.oldStart + member.oldLines));
		const newStart = Math.min(...members.map((member) => member.newStart));
		const newEnd = Math.max(...members.map((member) => member.newStart + member.newLines));
		const oldLines = Math.max(0, oldEnd - oldStart);
		const newLines = Math.max(0, newEnd - newStart);
		const oldText = this.lineBlock(file.gitSnapshot?.indexText ?? file.oldText, oldStart, oldLines);
		const newText = this.lineBlock(file.newText, newStart, newLines);
		const oldContext = captureLineBlockContext(file.gitSnapshot?.indexText ?? file.oldText, oldStart, oldLines);
		const newContext = captureLineBlockContext(file.newText, newStart, newLines);
		const memberIdentity = members.map((member) => `${member.fingerprint}:${member.occurrence ?? 0}`).join('|');
		const fingerprint = createHash('sha256').update(memberIdentity).digest('hex').slice(0, 24);
		return {
			id: `suggestion-${reviewItemId}`,
			fileUri: file.uri.toString(),
			oldStart,
			oldLines,
			newStart,
			newLines,
			oldText,
			newText,
			kind: oldLines === 0 ? 'add' : newLines === 0 ? 'delete' : 'modify',
			oldContextBefore: oldContext.before,
			oldContextAfter: oldContext.after,
			newContextBefore: newContext.before,
			newContextAfter: newContext.after,
			zoneAfterLineNumber: newStart,
			layer: 'pending',
			patch: this.gitService.combinePatches(members),
			fingerprint,
			projectId: members[0].projectId,
			occurrence: 0,
			operable: true,
			sourceHunkId: originalHunk.sourceHunkId ?? originalHunk.id,
			reviewItemId,
			memberHunks: members,
		};
	}

	private createResolvedSuggestionHunk(
		originalHunk: ReviewHunk,
		replacementText: string,
		reviewItemId: string,
	): ReviewHunk {
		return {
			...originalHunk,
			id: `suggestion-resolved-${reviewItemId}`,
			newLines: splitLines(replacementText).length,
			newText: replacementText,
			layer: 'pending',
			patch: undefined,
			patchHeader: undefined,
			rawHunk: undefined,
			operable: false,
			sourceHunkId: originalHunk.sourceHunkId ?? originalHunk.id,
			reviewItemId,
			memberHunks: [],
		};
	}

	private createResolvedSuggestionFileState(previous: ReviewFileState, workingText: string): ReviewFileState {
		return {
			...previous,
			newText: workingText,
			hunks: [],
			acceptedHunks: [],
			rejectedHunks: [],
			appliedAiSuggestions: [],
			currentExists: true,
			gitSnapshot: previous.gitSnapshot ? {
				...previous.gitSnapshot,
				workingText,
				workingExists: true,
			} : undefined,
		};
	}

	private async retainResolvedSuggestionFile(
		previous: ReviewFileState,
		project: ReviewProject,
	): Promise<ReviewFileState | undefined> {
		if (!previous.gitSnapshot || (previous.headOid !== undefined && project.headOid !== previous.headOid)) {
			return undefined;
		}
		const folder = reviewProjectFolder(project);
		const [current, index] = await Promise.all([
			this.readCurrentText(previous.uri, { preferDisk: true }),
			this.gitService.readIndexEntry(folder, previous.relativePath),
		]);
		if (index.exists !== previous.gitSnapshot.indexExists || index.text !== previous.gitSnapshot.indexText) {
			return undefined;
		}
		const retainedSuggestions = previous.appliedAiSuggestions.filter((applied) => applied.resolvedToIndex
			&& current.exists
			&& this.lineBlockAtCoordinateMatches(
				current.text,
				applied.appliedHunk.newStart,
				applied.appliedHunk.newLines,
				applied.appliedHunk.newText,
			));
		if (retainedSuggestions.length === 0) {
			return undefined;
		}
		const retained = this.createResolvedSuggestionFileState(previous, current.text);
		retained.appliedAiSuggestions = retainedSuggestions;
		retained.headOid = project.headOid;
		return retained;
	}

	private appliedSuggestionMembers(applied: AppliedAiSuggestion): ReviewHunk[] {
		return applied.appliedHunks !== undefined ? applied.appliedHunks : [applied.appliedHunk];
	}

	private retainAppliedAiSuggestions(file: ReviewFileState, suggestions: Array<AppliedAiSuggestion | undefined>): void {
		const retained = new Map(file.appliedAiSuggestions.map((suggestion) => [suggestion.suggestionId, suggestion]));
		for (const suggestion of suggestions) {
			if (suggestion) {
				retained.set(suggestion.suggestionId, suggestion);
			}
		}
		file.appliedAiSuggestions = [...retained.values()];
	}

	private async restoreAppliedSuggestionText(file: ReviewFileState, applied: AppliedAiSuggestion): Promise<void> {
		const current = await this.readCurrentText(file.uri);
		if (current.exists
			&& applied.appliedWorkingText !== undefined
			&& applied.undoWorkingText !== undefined
			&& current.text === applied.appliedWorkingText) {
			await this.writeCurrentFileText(file.uri, applied.undoWorkingText);
			return;
		}
		const candidates = [
			...file.hunks,
			...file.acceptedHunks,
			...file.rejectedHunks,
		].filter((hunk) => hunk.newText === applied.appliedHunk.newText);
		const coordinate = candidates.find((hunk) => (
			hunk.id === applied.currentHunkId
			|| hunk.fingerprint === applied.appliedHunk.fingerprint
		))?.newStart ?? applied.appliedHunk.newStart;
		if (!current.exists || !this.lineBlockAtCoordinateMatches(
			current.text,
			coordinate,
			applied.appliedHunk.newLines,
			applied.appliedHunk.newText,
		)) {
			throw new Error('The accepted AI suggestion no longer matches the current file. Refresh the review and try again.');
		}
		const restoredText = replaceLineBlock(
			current.text,
			coordinate,
			applied.appliedHunk.newLines,
			applied.originalHunk.newText,
		);
		await this.writeCurrentFileText(file.uri, restoredText);
	}

	private async saveAiReviewWithCurrentSignature(review: StoredAiReview | undefined, session = this.visibleReviewSession()): Promise<void> {
		if (!review || !session) {
			return;
		}
		await this.aiReviewStore.save(session, {
			...review,
			signature: reviewChangeSignature(session),
			findings: [...review.findings],
			suggestions: [...review.suggestions],
			fileResults: [...review.fileResults],
			completedFiles: [...review.completedFiles],
		});
	}

	private sessionForFile(file: ReviewFileState | undefined): ReviewSession | undefined {
		if (!file || !this.activeSession) {
			return undefined;
		}
		const project = this.activeSession.projects?.find((candidate) => candidate.id === file.projectId);
		return project ? projectReviewSession(this.activeSession, project) : this.activeSession;
	}

	private isStaleMutation(file: ReviewFileState, expectedRevision?: number): boolean {
		const stale = isStaleRevision(file.revision, expectedRevision);
		if (stale) {
			void vscode.window.showInformationMessage('The Git change changed before the action ran. Cli Diff Review refreshed it; try the action again.');
		}
		return stale;
	}

	private syncBaselineExistsAfterAccept(file: ReviewFileState): void {
		file.baselineExists = file.currentExists || file.oldText.length > 0;
	}

	private syncBaselineExistsForPending(file: ReviewFileState): void {
		file.baselineExists = file.originalExists || file.oldText.length > 0;
	}

	private fileStateFingerprint(file: ReviewFileState): string {
		return JSON.stringify({
			oldText: file.oldText,
			newText: file.newText,
			baselineExists: file.baselineExists,
			currentExists: file.currentExists,
			skippedReason: file.skippedReason,
			hunks: file.hunks,
			acceptedHunks: file.acceptedHunks,
			rejectedHunks: file.rejectedHunks,
			appliedAiSuggestions: file.appliedAiSuggestions,
		});
	}

	private isOpenDocumentDirty(uri: vscode.Uri): boolean {
		return vscode.workspace.textDocuments.some((document) => document.uri.toString() === uri.toString() && document.isDirty);
	}

	private ensureFileCleanForReviewMutation(file: ReviewFileState): boolean {
		if (!this.isOpenDocumentDirty(file.uri)) {
			return true;
		}

		vscode.window.showInformationMessage('Save or revert this file before accepting, rejecting, or undoing Cli Diff Review changes.');
		this.refreshReviewPresentation(file.uri);
		return false;
	}

	private isInternalWriteActive(uri: vscode.Uri): boolean {
		return (this.internalWriteDepth.get(uriKey(uri)) ?? 0) > 0;
	}

	private hasHumanSaveIntent(uri: vscode.Uri): boolean {
		const key = uriKey(uri);
		const until = this.humanSaveIntents.get(key);
		if (!until) {
			return false;
		}

		if (Date.now() > until) {
			this.humanSaveIntents.delete(key);
			return false;
		}

		return true;
	}

	private isInWriteGrace(uri: vscode.Uri, source?: InternalWriteSource): boolean {
		const grace = this.writeGraceUntil.get(uriKey(uri));
		if (!grace) {
			return false;
		}

		if (Date.now() > grace.until) {
			this.writeGraceUntil.delete(uriKey(uri));
			return false;
		}

		return source ? grace.source === source : true;
	}

	private markWriteGrace(uri: vscode.Uri, source: InternalWriteSource): void {
		this.writeGraceUntil.set(uriKey(uri), { source, until: Date.now() + 1000 });
	}

	private async withInternalWrite<T>(uri: vscode.Uri, source: InternalWriteSource, callback: () => Promise<T>): Promise<T> {
		const key = uriKey(uri);
		this.humanEditBatches.delete(key);
		this.humanSaveIntents.delete(key);
		this.internalWriteDepth.set(key, (this.internalWriteDepth.get(key) ?? 0) + 1);
		try {
			return await callback();
		} finally {
			const nextCount = (this.internalWriteDepth.get(key) ?? 1) - 1;
			if (nextCount <= 0) {
				this.internalWriteDepth.delete(key);
				this.markWriteGrace(uri, source);
			} else {
				this.internalWriteDepth.set(key, nextCount);
			}
		}
	}

	private async withInternalWrites<T>(uris: vscode.Uri[], callback: () => Promise<T>): Promise<T> {
		const unique = [...new Map(uris.map((uri) => [uriKey(uri), uri])).values()];
		const run = async (index: number): Promise<T> => index >= unique.length
			? callback()
			: this.withInternalWrite(unique[index], 'plugin', () => run(index + 1));
		return run(0);
	}

	private countInsertedLines(text: string): number {
		if (!text) {
			return 0;
		}
		return text.split(/\r\n|\r|\n/).length;
	}

	private mergeEditedRanges(ranges: EditedRange[]): EditedRange[] {
		if (ranges.length === 0) {
			return [];
		}

		const sorted = ranges.slice().sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
		const merged: EditedRange[] = [];
		for (const range of sorted) {
			const last = merged[merged.length - 1];
			if (!last || range.startLine > last.endLine) {
				merged.push({ ...range });
			} else {
				last.endLine = Math.max(last.endLine, range.endLine);
			}
		}
		return merged;
	}

	private handleFileSystemChange(uri: vscode.Uri): void {
		if (uri.scheme !== 'file') {
			return;
		}

		if (this.isInternalWriteActive(uri) || this.isInWriteGrace(uri, 'plugin') || this.isInWriteGrace(uri, 'human')) {
			return;
		}

		if (this.humanEditBatches.has(uriKey(uri)) || this.hasHumanSaveIntent(uri) || this.isOpenDocumentDirty(uri)) {
			return;
		}

		this.scheduleRefresh(uri, { preferDisk: true });
	}

	private scheduleRefresh(uri: vscode.Uri, options: { preferDisk?: boolean } = {}): void {
		if (uri.scheme !== 'file') {
			return;
		}
		const key = uriKey(uri);
		const existing = this.refreshTimers.get(key);
		if (existing) {
			clearTimeout(existing);
		}

		this.refreshTimers.set(key, setTimeout(() => {
			this.refreshTimers.delete(key);
			void this.refreshFile(uri, { preferDisk: options.preferDisk });
		}, this.refreshDebounceMs()));
	}

	private async ensureVisibleEditorsReviewed(): Promise<void> {
		for (const editor of vscode.window.visibleTextEditors) {
			await this.ensureGitReviewForUri(editor.document.uri);
		}
	}

	private async ensureGitReviewForUri(uri: vscode.Uri, options: { preferDisk?: boolean } = {}): Promise<void> {
		if (uri.scheme !== 'file' || !vscode.workspace.getConfiguration('cliDiff').get<boolean>('autoStartGitReview', true)) {
			return;
		}

		const folder = vscode.workspace.getWorkspaceFolder(uri);

		if (!this.activeSession && folder) {
			await this.initializeGitSessionForFolder(folder);
		}

		if (!this.activeSession || this.activeSession.mode !== 'git') {
			return;
		}

		// Opening or focusing an editor does not change Git state. File and Git
		// watchers keep an existing session synchronized without a full scan here.
		void options;
	}

	private async createGitFilePair(uri: vscode.Uri, options: { preferDisk?: boolean } = {}): Promise<FilePair | undefined> {
		const project = this.gitProjectForUri(uri);
		const folder = project ? reviewProjectFolder(project) : vscode.workspace.getWorkspaceFolder(uri);
		const pair = await this.gitService.createFilePairForUri(uri, folder, { preferDisk: options.preferDisk });
		if (!pair) {
			return undefined;
		}
		return project ? { ...pair, projectId: project.id, projectName: project.name } : pair;
	}

	private resolveHunk(uriString?: string, hunkId?: string): { file: ReviewFileState; hunk: ReviewHunk } | undefined {
		const file = this.resolveFile(uriString);
		if (!file || file.hunks.length === 0) {
			return undefined;
		}

		if (hunkId) {
			const hunk = file.hunks.find((item) => item.id === hunkId);
			return hunk ? { file, hunk } : undefined;
		}

		const line = vscode.window.activeTextEditor?.selection.active.line ?? 0;
		const containing = file.hunks.find((hunk) => line >= hunk.newStart && line <= hunk.newStart + Math.max(1, hunk.newLines));
		if (containing) {
			return { file, hunk: containing };
		}

		const nearest = file.hunks.find((hunk) => hunk.newStart >= line) ?? file.hunks[0];
		return { file, hunk: nearest };
	}

	private resolveDecisionHunk(uriString?: string, hunkId?: string): { file: ReviewFileState; hunk: ReviewedHunk; list: 'accepted' | 'rejected' } | undefined {
		const file = this.resolveFile(uriString);
		if (!file || !hunkId) {
			return undefined;
		}

		const accepted = file.acceptedHunks.find((item) => item.id === hunkId && item.reviewSource === 'accept');
		if (accepted) {
			return { file, hunk: accepted, list: 'accepted' };
		}

		const rejected = file.rejectedHunks.find((item) => item.id === hunkId);
		return rejected ? { file, hunk: rejected, list: 'rejected' } : undefined;
	}

	private resolveFile(uriString?: string | ReviewFileState): ReviewFileState | undefined {
		if (!this.activeSession) {
			return undefined;
		}

		if (uriString && typeof uriString !== 'string') {
			return this.activeSession.files.get(uriKey(uriString.uri));
		}

		if (uriString) {
			return this.activeSession.files.get(uriKey(vscode.Uri.parse(uriString)));
		}

		const activeUri = vscode.window.activeTextEditor?.document.uri;
		return activeUri ? this.activeSession.files.get(uriKey(activeUri)) : undefined;
	}

	private operationUri(uriString?: string | ReviewFileState): vscode.Uri | undefined {
		if (uriString && typeof uriString !== 'string') {
			return uriString.uri;
		}
		if (uriString) {
			return vscode.Uri.parse(uriString);
		}
		return vscode.window.activeTextEditor?.document.uri;
	}

	private async enqueueFileOperation(uri: vscode.Uri | undefined, operation: () => Promise<void>): Promise<void> {
		if (!uri) {
			await operation();
			return;
		}

		const file = this.activeSession?.files.get(uriKey(uri));
		const project = file?.projectId
			? this.activeSession?.projects?.find((candidate) => candidate.id === file.projectId)
			: this.gitProjectForUri(uri);
		await this.fileOperationQueue.enqueue(project ? uriKey(project.rootUri) : uriKey(uri), async () => {
			if (project && this.gitRefreshInFlight) {
				await this.gitRefreshInFlight;
			}
			if (project && this.gitRefreshTimer) {
				clearTimeout(this.gitRefreshTimer);
				this.gitRefreshTimer = undefined;
			}
			this.gitMutationDepth += 1;
			try {
				await operation();
			} finally {
				this.gitMutationDepth = Math.max(0, this.gitMutationDepth - 1);
			}
		});
	}

	private flattenHunks(): Array<{ file: ReviewFileState; hunk: ReviewHunk }> {
		if (!this.activeSession) {
			return [];
		}

		return visibleReviewFiles(this.activeSession)
			.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
			.flatMap((file) => file.hunks.map((hunk) => ({ file, hunk })));
	}

	private recordDecisionHunk(
		file: ReviewFileState,
		hunk: ReviewHunk,
		reviewSource: ReviewSource,
		displayStart = hunk.newStart,
		displayLines = reviewSource === 'reject' ? hunk.oldLines : hunk.newLines,
		baselineStart = hunk.oldStart,
		currentStart = displayStart,
	): void {
		const decision = this.createDecisionHunk(file, hunk, reviewSource, displayStart, displayLines, baselineStart, currentStart);
		if (reviewSource === 'reject') {
			if (file.rejectedHunks.some((item) => this.isSameDecision(item, hunk, reviewSource))) {
				return;
			}
			file.rejectedHunks.push(decision);
		} else {
			if (file.acceptedHunks.some((item) => this.isSameDecision(item, hunk, reviewSource))) {
				return;
			}
			file.acceptedHunks.push(decision);
		}
	}

	private removePendingHunk(file: ReviewFileState, hunk: ReviewHunk): void {
		file.hunks = file.hunks.filter((item) => !this.isSameReviewHunk(item, hunk));
		file.appliedAiSuggestions = file.appliedAiSuggestions.filter((item) => item.currentHunkId !== hunk.id);
	}

	private normalizeReviewedDuplicateHunks(file: ReviewFileState): void {
		const reviewedIdentities = new Set(this.decisionHunks(file).map(reviewHunkIdentity));
		if (reviewedIdentities.size === 0) {
			return;
		}

		file.hunks = file.hunks.filter((hunk) => !reviewedIdentities.has(reviewHunkIdentity(hunk)));
	}

	private refreshPendingHunksFromReviewState(file: ReviewFileState): void {
		file.hunks = [];
		this.normalizeReviewedDuplicateHunks(file);
		file.appliedAiSuggestions = file.appliedAiSuggestions.filter((suggestion) => file.hunks.some((hunk) => (
			hunk.id === suggestion.currentHunkId
			&& hunk.newText === suggestion.appliedHunk.newText
		)));
		file.skippedReason = undefined;
	}

	private isSameReviewHunk(left: ReviewHunk, right: ReviewHunk): boolean {
		return left.fileUri === right.fileUri
			&& left.kind === right.kind
			&& left.oldStart === right.oldStart
			&& left.oldLines === right.oldLines
			&& left.newStart === right.newStart
			&& left.newLines === right.newLines
			&& left.oldText === right.oldText
			&& left.newText === right.newText;
	}

	private isSameDecision(decision: ReviewedHunk, hunk: ReviewHunk, reviewSource: ReviewSource): boolean {
		return decision.reviewSource === reviewSource && this.isSameReviewHunk(decision, hunk);
	}

	private createDecisionHunk(
		file: ReviewFileState,
		hunk: ReviewHunk,
		reviewSource: ReviewSource,
		displayStart: number,
		displayLines: number,
		baselineStart: number,
		currentStart: number,
	): ReviewedHunk {
		const baselineLines = reviewSource === 'accept' ? hunk.newLines : hunk.oldLines;
		const currentLines = reviewSource === 'reject' ? displayLines : hunk.newLines;
		const baselineContext = captureLineBlockContext(file.oldText, baselineStart, baselineLines);
		const currentContext = captureLineBlockContext(file.newText, currentStart, currentLines);
		const appliedAiSuggestion = reviewSource === 'accept'
			? file.appliedAiSuggestions.find((item) => item.currentHunkId === hunk.id && item.appliedHunk.newText === hunk.newText)
			: undefined;
		return {
			...hunk,
			id: `${reviewSource}-${Date.now()}-${hunk.id}`,
			sourceHunkId: hunk.sourceHunkId ?? hunk.id,
			reviewItemId: hunk.reviewItemId ?? hunk.sourceHunkId ?? hunk.id,
			status: reviewSource === 'reject' ? 'rejected' : 'accepted',
			reviewSource,
			displayStart,
			displayLines,
			baselineStart,
			currentStart,
			baselineContextBefore: baselineContext.before,
			baselineContextAfter: baselineContext.after,
			currentContextBefore: currentContext.before,
			currentContextAfter: currentContext.after,
			zoneAfterLineNumber: displayStart,
			reviewedAt: Date.now(),
			...(appliedAiSuggestion ? { appliedAiSuggestion } : {}),
		};
	}

	private decisionHunks(file: ReviewFileState): ReviewedHunk[] {
		return [...file.acceptedHunks, ...file.rejectedHunks];
	}

	private reconcileDecisionHunksForExternalChanges(file: ReviewFileState, externalHunks: ReviewHunk[]): void {
		if (externalHunks.length === 0) {
			return;
		}

		file.acceptedHunks = this.reconcileDecisionListForExternalChanges(file.acceptedHunks, externalHunks);
		file.rejectedHunks = this.reconcileDecisionListForExternalChanges(file.rejectedHunks, externalHunks);
	}

	private reconcileDecisionListForExternalChanges(decisions: ReviewedHunk[], externalHunks: ReviewHunk[]): ReviewedHunk[] {
		const reconciled: ReviewedHunk[] = [];
		for (const decision of decisions) {
			if (externalHunks.some((externalHunk) => this.externalHunkTouchesDecision(externalHunk, decision))) {
				continue;
			}

			reconciled.push({
				...decision,
				displayStart: this.mapDecisionStartAfterExternalChanges(decision.displayStart, externalHunks),
				currentStart: this.mapDecisionStartAfterExternalChanges(decision.currentStart, externalHunks),
			});
		}
		return reconciled;
	}

	private externalHunkTouchesDecision(externalHunk: ReviewHunk, decision: ReviewedHunk): boolean {
		const decisionStart = decision.displayStart;
		const decisionLines = decision.displayLines;
		if (decisionLines === 0) {
			if (externalHunk.oldLines === 0) {
				return externalHunk.oldStart === decisionStart;
			}
			return externalHunk.oldStart <= decisionStart && decisionStart < externalHunk.oldStart + externalHunk.oldLines;
		}

		const decisionEnd = decisionStart + decisionLines;
		if (externalHunk.oldLines === 0) {
			return decisionStart < externalHunk.oldStart && externalHunk.oldStart < decisionEnd;
		}

		const externalEnd = externalHunk.oldStart + externalHunk.oldLines;
		return externalHunk.oldStart < decisionEnd && decisionStart < externalEnd;
	}

	private mapDecisionStartAfterExternalChanges(line: number, externalHunks: ReviewHunk[]): number {
		let mappedLine = line;
		for (const hunk of [...externalHunks].sort((left, right) => left.oldStart - right.oldStart)) {
			if (hunk.oldLines === 0) {
				if (hunk.oldStart <= line) {
					mappedLine += hunk.newLines;
				}
			} else if (hunk.oldStart + hunk.oldLines <= line) {
				mappedLine += hunk.newLines - hunk.oldLines;
			}
		}
		return Math.max(0, mappedLine);
	}

	private async restoreDecisionsToPending(file: ReviewFileState): Promise<{ changedCurrent: boolean }> {
		const accepted = [...file.acceptedHunks].sort((left, right) => right.baselineStart - left.baselineStart);
		const rejected = [...file.rejectedHunks].sort((left, right) => right.currentStart - left.currentStart);
		if (accepted.length === 0 && rejected.length === 0) {
			return { changedCurrent: false };
		}

		for (const hunk of accepted) {
			if (!this.reviewedBaselineSideMatches(file.oldText, hunk, hunk.baselineStart, hunk.newLines, hunk.newText)) {
				throw new Error('A reviewed Cli Diff Review change no longer matches the baseline. Refresh the review and try again.');
			}
		}
		let baselineText = file.oldText;
		for (const hunk of accepted) {
			baselineText = replaceLineBlock(baselineText, hunk.baselineStart, hunk.newLines, hunk.oldText);
		}

		const current = await this.readCurrentText(file.uri);
		for (const hunk of rejected) {
			if (!this.reviewedCurrentSideMatches(current.text, hunk, hunk.currentStart, hunk.displayLines, hunk.oldText)) {
				throw new Error('A reviewed Cli Diff Review change no longer matches the current file. Refresh the review and try again.');
			}
		}
		let currentText = current.text;
		const currentRestorations = rejected.map((hunk) => ({
				start: hunk.currentStart,
				lines: hunk.displayLines,
				text: hunk.newText,
			})).sort((left, right) => right.start - left.start);
		for (const edit of currentRestorations) {
			currentText = replaceLineBlock(currentText, edit.start, edit.lines, edit.text);
		}
		const changedCurrent = currentRestorations.length > 0;

		file.oldText = baselineText;
		file.newText = currentText;
		file.currentExists = current.exists;
		this.syncBaselineExistsForPending(file);
		this.retainAppliedAiSuggestions(file, [...accepted, ...rejected].map((hunk) => hunk.appliedAiSuggestion));
		file.acceptedHunks = [];
		file.rejectedHunks = [];
		if (changedCurrent) {
			file.currentExists = true;
			await this.writeCurrentFileText(file.uri, currentText);
		}
		return { changedCurrent };
	}

	private syncDecisionHunksAfterEdit(
		file: ReviewFileState,
		manualHunks: ReviewHunk[],
		editedText: string,
		baselineManualHunks: ReviewHunk[],
		baselineText: string,
	): void {
		if (manualHunks.length === 0) {
			return;
		}

		file.acceptedHunks = file.acceptedHunks.map((hunk) => this.syncDecisionHunkAfterEdit(hunk, manualHunks, baselineManualHunks, editedText, baselineText));
		file.rejectedHunks = file.rejectedHunks.map((hunk) => this.syncDecisionHunkAfterEdit(hunk, manualHunks, baselineManualHunks, editedText, baselineText));
	}

	private syncDecisionHunkAfterEdit(
		hunk: ReviewedHunk,
		manualHunks: ReviewHunk[],
		baselineManualHunks: ReviewHunk[],
		editedText: string,
		baselineText: string,
	): ReviewedHunk {
		const baselineStart = mapLineAfterLineEdits(hunk.baselineStart, baselineManualHunks);
		let displayStart = this.mapPreviousLineToEditedLine(hunk.displayStart, manualHunks);
		let currentStart = this.mapPreviousLineToEditedLine(hunk.currentStart, manualHunks);
		let displayLines = hunk.displayLines;
		let touched = false;

		for (const manualHunk of manualHunks) {
			if (!this.lineSpansTouch(manualHunk.oldStart, manualHunk.oldLines, hunk.displayStart, hunk.displayLines)) {
				continue;
			}

			touched = true;
			displayLines += manualHunk.newLines - manualHunk.oldLines;
			if (manualHunk.oldStart < hunk.displayStart) {
				displayStart = Math.min(displayStart, manualHunk.newStart);
			}
			if (manualHunk.oldStart < hunk.currentStart) {
				currentStart = Math.min(currentStart, manualHunk.newStart);
			}
		}

		displayStart = Math.max(0, displayStart);
		currentStart = Math.max(0, currentStart);
		displayLines = Math.max(0, displayLines);
		if (!touched) {
			return this.refreshDecisionContexts({ ...hunk, baselineStart, displayStart, currentStart, zoneAfterLineNumber: displayStart }, baselineText, editedText);
		}

		const editedBlockText = this.lineBlock(editedText, displayStart, displayLines);
		if (hunk.reviewSource === 'reject') {
			return this.refreshDecisionContexts({
				...hunk,
				oldLines: displayLines,
				oldText: editedBlockText,
				baselineStart,
				displayStart,
				displayLines,
				currentStart,
				zoneAfterLineNumber: displayStart,
			}, baselineText, editedText);
		}

		return this.refreshDecisionContexts({
			...hunk,
			newLines: displayLines,
			newText: editedBlockText,
			baselineStart,
			displayStart,
			displayLines,
			currentStart,
			zoneAfterLineNumber: displayStart,
		}, baselineText, editedText);
	}

	private refreshDecisionContexts(hunk: ReviewedHunk, baselineText: string, currentText: string): ReviewedHunk {
		const baselineLines = hunk.reviewSource === 'accept' ? hunk.newLines : hunk.oldLines;
		const currentLines = hunk.reviewSource === 'reject' ? hunk.displayLines : hunk.newLines;
		const baselineContext = captureLineBlockContext(baselineText, hunk.baselineStart, baselineLines);
		const currentContext = captureLineBlockContext(currentText, hunk.currentStart, currentLines);
		return {
			...hunk,
			baselineContextBefore: baselineContext.before,
			baselineContextAfter: baselineContext.after,
			currentContextBefore: currentContext.before,
			currentContextAfter: currentContext.after,
			zoneAfterLineNumber: hunk.displayStart,
		};
	}

	private mapDecisionBaselineStarts(file: ReviewFileState, edits: Array<{ oldStart: number; oldLines: number; newLines: number }>): void {
		if (edits.length === 0) {
			return;
		}

		const mapHunk = (hunk: ReviewedHunk): ReviewedHunk => this.refreshDecisionContexts({
			...hunk,
			baselineStart: mapLineAfterFileEdits(hunk.baselineStart, edits),
		}, file.oldText, file.newText);
		file.acceptedHunks = file.acceptedHunks.map(mapHunk);
		file.rejectedHunks = file.rejectedHunks.map(mapHunk);
	}

	private mapDecisionCurrentStarts(file: ReviewFileState, edits: Array<{ oldStart: number; oldLines: number; newLines: number }>): void {
		if (edits.length === 0) {
			return;
		}

		const mapHunk = (hunk: ReviewedHunk): ReviewedHunk => {
			const currentStart = mapLineAfterFileEdits(hunk.currentStart, edits);
			const displayStart = mapLineAfterFileEdits(hunk.displayStart, edits);
			return this.refreshDecisionContexts({
				...hunk,
				currentStart,
				displayStart,
				zoneAfterLineNumber: displayStart,
			}, file.oldText, file.newText);
		};
		file.acceptedHunks = file.acceptedHunks.map(mapHunk);
		file.rejectedHunks = file.rejectedHunks.map(mapHunk);
	}

	private mapPreviousLineToEditedLine(line: number, manualHunks: ReviewHunk[]): number {
		let mappedLine = line;
		for (const hunk of [...manualHunks].sort((left, right) => left.oldStart - right.oldStart)) {
			if (hunk.oldStart < line && hunk.oldStart + hunk.oldLines <= line) {
				mappedLine += hunk.newLines - hunk.oldLines;
			}
		}
		return Math.max(0, mappedLine);
	}

	private lineBlock(text: string, startLine: number, lineCount: number): string {
		const lines = splitLines(text);
		const start = Math.max(0, Math.min(startLine, lines.length));
		const end = Math.max(start, Math.min(start + Math.max(0, lineCount), lines.length));
		return lines.slice(start, end).join('');
	}

	private lineBlockMatches(text: string, startLine: number, lineCount: number, expectedText: string): boolean {
		return this.lineBlock(text, startLine, lineCount) === expectedText;
	}

	private lineBlockAtCoordinateMatches(text: string, startLine: number, lineCount: number, expectedText: string): boolean {
		const lines = splitLines(text);
		const expectedLines = splitLines(expectedText);
		const start = Math.max(0, startLine);
		const count = Math.max(0, lineCount);
		return start === startLine
			&& expectedLines.length === count
			&& start <= lines.length
			&& start + count <= lines.length
			&& lines.slice(start, start + count).join('') === expectedText;
	}

	private originalHunkSideMatches(text: string, hunk: ReviewHunk, side: 'old' | 'new', startLine: number): boolean {
		const context = side === 'old'
			? { before: hunk.oldContextBefore, after: hunk.oldContextAfter }
			: { before: hunk.newContextBefore, after: hunk.newContextAfter };
		const lineCount = side === 'old' ? hunk.oldLines : hunk.newLines;
		const expectedText = side === 'old' ? hunk.oldText : hunk.newText;
		return lineBlockWithContextMatches(text, startLine, lineCount, expectedText, context);
	}

	private async refreshUnmatchedMutation(file: ReviewFileState): Promise<void> {
		await this.refreshFile(file.uri, { reconcileExternalChanges: false });
		vscode.window.showInformationMessage('Cli Diff Review refreshed because the change no longer matches the expected content. Please retry.');
	}

	private reviewedBaselineSideMatches(
		text: string,
		hunk: ReviewedHunk,
		startLine: number,
		lineCount: number,
		expectedText: string,
	): boolean {
		return lineBlockWithContextMatches(text, startLine, lineCount, expectedText, {
			before: hunk.baselineContextBefore,
			after: hunk.baselineContextAfter,
		}) || this.lineBlockAtCoordinateMatches(text, startLine, lineCount, expectedText);
	}

	private reviewedCurrentSideMatches(
		text: string,
		hunk: ReviewedHunk,
		startLine: number,
		lineCount: number,
		expectedText: string,
	): boolean {
		return lineBlockWithContextMatches(text, startLine, lineCount, expectedText, {
			before: hunk.currentContextBefore,
			after: hunk.currentContextAfter,
		}) || this.lineBlockAtCoordinateMatches(text, startLine, lineCount, expectedText);
	}

	private manualHunkTouchesPending(manualHunk: ReviewHunk, pendingHunks: ReviewHunk[], editedRanges: EditedRange[]): boolean {
		const hunkTouches = pendingHunks.some((pending) => (
			this.lineSpansTouch(manualHunk.oldStart, manualHunk.oldLines, pending.newStart, pending.newLines)
			|| this.lineSpansTouch(manualHunk.newStart, manualHunk.newLines, pending.newStart, pending.newLines)
		));
		if (hunkTouches) {
			return true;
		}

		return editedRanges.some((range) => pendingHunks.some((pending) => this.lineSpansTouch(
			range.startLine,
			Math.max(1, range.endLine - range.startLine),
			pending.newStart,
			pending.newLines,
		)));
	}

	private lineSpansTouch(leftStart: number, leftLines: number, rightStart: number, rightLines: number): boolean {
		const leftEnd = leftStart + Math.max(1, leftLines);
		const rightEnd = rightStart + Math.max(1, rightLines);
		return leftStart < rightEnd && rightStart < leftEnd;
	}

	private mapCurrentLineToBaseline(currentLine: number, pendingHunks: ReviewHunk[]): number {
		let baselineLine = currentLine;
		for (const hunk of [...pendingHunks].sort((left, right) => left.newStart - right.newStart)) {
			if (hunk.newStart + hunk.newLines <= currentLine) {
				baselineLine += hunk.oldLines - hunk.newLines;
			}
		}
		return Math.max(0, baselineLine);
	}

	private async readCurrentText(uri: vscode.Uri, options: { preferDisk?: boolean } = {}): Promise<{ exists: boolean; text: string }> {
		const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
		if (openDocument && (!options.preferDisk || openDocument.isDirty)) {
			return { exists: true, text: openDocument.getText() };
		}

		try {
			const data = await vscode.workspace.fs.readFile(uri);
			if (isProbablyBinary(data)) {
				return { exists: true, text: '' };
			}
			return { exists: true, text: decodeUtf8(data) };
		} catch {
			return { exists: false, text: '' };
		}
	}

	private async writeCurrentFileText(uri: vscode.Uri, text: string, source: InternalWriteSource = 'plugin'): Promise<void> {
		const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
		if (!openDocument) {
			this.humanEditBatches.delete(uriKey(uri));
			await this.withInternalWrite(uri, source, () => this.writeFileText(uri, text));
			return;
		}

		await this.withInternalWrite(uri, source, async () => {
			const edit = new vscode.WorkspaceEdit();
			const fullRange = new vscode.Range(new vscode.Position(0, 0), openDocument.positionAt(openDocument.getText().length));
			edit.replace(uri, fullRange, text);
			const applied = await vscode.workspace.applyEdit(edit);
			if (!applied) {
				throw new Error('VS Code rejected the workspace edit.');
			}
			await openDocument.save();
		});
	}

	private async synchronizeOpenDocumentAfterGitMutation(uri: vscode.Uri): Promise<void> {
		const document = vscode.workspace.textDocuments.find((candidate) => uriKey(candidate.uri) === uriKey(uri));
		if (!document || document.isDirty) {
			return;
		}
		const disk = await this.readCurrentText(uri, { preferDisk: true });
		if (!disk.exists) {
			const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => {
				const input = tab.input;
				return input instanceof vscode.TabInputText && uriKey(input.uri) === uriKey(uri);
			});
			if (tabs.length > 0) {
				await vscode.window.tabGroups.close(tabs, true);
			}
			return;
		}
		if (document.getText() === disk.text) {
			return;
		}
		await this.withInternalWrite(uri, 'plugin', async () => {
			const edit = new vscode.WorkspaceEdit();
			const fullRange = new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length));
			edit.replace(uri, fullRange, disk.text);
			if (!await vscode.workspace.applyEdit(edit)) {
				throw new Error('VS Code could not synchronize the open editor after the Git change.');
			}
			await document.save();
		});
	}

	private async deleteCurrentFile(uri: vscode.Uri): Promise<void> {
		this.humanEditBatches.delete(uriKey(uri));
		await this.withInternalWrite(uri, 'plugin', async () => {
			try {
				await vscode.workspace.fs.stat(uri);
			} catch {
				return;
			}
			await vscode.workspace.fs.delete(uri);
		});
	}

	private async writeFileText(uri: vscode.Uri, text: string): Promise<void> {
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
		await vscode.workspace.fs.writeFile(uri, encodeUtf8(text));
	}

	private async pickWorkspaceFolder(placeHolder = 'Select a workspace folder for Git review'): Promise<vscode.WorkspaceFolder | undefined> {
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (folders.length <= 1) {
			return folders[0];
		}

		const picked = await vscode.window.showQuickPick(folders.map((folder) => ({
			label: folder.name,
			description: folder.uri.fsPath,
			folder,
		})), { placeHolder });
		return picked?.folder;
	}

	private createFileWatcher(): vscode.Disposable {
		const watcher = vscode.workspace.createFileSystemWatcher('**/*');
		const disposable = new vscode.Disposable(() => watcher.dispose());
		this.disposables.push(
			watcher.onDidChange((uri) => this.handleFileSystemChange(uri)),
			watcher.onDidCreate((uri) => this.handleFileSystemChange(uri)),
			watcher.onDidDelete((uri) => this.handleFileSystemChange(uri)),
		);
		return disposable;
	}

	private createGitMetadataWatcher(): vscode.Disposable {
		const watchers = [
			vscode.workspace.createFileSystemWatcher('**/.git/index'),
			vscode.workspace.createFileSystemWatcher('**/.git/HEAD'),
			vscode.workspace.createFileSystemWatcher('**/.git/refs/**'),
			vscode.workspace.createFileSystemWatcher('**/.git/packed-refs'),
		];
		const disposables: vscode.Disposable[] = [];
		for (const watcher of watchers) {
			disposables.push(
				watcher,
				watcher.onDidChange(() => this.scheduleGitSessionRefresh()),
				watcher.onDidCreate(() => this.scheduleGitSessionRefresh()),
				watcher.onDidDelete(() => this.scheduleGitSessionRefresh()),
			);
		}

		return new vscode.Disposable(() => {
			for (const disposable of disposables) {
				disposable.dispose();
			}
		});
	}

	private createGitExtensionStateWatcher(): vscode.Disposable {
		const disposables: vscode.Disposable[] = [];
		let disposed = false;
		const registerRepository = (repository: any): void => {
			if (disposed) {
				return;
			}

			const onDidChange = repository?.state?.onDidChange;
			if (typeof onDidChange === 'function') {
				let signature = gitExtensionStateSignature(repository?.state);
				disposables.push(onDidChange(() => {
					const next = gitExtensionStateSignature(repository?.state);
					if (next === signature) {
						return;
					}
					signature = next;
					this.scheduleGitSessionRefresh();
				}));
			}
		};

		const gitExtension = vscode.extensions.getExtension('vscode.git');
		if (gitExtension) {
			void Promise.resolve(gitExtension.activate()).then((api: any) => {
				if (disposed) {
					return;
				}

				const git = api?.getAPI?.(1);
				if (!git) {
					return;
				}

				for (const repository of git.repositories ?? []) {
					registerRepository(repository);
				}
				if (typeof git.onDidOpenRepository === 'function') {
					disposables.push(git.onDidOpenRepository(registerRepository));
				}
			}).catch(() => undefined);
		}

		return new vscode.Disposable(() => {
			disposed = true;
			for (const disposable of disposables) {
				disposable.dispose();
			}
		});
	}

	private registerCommand(command: string, callback: (...args: any[]) => unknown): vscode.Disposable {
		return vscode.commands.registerCommand(command, callback);
	}

	private showError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`Cli Diff Review: ${message}`);
	}
}

function trackingTargetStorageKey(rootUri: vscode.Uri): string {
	return `cliDiff.trackingTarget.${rootUri.toString()}`;
}

function branchExtractionStorageKey(rootUri: vscode.Uri): string {
	return `cliDiff.branchExtraction.v1.${rootUri.toString()}`;
}

function uriIsInside(rootUri: vscode.Uri, uri: vscode.Uri): boolean {
	const relative = path.relative(rootUri.fsPath, uri.fsPath);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function gitExtensionStateSignature(state: any): string {
	const changes = (items: any[] | undefined) => (items ?? []).map((item) => [
		item?.uri?.toString?.() ?? '',
		item?.originalUri?.toString?.() ?? '',
		item?.renameUri?.toString?.() ?? '',
		item?.status ?? '',
	]);
	return JSON.stringify({
		head: state?.HEAD?.commit ?? state?.HEAD?.name ?? '',
		index: changes(state?.indexChanges),
		working: changes(state?.workingTreeChanges),
		merge: changes(state?.mergeChanges),
		untracked: changes(state?.untrackedChanges),
	});
}
