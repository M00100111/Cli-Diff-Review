import * as path from 'path';
import * as vscode from 'vscode';
import { acceptHunkInBaseline, computeLineDiff } from './diffEngine';
import { GitService } from './gitService';
import { buildReviewDashboardPayload, ReviewDashboardProvider } from './reviewDashboard';
import { ReviewTreeProvider } from './reviewTree';
import {
	EditedRange,
	ReviewNavigationAction,
	ReviewNavigationRequestType,
	ReviewNavigationResponse,
	ReviewNavigationTargetPayload,
	ReviewWebviewManager,
} from './reviewWebview';
import { gitIgnoredReviewPaths, shouldSkipReviewPath } from './reviewFileFilter';
import {
	applyManualGitBaselineToPair,
	captureLineBlockContext,
	CurrentTextState,
	GitManualBaseline,
	isStaleRevision,
	lineBlockWithContextMatchesUniquely,
	mapLineAfterFileEdits,
	mapLineAfterLineEdits,
	manualGitBaselineFromReviewedFile,
	SerialOperationQueue,
	shouldDeleteRejectedCurrentFileOnRefresh,
	shouldMergeReviewedFileOnRefresh,
	skippedCurrentFile,
} from './reviewState';
import { SnapshotStore } from './snapshotStore';
import { decodeUtf8, encodeUtf8, isProbablyBinary, lineRange, relativePath, replaceLineBlock, splitLines } from './text';
import { FilePair, ReviewedHunk, ReviewFileState, ReviewHunk, ReviewSession, ReviewSource, uriKey } from './types';

type InternalWriteSource = 'plugin' | 'human';

type GitSessionRefreshRequest =
	| { source: 'manual' }
	| { source: 'gitIndexChanged'; indexStateSignature: string };

interface ReviewNavigationTarget extends vscode.QuickPickItem {
	uri: vscode.Uri;
	range: vscode.Range;
}

export class ReviewController implements vscode.Disposable {
	private readonly snapshotStore: SnapshotStore;
	private readonly gitService = new GitService();
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
	private readonly manualGitBaselines = new Map<string, GitManualBaseline>();
	private gitRefreshTimer: NodeJS.Timeout | undefined;
	private gitIndexStateSignature: string | undefined;
	private currentReviewUri: vscode.Uri | undefined;
	private activeSession: ReviewSession | undefined;

	public constructor(private readonly context: vscode.ExtensionContext) {
		this.snapshotStore = new SnapshotStore(context);
		this.treeProvider = new ReviewTreeProvider(() => this.activeSession);
		this.dashboardProvider = new ReviewDashboardProvider(() => buildReviewDashboardPayload(
			this.activeSession,
			this.currentReviewUri,
			(uri) => this.isOpenDocumentDirty(uri),
		));
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
			this.createFileWatcher(),
			this.createGitMetadataWatcher(),
			this.createGitExtensionStateWatcher(),
			this.registerCommand('cli-diff.captureBaseline', () => this.captureBaseline()),
			this.registerCommand('cli-diff.startSnapshotReview', () => this.startSnapshotReview()),
			this.registerCommand('cli-diff.startGitReview', () => this.startGitReview()),
			this.registerCommand('cli-diff.acceptChange', (uri?: string, hunkId?: string, revision?: number) => this.acceptChange(uri, hunkId, revision)),
			this.registerCommand('cli-diff.rejectChange', (uri?: string, hunkId?: string, revision?: number) => this.rejectChange(uri, hunkId, revision)),
			this.registerCommand('cli-diff.restoreChange', (uri?: string, hunkId?: string, revision?: number) => this.restoreChange(uri, hunkId, revision)),
			this.registerCommand('cli-diff.acceptFile', (uri?: string | ReviewFileState) => this.acceptFile(uri)),
			this.registerCommand('cli-diff.rejectFile', (uri?: string | ReviewFileState) => this.rejectFile(uri)),
			this.registerCommand('cli-diff.undoFile', (uri?: string | ReviewFileState) => this.undoFile(uri)),
			this.registerCommand('cli-diff.nextChange', (uri?: string, hunkId?: string) => this.navigateChange(1, uri, hunkId)),
			this.registerCommand('cli-diff.previousChange', (uri?: string, hunkId?: string) => this.navigateChange(-1, uri, hunkId)),
			this.registerCommand('cli-diff.openReviewView', (uri?: string) => this.openReviewView(uri)),
			this.registerCommand('cli-diff.openFileAtChange', (uri: string, hunkId: string) => this.openFileAtChange(uri, hunkId)),
			this.registerCommand('cli-diff.refresh', () => this.refreshAll()),
		);
		void vscode.commands.executeCommand('setContext', 'cliDiff:hasSession', false);
		void this.startAutomaticGitReview();
		void this.ensureVisibleEditorsReviewed();
	}

	public dispose(): void {
		if (this.gitRefreshTimer) {
			clearTimeout(this.gitRefreshTimer);
			this.gitRefreshTimer = undefined;
		}
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

	private async captureBaseline(): Promise<void> {
		try {
			const count = await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: 'CLI Diff: capturing baseline',
				cancellable: false,
			}, () => this.snapshotStore.captureWorkspaceBaseline());
			vscode.window.showInformationMessage(`CLI Diff baseline captured (${count} files).`);
		} catch (error) {
			this.showError(error);
		}
	}

	private async startSnapshotReview(): Promise<void> {
		try {
			const baselineFiles = await this.snapshotStore.loadBaselineFiles();
			const currentByUri = await this.readCurrentWorkspaceFiles();
			const pairs = new Map<string, FilePair>();

			for (const file of baselineFiles) {
				const current = currentByUri.get(uriKey(file.uri));
				pairs.set(uriKey(file.uri), {
					uri: file.uri,
					relativePath: file.relativePath,
					oldText: file.text,
					newText: current?.text ?? '',
					baselineExists: file.exists,
					currentExists: current?.exists ?? false,
					skippedReason: current?.skippedReason,
				});
			}

			for (const current of currentByUri.values()) {
				if (!pairs.has(uriKey(current.uri))) {
					pairs.set(uriKey(current.uri), {
						uri: current.uri,
						relativePath: current.relativePath,
						oldText: '',
						newText: current.text,
						baselineExists: false,
						currentExists: true,
						skippedReason: current.skippedReason,
					});
				}
			}

			await this.startSession('snapshot', [...pairs.values()]);
		} catch (error) {
			this.showError(error);
		}
	}

	private async startGitReview(): Promise<void> {
		try {
			const folder = await this.pickWorkspaceFolder();
			if (!folder) {
				return;
			}

			const pairs = await this.gitService.createFilePairs(folder);
			await this.startSession('git', pairs, folder.uri);
		} catch (error) {
			this.showError(error);
		}
	}

	private async startAutomaticGitReview(): Promise<void> {
		if (!vscode.workspace.getConfiguration('cliDiff').get<boolean>('autoStartGitReview', true)) {
			return;
		}

		const folders = vscode.workspace.workspaceFolders ?? [];
		for (const folder of folders) {
			try {
				const pairs = await this.gitService.createFilePairs(folder);
				await this.startSession('git', pairs, folder.uri, false);
				await this.ensureVisibleEditorsReviewed();
				return;
			} catch {
				// Ignore non-Git workspace folders during automatic startup.
			}
		}
	}

	private async startSession(mode: 'git' | 'snapshot', pairs: FilePair[], rootUri?: vscode.Uri, notify = true): Promise<void> {
		const workspaceRoot = rootUri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!workspaceRoot) {
			throw new Error('Open a workspace folder before starting a review.');
		}

		this.manualGitBaselines.clear();
		const files = new Map<string, ReviewFileState>();
		for (const pair of pairs) {
			const file = this.createFileState(pair);
			if (file.hunks.length > 0 || file.skippedReason) {
				files.set(uriKey(file.uri), file);
			}
		}

		this.activeSession = {
			id: `${mode}-${Date.now()}`,
			mode,
			rootUri: workspaceRoot,
			createdAt: Date.now(),
			files,
		};
		if (mode === 'git') {
			await this.updateGitIndexStateSignature();
		} else {
			this.gitIndexStateSignature = undefined;
		}

		await vscode.commands.executeCommand('setContext', 'cliDiff:hasSession', true);
		this.refreshUi();
		const hunkCount = [...files.values()].reduce((total, file) => total + file.hunks.length, 0);
		if (notify) {
			vscode.window.showInformationMessage(`CLI Diff ${mode} review started (${files.size} files, ${hunkCount} changes).`);
		}
	}

	private createFileState(pair: FilePair): ReviewFileState {
		if (pair.skippedReason) {
			return {
				uri: pair.uri,
				relativePath: pair.relativePath,
				oldText: pair.oldText,
				newText: pair.newText,
				hunks: [],
				acceptedHunks: [],
				rejectedHunks: [],
				originalText: pair.oldText,
				originalExists: pair.baselineExists,
				baselineExists: pair.baselineExists,
				currentExists: pair.currentExists,
				revision: 0,
				skippedReason: pair.skippedReason,
			};
		}

		const diff = this.computeReviewHunks(pair.uri, pair.oldText, pair.newText);
		if (diff.skippedReason) {
			return {
				uri: pair.uri,
				relativePath: pair.relativePath,
				oldText: pair.oldText,
				newText: pair.newText,
				hunks: [],
				acceptedHunks: [],
				rejectedHunks: [],
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
			oldText: pair.oldText,
			newText: pair.newText,
			hunks: diff.hunks,
			acceptedHunks: [],
			rejectedHunks: [],
			originalText: pair.oldText,
			originalExists: pair.baselineExists,
			baselineExists: pair.baselineExists,
			currentExists: pair.currentExists,
			revision: 0,
		};
	}

	private createManualBaselineFileState(uri: vscode.Uri, text: string): ReviewFileState {
		const rootUri = this.activeSession?.rootUri ?? vscode.workspace.getWorkspaceFolder(uri)?.uri ?? vscode.Uri.file(path.dirname(uri.fsPath));
		return {
			uri,
			relativePath: relativePath(rootUri, uri),
			oldText: text,
			newText: text,
			hunks: [],
			acceptedHunks: [],
			rejectedHunks: [],
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
		this.manualGitBaselines.clear();
		this.activeSession = {
			id: `git-${Date.now()}`,
			mode: 'git',
			rootUri: folder?.uri ?? vscode.Uri.file(path.dirname(uri.fsPath)),
			createdAt: Date.now(),
			files: new Map<string, ReviewFileState>(),
		};
		await this.updateGitIndexStateSignature();
		await vscode.commands.executeCommand('setContext', 'cliDiff:hasSession', true);
	}

	private async acceptChange(uriString?: string, hunkId?: string, expectedRevision?: number): Promise<void> {
		await this.enqueueFileOperation(this.operationUri(uriString), () => this.acceptChangeCore(uriString, hunkId, expectedRevision));
	}

	private async acceptChangeCore(uriString?: string, hunkId?: string, expectedRevision?: number): Promise<void> {
		try {
			const preflightFile = this.resolveFile(uriString);
			if (preflightFile && this.isStaleMutation(preflightFile, expectedRevision)) {
				await this.refreshFile(preflightFile.uri, { reconcileExternalChanges: false });
				return;
			}
			if (preflightFile && typeof expectedRevision !== 'number') {
				await this.refreshFile(preflightFile.uri);
			}

			const target = this.resolveHunk(uriString, hunkId);
			if (!target) {
				vscode.window.showInformationMessage('No CLI Diff change selected.');
				return;
			}

			if (this.isStaleMutation(target.file, expectedRevision)) {
				await this.refreshFile(target.file.uri, { reconcileExternalChanges: false });
				return;
			}
			if (!this.ensureFileCleanForReviewMutation(target.file)) {
				return;
			}
			if (!this.originalHunkSideMatches(target.file.oldText, target.hunk, 'old', target.hunk.oldStart)) {
				await this.refreshFile(target.file.uri, { reconcileExternalChanges: false });
				return;
			}

			target.file.oldText = acceptHunkInBaseline(target.file.oldText, target.hunk);
			this.mapDecisionBaselineStarts(target.file, [{
				oldStart: target.hunk.oldStart,
				oldLines: target.hunk.oldLines,
				newLines: target.hunk.newLines,
			}]);
			this.recordDecisionHunk(target.file, target.hunk, 'accept', target.hunk.newStart, target.hunk.newLines, target.hunk.oldStart, target.hunk.newStart);
			this.syncBaselineExistsAfterAccept(target.file);
			this.touchFileRevision(target.file);
			if (this.activeSession?.mode === 'snapshot') {
				await this.updateSnapshotBaselineFile(target.file);
			}
			await this.refreshFile(target.file.uri, { reconcileExternalChanges: false });
		} catch (error) {
			this.showError(error);
		}
	}

	private async rejectChange(uriString?: string, hunkId?: string, expectedRevision?: number): Promise<void> {
		await this.enqueueFileOperation(this.operationUri(uriString), () => this.rejectChangeCore(uriString, hunkId, expectedRevision));
	}

	private async rejectChangeCore(uriString?: string, hunkId?: string, expectedRevision?: number): Promise<void> {
		try {
			const preflightFile = this.resolveFile(uriString);
			if (preflightFile && this.isStaleMutation(preflightFile, expectedRevision)) {
				await this.refreshFile(preflightFile.uri, { reconcileExternalChanges: false });
				return;
			}
			if (preflightFile && typeof expectedRevision !== 'number') {
				await this.refreshFile(preflightFile.uri);
			}

			const target = this.resolveHunk(uriString, hunkId);
			if (!target) {
				vscode.window.showInformationMessage('No CLI Diff change selected.');
				return;
			}

			if (this.isStaleMutation(target.file, expectedRevision)) {
				await this.refreshFile(target.file.uri, { reconcileExternalChanges: false });
				return;
			}
			if (!this.ensureFileCleanForReviewMutation(target.file)) {
				return;
			}
			if (!target.file.currentExists) {
				await this.withInternalWrite(target.file.uri, 'plugin', () => this.writeFileText(target.file.uri, target.file.oldText));
				target.file.newText = target.file.oldText;
				target.file.currentExists = true;
				this.mapDecisionCurrentStarts(target.file, [{
					oldStart: target.hunk.newStart,
					oldLines: target.hunk.newLines,
					newLines: target.hunk.oldLines,
				}]);
				this.recordDecisionHunk(target.file, target.hunk, 'reject', target.hunk.oldStart, target.hunk.oldLines, target.hunk.oldStart, target.hunk.oldStart);
				this.touchFileRevision(target.file);
				await this.refreshFile(target.file.uri, { reconcileExternalChanges: false });
				return;
			}

			const document = await vscode.workspace.openTextDocument(target.file.uri);
			if (!this.originalHunkSideMatches(document.getText(), target.hunk, 'new', target.hunk.newStart)) {
				await this.refreshFile(target.file.uri, { reconcileExternalChanges: false });
				return;
			}

			const rejectedText = replaceLineBlock(document.getText(), target.hunk.newStart, target.hunk.newLines, target.hunk.oldText);
			const wasDirty = document.isDirty;
			await this.withInternalWrite(target.file.uri, 'plugin', async () => {
				const edit = new vscode.WorkspaceEdit();
				edit.replace(target.file.uri, lineRange(document, target.hunk.newStart, target.hunk.newLines), target.hunk.oldText);
				const applied = await vscode.workspace.applyEdit(edit);
				if (!applied) {
					throw new Error('VS Code rejected the workspace edit.');
				}

				if (!wasDirty) {
					await document.save();
				}
			});
			target.file.newText = rejectedText;
			target.file.currentExists = true;
			this.mapDecisionCurrentStarts(target.file, [{
				oldStart: target.hunk.newStart,
				oldLines: target.hunk.newLines,
				newLines: target.hunk.oldLines,
			}]);
			this.recordDecisionHunk(target.file, target.hunk, 'reject', target.hunk.newStart, target.hunk.oldLines, target.hunk.oldStart, target.hunk.newStart);
			this.touchFileRevision(target.file);
			await this.refreshFile(target.file.uri, { reconcileExternalChanges: false });
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
				vscode.window.showInformationMessage('No accepted or rejected CLI Diff change selected.');
				return;
			}
			if (this.isStaleMutation(target.file, expectedRevision)) {
				await this.refreshFile(target.file.uri, { reconcileExternalChanges: false });
				return;
			}
			if (!this.ensureFileCleanForReviewMutation(target.file)) {
				return;
			}

			if (target.list === 'accepted') {
				const baselineStart = target.hunk.baselineStart;
				if (!this.reviewedBaselineSideMatches(target.file.oldText, target.hunk, baselineStart, target.hunk.newLines, target.hunk.newText)) {
					await this.refreshFile(target.file.uri, { reconcileExternalChanges: false });
					return;
				}
				target.file.oldText = replaceLineBlock(target.file.oldText, baselineStart, target.hunk.newLines, target.hunk.oldText);
				target.file.acceptedHunks = target.file.acceptedHunks.filter((item) => item.id !== target.hunk.id);
				this.mapDecisionBaselineStarts(target.file, [{
					oldStart: baselineStart,
					oldLines: target.hunk.newLines,
					newLines: target.hunk.oldLines,
				}]);
				this.syncBaselineExistsForPending(target.file);
				if (this.activeSession?.mode === 'snapshot') {
					await this.updateSnapshotBaselineFile(target.file);
				}
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
			}

			this.touchFileRevision(target.file);
			await this.refreshFile(target.file.uri, { reconcileExternalChanges: false });
		} catch (error) {
			this.showError(error);
		}
	}

	private async acceptFile(uriString?: string | ReviewFileState): Promise<void> {
		await this.enqueueFileOperation(this.operationUri(uriString), () => this.acceptFileCore(uriString));
	}

	private async acceptFileCore(uriString?: string | ReviewFileState): Promise<void> {
		try {
			const file = this.resolveFile(uriString);
			if (!file) {
				vscode.window.showInformationMessage('No CLI Diff file selected.');
				return;
			}
			if (!this.ensureFileCleanForReviewMutation(file)) {
				return;
			}

			const current = await this.readCurrentText(file.uri);
			file.newText = current.text;
			file.currentExists = current.exists;
			const pendingHunks = [...file.hunks];
			if (pendingHunks.some((hunk) => !this.originalHunkSideMatches(file.oldText, hunk, 'old', hunk.oldStart))) {
				await this.refreshFile(file.uri, { reconcileExternalChanges: false });
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
			this.touchFileRevision(file);
			if (this.activeSession?.mode === 'snapshot') {
				await this.updateSnapshotBaselineFile(file);
			}
			await this.refreshFile(file.uri, { reconcileExternalChanges: false });
		} catch (error) {
			this.showError(error);
		}
	}

	private async rejectFile(uriString?: string | ReviewFileState): Promise<void> {
		await this.enqueueFileOperation(this.operationUri(uriString), () => this.rejectFileCore(uriString));
	}

	private async rejectFileCore(uriString?: string | ReviewFileState): Promise<void> {
		try {
			const file = this.resolveFile(uriString);
			if (!file) {
				vscode.window.showInformationMessage('No CLI Diff file selected.');
				return;
			}
			if (!this.ensureFileCleanForReviewMutation(file)) {
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
				await this.refreshFile(refreshedFile.uri, { reconcileExternalChanges: false });
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
			this.touchFileRevision(refreshedFile);

			await this.writeCurrentFileText(refreshedFile.uri, currentText);
			await this.refreshFile(refreshedFile.uri, { reconcileExternalChanges: false });
		} catch (error) {
			this.showError(error);
		}
	}

	private async undoFile(uriString?: string | ReviewFileState): Promise<void> {
		await this.enqueueFileOperation(this.operationUri(uriString), () => this.undoFileCore(uriString));
	}

	private async undoFileCore(uriString?: string | ReviewFileState): Promise<void> {
		try {
			const file = this.resolveFile(uriString);
			if (!file) {
				vscode.window.showInformationMessage('No CLI Diff file selected.');
				return;
			}
			if (!this.ensureFileCleanForReviewMutation(file)) {
				return;
			}

			await this.restoreDecisionsToPending(file);
			if (this.activeSession?.mode === 'snapshot') {
				await this.updateSnapshotBaselineFile(file);
			}
			this.touchFileRevision(file);
			await this.refreshFile(file.uri, { reconcileExternalChanges: false });
		} catch (error) {
			this.showError(error);
		}
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

			this.applyManualEditsToBaseline(file, editedText, editedRanges);
			this.touchFileRevision(file);
			await this.writeCurrentFileText(uri, editedText, 'human');

			if (this.activeSession?.mode === 'snapshot') {
				await this.updateSnapshotBaselineFile(file);
			}

			await this.refreshFile(file.uri, { reconcileExternalChanges: false });
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
			let file = this.resolveFile(document.uri.toString());
			if (!file) {
				file = this.createManualBaselineFileState(document.uri, document.getText());
				this.activeSession?.files.set(key, file);
				if (this.activeSession?.mode === 'snapshot') {
					await this.updateSnapshotBaselineFile(file);
				}
				this.refreshUi();
				return;
			}

			this.applyManualEditsToBaseline(file, document.getText(), editedRanges);
			this.touchFileRevision(file);
			if (this.activeSession?.mode === 'snapshot') {
				await this.updateSnapshotBaselineFile(file);
			}
			await this.refreshFile(file.uri, { reconcileExternalChanges: false });
		} catch (error) {
			this.showError(error);
		}
	}

	private applyManualEditsToBaseline(file: ReviewFileState, editedText: string, editedRanges: EditedRange[]): void {
		const previousCurrent = file.newText;
		const pendingBefore = [...file.hunks];
		const manualHunks = computeLineDiff(file.uri.toString(), previousCurrent, editedText);
		const baselineManualHunks: ReviewHunk[] = [];
		let baselineText = file.oldText;

		for (const manualHunk of [...manualHunks].sort((left, right) => right.oldStart - left.oldStart)) {
			if (this.manualHunkTouchesPending(manualHunk, pendingBefore, editedRanges)) {
				continue;
			}

			const baselineStart = this.mapCurrentLineToBaseline(manualHunk.oldStart, pendingBefore);
			baselineManualHunks.push({ ...manualHunk, oldStart: baselineStart, newStart: baselineStart });
			baselineText = replaceLineBlock(baselineText, baselineStart, manualHunk.oldLines, manualHunk.newText);
		}

		this.syncDecisionHunksAfterEdit(file, manualHunks, editedText, baselineManualHunks, baselineText);
		file.oldText = baselineText;
		file.newText = editedText;
		file.currentExists = true;
	}

	private async navigateChange(direction: 1 | -1, uriString?: string, hunkId?: string): Promise<void> {
		const hunks = this.flattenHunks();
		if (hunks.length === 0) {
			vscode.window.showInformationMessage('No CLI Diff changes to navigate.');
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
		await this.reviewWebview.open(uri);
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
		if (this.activeSession?.mode === 'git') {
			await this.refreshFile(uri, { preferDisk: true });
		}

		const file = this.activeSession?.files.get(uriKey(uri));
		if (this.isReviewableFile(file)) {
			await this.reviewWebview.open(uri, { line: range.start.line, column: range.start.character });
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
		if (!file || !hunk) {
			return;
		}

		const document = await vscode.workspace.openTextDocument(file.uri);
		const editor = await vscode.window.showTextDocument(document);
		const range = lineRange(document, hunk.newStart, hunk.newLines);
		editor.selection = new vscode.Selection(range.start, range.start);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	}

	private async refreshAll(): Promise<void> {
		await this.ensureVisibleEditorsReviewed();

		if (!this.activeSession) {
			return;
		}

		const files = [...this.activeSession.files.values()];
		if (this.activeSession.mode === 'git') {
			for (const file of files) {
				await this.deleteRejectedCurrentFileOnRefresh(file);
			}
			await this.refreshGitSessionFiles({ source: 'manual' });
			return;
		}

		for (const file of files) {
			await this.deleteRejectedCurrentFileOnRefresh(file);
			await this.refreshFile(file.uri, { preferDisk: true });
			const refreshedFile = this.activeSession?.files.get(uriKey(file.uri));
			if (refreshedFile && shouldMergeReviewedFileOnRefresh(
				refreshedFile.hunks.length,
				refreshedFile.acceptedHunks.length,
				refreshedFile.rejectedHunks.length,
				refreshedFile.skippedReason,
			)) {
				await this.mergeReviewedSnapshotFileOnRefresh(refreshedFile);
			}
		}
	}

	private async mergeReviewedSnapshotFileOnRefresh(file: ReviewFileState): Promise<void> {
		file.acceptedHunks = [];
		file.rejectedHunks = [];
		this.touchFileRevision(file);
		await this.updateSnapshotBaselineFile(file);
		await this.refreshFile(file.uri, { reconcileExternalChanges: false, preferDisk: true });
	}

	private async deleteRejectedCurrentFileOnRefresh(file: ReviewFileState): Promise<void> {
		if (this.isOpenDocumentDirty(file.uri)) {
			return;
		}

		const current = await this.readCurrentText(file.uri, { preferDisk: true });
		if (!current.exists || !shouldDeleteRejectedCurrentFileOnRefresh(file.baselineExists, current.text, file.acceptedHunks.length, file.rejectedHunks.length)) {
			return;
		}

		await this.deleteCurrentFile(file.uri);
		file.newText = '';
		file.currentExists = false;
	}

	private async refreshGitSessionFiles(request: GitSessionRefreshRequest): Promise<void> {
		if (!this.activeSession || this.activeSession.mode !== 'git') {
			return;
		}

		const folder = this.activeGitWorkspaceFolder();
		if (!folder) {
			return;
		}

		const previousFiles = this.activeSession.files;
		if (request.source === 'manual') {
			this.captureManualGitBaselines(previousFiles);
		} else {
			this.manualGitBaselines.clear();
		}
		const pairs = await this.gitService.createFilePairs(folder);
		const nextFiles = new Map<string, ReviewFileState>();
		const seenKeys = new Set<string>();
		for (const pair of pairs) {
			const key = uriKey(pair.uri);
			seenKeys.add(key);
			const manualBaseline = request.source === 'manual'
				? this.manualGitBaselineForPair(pair)
				: undefined;
			const file = this.createFileState(applyManualGitBaselineToPair(pair, manualBaseline));
			if (file.hunks.length > 0 || file.skippedReason) {
				const previous = previousFiles.get(key);
				if (previous) {
					file.revision = previous.revision + 1;
				}
				nextFiles.set(key, file);
			} else if (manualBaseline) {
				const previous = previousFiles.get(key);
				if (previous) {
					file.revision = previous.revision + 1;
				}
				nextFiles.set(key, file);
			}
		}
		if (request.source === 'manual') {
			this.pruneManualGitBaselines(seenKeys);
		}
		this.activeSession.files = nextFiles;
		this.gitIndexStateSignature = request.source === 'gitIndexChanged'
			? request.indexStateSignature
			: await this.gitService.indexStateSignature(folder);
		this.refreshUi();
	}

	private captureManualGitBaselines(files: Map<string, ReviewFileState>): void {
		for (const [key, file] of files) {
			const baseline = manualGitBaselineFromReviewedFile(file);
			if (baseline) {
				this.manualGitBaselines.set(key, baseline);
			}
		}
	}

	private manualGitBaselineForPair(pair: FilePair): GitManualBaseline | undefined {
		const key = uriKey(pair.uri);
		const baseline = this.manualGitBaselines.get(key);
		if (!baseline) {
			return undefined;
		}

		if (pair.skippedReason) {
			this.manualGitBaselines.delete(key);
			return undefined;
		}

		return baseline;
	}

	private pruneManualGitBaselines(seenKeys: Set<string>): void {
		for (const key of this.manualGitBaselines.keys()) {
			if (!seenKeys.has(key)) {
				this.manualGitBaselines.delete(key);
			}
		}
	}

	private async refreshFile(uri: vscode.Uri, options: { reconcileExternalChanges?: boolean; preferDisk?: boolean } = {}): Promise<void> {
		if (uri.scheme !== 'file') {
			return;
		}

		if (!this.activeSession) {
			await this.ensureGitReviewForUri(uri, { preferDisk: options.preferDisk });
			return;
		}

		const key = uriKey(uri);
		if (options.reconcileExternalChanges !== false && this.isOpenDocumentDirty(uri)) {
			return;
		}

		let file = this.activeSession.files.get(key);
		if (!file) {
			if (this.activeSession.mode !== 'git') {
				return;
			}

			const pair = await this.createGitFilePair(uri, { preferDisk: options.preferDisk });
			if (!pair) {
				return;
			}

			file = this.createFileState(pair);
			if (file.hunks.length === 0 && !file.skippedReason && !this.manualGitBaselines.has(key)) {
				return;
			}
			this.activeSession.files.set(key, file);
			this.refreshUi();
			return;
		}

		const previousState = this.fileStateFingerprint(file);
		const current = await this.readCurrentText(uri, { preferDisk: options.preferDisk });
		if (options.reconcileExternalChanges !== false && current.text !== file.newText && this.decisionHunks(file).length > 0) {
			const externalHunks = computeLineDiff(file.uri.toString(), file.newText, current.text);
			this.reconcileDecisionHunksForExternalChanges(file, externalHunks);
		}
		const manualBaseline = this.activeSession.mode === 'git'
			? this.manualGitBaselines.get(key)
			: undefined;
		if (manualBaseline && !file.skippedReason) {
			file.oldText = manualBaseline.oldText;
			file.baselineExists = manualBaseline.baselineExists;
			file.originalText = manualBaseline.oldText;
			file.originalExists = manualBaseline.baselineExists;
		}
		file.newText = current.text;
		file.currentExists = current.exists;
		const diff = this.computeReviewHunks(file.uri, file.oldText, file.newText);
		if (this.activeSession.mode === 'git' && diff.skippedReason) {
			this.manualGitBaselines.delete(key);
		}
		file.hunks = diff.hunks;
		file.skippedReason = diff.skippedReason;
		if (file.hunks.length === 0 && this.decisionHunks(file).length === 0 && !file.skippedReason && !this.manualGitBaselines.has(key)) {
			this.activeSession.files.delete(key);
		}
		if (previousState !== this.fileStateFingerprint(file)) {
			this.touchFileRevision(file);
		}
		this.refreshUi();
	}

	private computeReviewHunks(uri: vscode.Uri, oldText: string, newText: string): { hunks: ReviewHunk[]; skippedReason?: string } {
		const config = vscode.workspace.getConfiguration('cliDiff');
		const maxFileBytes = config.get<number>('maxFileBytes', 2097152);
		const maxDiffLines = config.get<number>('maxDiffLines', 12000);
		const maxDiffCells = config.get<number>('maxDiffCells', 16000000);
		if (Buffer.byteLength(oldText, 'utf8') > maxFileBytes || Buffer.byteLength(newText, 'utf8') > maxFileBytes) {
			return { hunks: [], skippedReason: 'File exceeds cliDiff.maxFileBytes.' };
		}

		const oldLineCount = splitLines(oldText).length;
		const newLineCount = splitLines(newText).length;
		const lineCount = oldLineCount + newLineCount;
		if (lineCount > maxDiffLines) {
			return { hunks: [], skippedReason: 'File exceeds cliDiff.maxDiffLines.' };
		}
		if ((oldLineCount + 1) * (newLineCount + 1) > maxDiffCells) {
			return { hunks: [], skippedReason: 'File diff exceeds cliDiff.maxDiffCells.' };
		}

		return { hunks: computeLineDiff(uri.toString(), oldText, newText) };
	}

	private isReviewableFile(file: ReviewFileState | undefined): file is ReviewFileState {
		return Boolean(file && (
			file.hunks.length > 0
			|| file.acceptedHunks.length > 0
			|| file.rejectedHunks.length > 0
			|| file.skippedReason
		));
	}

	private refreshUi(): void {
		this.treeProvider.refresh();
		this.reviewWebview.refresh();
		this.dashboardProvider.refresh();
	}

	private setCurrentReviewUri(uri: vscode.Uri): void {
		if (this.currentReviewUri && uriKey(this.currentReviewUri) === uriKey(uri)) {
			return;
		}
		this.currentReviewUri = uri;
		this.dashboardProvider.refresh();
	}

	private activeGitWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
		if (!this.activeSession || this.activeSession.mode !== 'git') {
			return undefined;
		}

		return vscode.workspace.getWorkspaceFolder(this.activeSession.rootUri)
			?? vscode.workspace.workspaceFolders?.find((workspaceFolder) => uriKey(workspaceFolder.uri) === uriKey(this.activeSession?.rootUri ?? workspaceFolder.uri));
	}

	private async updateGitIndexStateSignature(): Promise<void> {
		const folder = this.activeGitWorkspaceFolder();
		if (!folder) {
			this.gitIndexStateSignature = undefined;
			return;
		}

		try {
			this.gitIndexStateSignature = await this.gitService.indexStateSignature(folder);
		} catch {
			this.gitIndexStateSignature = undefined;
		}
	}

	private scheduleGitSessionRefresh(): void {
		if (!this.activeSession || this.activeSession.mode !== 'git') {
			return;
		}

		if (this.gitRefreshTimer) {
			clearTimeout(this.gitRefreshTimer);
		}

		this.gitRefreshTimer = setTimeout(() => {
			this.gitRefreshTimer = undefined;
			void this.refreshGitSessionIfIndexChanged();
		}, 250);
	}

	private async refreshGitSessionIfIndexChanged(): Promise<void> {
		if (!this.activeSession || this.activeSession.mode !== 'git') {
			return;
		}

		const folder = this.activeGitWorkspaceFolder();
		if (!folder) {
			return;
		}

		try {
			const signature = await this.gitService.indexStateSignature(folder);
			if (signature === this.gitIndexStateSignature) {
				return;
			}

			await this.refreshGitSessionFiles({ source: 'gitIndexChanged', indexStateSignature: signature });
		} catch {
			// Git may be unavailable briefly while the repository is changing.
		}
	}

	private touchFileRevision(file: ReviewFileState): void {
		file.revision += 1;
	}

	private isStaleMutation(file: ReviewFileState, expectedRevision?: number): boolean {
		return isStaleRevision(file.revision, expectedRevision);
	}

	private syncBaselineExistsAfterAccept(file: ReviewFileState): void {
		file.baselineExists = file.currentExists || file.oldText.length > 0;
	}

	private syncBaselineExistsForPending(file: ReviewFileState): void {
		file.baselineExists = file.originalExists || file.oldText.length > 0;
	}

	private async updateSnapshotBaselineFile(file: ReviewFileState): Promise<void> {
		await this.snapshotStore.updateBaselineFile(file.uri, file.oldText, file.baselineExists);
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
		});
	}

	private isOpenDocumentDirty(uri: vscode.Uri): boolean {
		return vscode.workspace.textDocuments.some((document) => document.uri.toString() === uri.toString() && document.isDirty);
	}

	private ensureFileCleanForReviewMutation(file: ReviewFileState): boolean {
		if (!this.isOpenDocumentDirty(file.uri)) {
			return true;
		}

		vscode.window.showInformationMessage('Save or revert this file before accepting, rejecting, or undoing CLI Diff changes.');
		this.reviewWebview.refresh(file.uri);
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
		if (this.activeSession && !this.activeSession.files.has(key) && this.activeSession.mode !== 'git') {
			return;
		}

		const existing = this.refreshTimers.get(key);
		if (existing) {
			clearTimeout(existing);
		}

		this.refreshTimers.set(key, setTimeout(() => {
			this.refreshTimers.delete(key);
			void this.refreshFile(uri, { preferDisk: options.preferDisk });
		}, 250));
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

		if (!this.activeSession) {
			this.manualGitBaselines.clear();
			this.activeSession = {
				id: `git-${Date.now()}`,
				mode: 'git',
				rootUri: folder?.uri ?? vscode.Uri.file(path.dirname(uri.fsPath)),
				createdAt: Date.now(),
				files: new Map<string, ReviewFileState>(),
			};
			await this.updateGitIndexStateSignature();
			await vscode.commands.executeCommand('setContext', 'cliDiff:hasSession', true);
		}

		if (this.activeSession.mode !== 'git') {
			return;
		}

		await this.refreshFile(uri, { preferDisk: options.preferDisk });
	}

	private async createGitFilePair(uri: vscode.Uri, options: { preferDisk?: boolean } = {}): Promise<FilePair | undefined> {
		const folder = vscode.workspace.getWorkspaceFolder(uri);

		try {
			const pair = await this.gitService.createFilePairForUri(uri, folder, { preferDisk: options.preferDisk });
			if (!pair) {
				this.manualGitBaselines.delete(uriKey(uri));
				return undefined;
			}
			return applyManualGitBaselineToPair(pair, this.manualGitBaselineForPair(pair));
		} catch {
			return undefined;
		}
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

		await this.fileOperationQueue.enqueue(uriKey(uri), operation);
	}

	private flattenHunks(): Array<{ file: ReviewFileState; hunk: ReviewHunk }> {
		if (!this.activeSession) {
			return [];
		}

		return [...this.activeSession.files.values()]
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

	private isSameDecision(decision: ReviewedHunk, hunk: ReviewHunk, reviewSource: ReviewSource): boolean {
		return decision.reviewSource === reviewSource
			&& decision.fileUri === hunk.fileUri
			&& decision.kind === hunk.kind
			&& decision.oldStart === hunk.oldStart
			&& decision.oldLines === hunk.oldLines
			&& decision.newStart === hunk.newStart
			&& decision.newLines === hunk.newLines
			&& decision.oldText === hunk.oldText
			&& decision.newText === hunk.newText;
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
		return {
			...hunk,
			id: `${reviewSource}-${Date.now()}-${hunk.id}`,
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

	private async restoreDecisionsToPending(file: ReviewFileState): Promise<void> {
		const accepted = [...file.acceptedHunks].sort((left, right) => right.baselineStart - left.baselineStart);
		const rejected = [...file.rejectedHunks].sort((left, right) => right.currentStart - left.currentStart);
		if (accepted.length === 0 && rejected.length === 0) {
			return;
		}

		for (const hunk of accepted) {
			if (!this.reviewedBaselineSideMatches(file.oldText, hunk, hunk.baselineStart, hunk.newLines, hunk.newText)) {
				throw new Error('A reviewed CLI Diff change no longer matches the baseline. Refresh the review and try again.');
			}
		}
		let baselineText = file.oldText;
		for (const hunk of accepted) {
			baselineText = replaceLineBlock(baselineText, hunk.baselineStart, hunk.newLines, hunk.oldText);
		}

		const current = await this.readCurrentText(file.uri);
		for (const hunk of rejected) {
			if (!this.reviewedCurrentSideMatches(current.text, hunk, hunk.currentStart, hunk.displayLines, hunk.oldText)) {
				throw new Error('A reviewed CLI Diff change no longer matches the current file. Refresh the review and try again.');
			}
		}
		let currentText = current.text;
		for (const hunk of rejected) {
			currentText = replaceLineBlock(currentText, hunk.currentStart, hunk.displayLines, hunk.newText);
		}

		file.oldText = baselineText;
		file.newText = currentText;
		file.currentExists = current.exists;
		this.syncBaselineExistsForPending(file);
		file.acceptedHunks = [];
		file.rejectedHunks = [];
		if (rejected.length > 0) {
			file.currentExists = true;
			await this.writeCurrentFileText(file.uri, currentText);
		}
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

	private originalHunkSideMatches(text: string, hunk: ReviewHunk, side: 'old' | 'new', startLine: number): boolean {
		const context = side === 'old'
			? { before: hunk.oldContextBefore, after: hunk.oldContextAfter }
			: { before: hunk.newContextBefore, after: hunk.newContextAfter };
		const lineCount = side === 'old' ? hunk.oldLines : hunk.newLines;
		const expectedText = side === 'old' ? hunk.oldText : hunk.newText;
		return lineBlockWithContextMatchesUniquely(text, startLine, lineCount, expectedText, context);
	}

	private reviewedBaselineSideMatches(
		text: string,
		hunk: ReviewedHunk,
		startLine: number,
		lineCount: number,
		expectedText: string,
	): boolean {
		return lineBlockWithContextMatchesUniquely(text, startLine, lineCount, expectedText, {
			before: hunk.baselineContextBefore,
			after: hunk.baselineContextAfter,
		});
	}

	private reviewedCurrentSideMatches(
		text: string,
		hunk: ReviewedHunk,
		startLine: number,
		lineCount: number,
		expectedText: string,
	): boolean {
		return lineBlockWithContextMatchesUniquely(text, startLine, lineCount, expectedText, {
			before: hunk.currentContextBefore,
			after: hunk.currentContextAfter,
		});
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

	private async readCurrentWorkspaceFiles(): Promise<Map<string, CurrentTextState & { uri: vscode.Uri; relativePath: string }>> {
		const folders = vscode.workspace.workspaceFolders ?? [];
		const maxFileBytes = vscode.workspace.getConfiguration('cliDiff').get<number>('maxFileBytes', 2097152);
		const maxFiles = vscode.workspace.getConfiguration('cliDiff').get<number>('maxFiles', 2000);
		const exclude = vscode.workspace.getConfiguration('cliDiff').get<string>('exclude', '**/{.git,node_modules,dist,out,.vscode-test}/**');
		const files = new Map<string, CurrentTextState & { uri: vscode.Uri; relativePath: string }>();

		for (const folder of folders) {
			const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), exclude, maxFiles);
			const relativePaths = new Map(uris.map((uri) => [uri.toString(), relativePath(folder.uri, uri)]));
			const ignoredPaths = await gitIgnoredReviewPaths(folder, [...relativePaths.values()]);
			for (const uri of uris) {
				const currentRelativePath = relativePaths.get(uri.toString()) ?? relativePath(folder.uri, uri);
				if (shouldSkipReviewPath(currentRelativePath) || ignoredPaths.has(currentRelativePath)) {
					continue;
				}
				const data = await vscode.workspace.fs.readFile(uri);
				if (data.length > maxFileBytes) {
					files.set(uriKey(uri), {
						uri,
						relativePath: currentRelativePath,
						...skippedCurrentFile('File exceeds cliDiff.maxFileBytes.'),
					});
					continue;
				}
				if (isProbablyBinary(data)) {
					files.set(uriKey(uri), {
						uri,
						relativePath: currentRelativePath,
						...skippedCurrentFile('File appears to be binary.'),
					});
					continue;
				}
				files.set(uriKey(uri), {
					uri,
					relativePath: currentRelativePath,
					text: decodeUtf8(data),
					exists: true,
				});
			}
		}

		return files;
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

	private async pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (folders.length <= 1) {
			return folders[0];
		}

		const picked = await vscode.window.showQuickPick(folders.map((folder) => ({
			label: folder.name,
			description: folder.uri.fsPath,
			folder,
		})), { placeHolder: 'Select a workspace folder for Git review' });
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
				disposables.push(onDidChange(() => this.scheduleGitSessionRefresh()));
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
		vscode.window.showErrorMessage(`CLI Diff: ${message}`);
	}
}
