import * as path from 'path';
import * as vscode from 'vscode';
import { acceptHunkInBaseline, computeLineDiff } from './diffEngine';
import { GitService } from './gitService';
import { ReviewTreeProvider } from './reviewTree';
import { EditedRange, ReviewWebviewManager } from './reviewWebview';
import { SnapshotStore } from './snapshotStore';
import { decodeUtf8, encodeUtf8, isProbablyBinary, lineRange, relativePath, replaceLineBlock, splitLines } from './text';
import { FilePair, ReviewedHunk, ReviewFileState, ReviewHunk, ReviewSession, ReviewSource, uriKey } from './types';

type InternalWriteSource = 'plugin' | 'human';

export class ReviewController implements vscode.Disposable {
	private readonly snapshotStore: SnapshotStore;
	private readonly gitService = new GitService();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly treeProvider: ReviewTreeProvider;
	private readonly reviewWebview: ReviewWebviewManager;
	private readonly refreshTimers = new Map<string, NodeJS.Timeout>();
	private readonly humanEditBatches = new Map<string, EditedRange[]>();
	private readonly humanSaveIntents = new Map<string, number>();
	private readonly internalWriteDepth = new Map<string, number>();
	private readonly writeGraceUntil = new Map<string, { source: InternalWriteSource; until: number }>();
	private readonly hunkOperationKeys = new Set<string>();
	private activeSession: ReviewSession | undefined;

	public constructor(private readonly context: vscode.ExtensionContext) {
		this.snapshotStore = new SnapshotStore(context);
		this.treeProvider = new ReviewTreeProvider(() => this.activeSession);
		this.reviewWebview = new ReviewWebviewManager(context, () => this.activeSession, (uri, text, ranges) => this.saveEditedCurrent(uri, text, ranges));

		this.disposables.push(
			this.reviewWebview,
			vscode.window.registerTreeDataProvider('cli-diff.review', this.treeProvider),
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
			this.registerCommand('cli-diff.captureBaseline', () => this.captureBaseline()),
			this.registerCommand('cli-diff.startSnapshotReview', () => this.startSnapshotReview()),
			this.registerCommand('cli-diff.startGitReview', () => this.startGitReview()),
			this.registerCommand('cli-diff.acceptChange', (uri?: string, hunkId?: string) => this.acceptChange(uri, hunkId)),
			this.registerCommand('cli-diff.rejectChange', (uri?: string, hunkId?: string) => this.rejectChange(uri, hunkId)),
			this.registerCommand('cli-diff.restoreChange', (uri?: string, hunkId?: string) => this.restoreChange(uri, hunkId)),
			this.registerCommand('cli-diff.acceptFile', (uri?: string | ReviewFileState) => this.acceptFile(uri)),
			this.registerCommand('cli-diff.rejectFile', (uri?: string | ReviewFileState) => this.rejectFile(uri)),
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

		await vscode.commands.executeCommand('setContext', 'cliDiff:hasSession', true);
		this.refreshUi();
		const hunkCount = [...files.values()].reduce((total, file) => total + file.hunks.length, 0);
		if (notify) {
			vscode.window.showInformationMessage(`CLI Diff ${mode} review started (${files.size} files, ${hunkCount} changes).`);
		}
	}

	private createFileState(pair: FilePair): ReviewFileState {
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
		};
	}

	private async ensureManualReviewSession(uri: vscode.Uri): Promise<void> {
		if (this.activeSession || !vscode.workspace.getConfiguration('cliDiff').get<boolean>('autoStartGitReview', true)) {
			return;
		}

		const folder = vscode.workspace.getWorkspaceFolder(uri);
		this.activeSession = {
			id: `git-${Date.now()}`,
			mode: 'git',
			rootUri: folder?.uri ?? vscode.Uri.file(path.dirname(uri.fsPath)),
			createdAt: Date.now(),
			files: new Map<string, ReviewFileState>(),
		};
		await vscode.commands.executeCommand('setContext', 'cliDiff:hasSession', true);
	}

	private async acceptChange(uriString?: string, hunkId?: string): Promise<void> {
		const operationKey = this.hunkOperationKey(uriString, hunkId);
		if (operationKey && this.hunkOperationKeys.has(operationKey)) {
			return;
		}
		if (operationKey) {
			this.hunkOperationKeys.add(operationKey);
		}
		try {
			const preflightFile = this.resolveFile(uriString);
			if (preflightFile) {
				await this.refreshFile(preflightFile.uri);
			}

			const target = this.resolveHunk(uriString, hunkId);
			if (!target) {
				vscode.window.showInformationMessage('No CLI Diff change selected.');
				return;
			}

			target.file.oldText = acceptHunkInBaseline(target.file.oldText, target.hunk);
			this.recordDecisionHunk(target.file, target.hunk, 'accept');
			if (this.activeSession?.mode === 'snapshot') {
				await this.snapshotStore.updateBaselineFile(target.file.uri, target.file.oldText);
			}
			await this.refreshFile(target.file.uri, { reconcileExternalChanges: false });
		} catch (error) {
			this.showError(error);
		} finally {
			if (operationKey) {
				this.hunkOperationKeys.delete(operationKey);
			}
		}
	}

	private async rejectChange(uriString?: string, hunkId?: string): Promise<void> {
		const operationKey = this.hunkOperationKey(uriString, hunkId);
		if (operationKey && this.hunkOperationKeys.has(operationKey)) {
			return;
		}
		if (operationKey) {
			this.hunkOperationKeys.add(operationKey);
		}
		try {
			const preflightFile = this.resolveFile(uriString);
			if (preflightFile) {
				await this.refreshFile(preflightFile.uri);
			}

			const target = this.resolveHunk(uriString, hunkId);
			if (!target) {
				vscode.window.showInformationMessage('No CLI Diff change selected.');
				return;
			}

			if (!target.file.currentExists) {
				await this.withInternalWrite(target.file.uri, 'plugin', () => this.writeFileText(target.file.uri, target.file.oldText));
				this.recordDecisionHunk(target.file, target.hunk, 'reject');
				await this.refreshFile(target.file.uri, { reconcileExternalChanges: false });
				return;
			}

			const document = await vscode.workspace.openTextDocument(target.file.uri);
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
			this.recordDecisionHunk(target.file, target.hunk, 'reject');
			await this.refreshFile(target.file.uri, { reconcileExternalChanges: false });
		} catch (error) {
			this.showError(error);
		} finally {
			if (operationKey) {
				this.hunkOperationKeys.delete(operationKey);
			}
		}
	}

	private async restoreChange(uriString?: string, hunkId?: string): Promise<void> {
		const operationKey = this.hunkOperationKey(uriString, hunkId);
		if (operationKey && this.hunkOperationKeys.has(operationKey)) {
			return;
		}
		if (operationKey) {
			this.hunkOperationKeys.add(operationKey);
		}
		try {
			const target = this.resolveDecisionHunk(uriString, hunkId);
			if (!target) {
				vscode.window.showInformationMessage('No accepted or rejected CLI Diff change selected.');
				return;
			}

			if (target.list === 'accepted') {
				target.file.oldText = replaceLineBlock(target.file.oldText, target.hunk.displayStart, target.hunk.newLines, target.hunk.oldText);
				target.file.acceptedHunks = target.file.acceptedHunks.filter((item) => item.id !== target.hunk.id);
				if (this.activeSession?.mode === 'snapshot') {
					await this.snapshotStore.updateBaselineFile(target.file.uri, target.file.oldText);
				}
			} else {
				const current = await this.readCurrentText(target.file.uri);
				const currentText = replaceLineBlock(current.text, target.hunk.displayStart, target.hunk.displayLines, target.hunk.newText);
				target.file.newText = currentText;
				target.file.currentExists = true;
				target.file.rejectedHunks = target.file.rejectedHunks.filter((item) => item.id !== target.hunk.id);
				await this.writeCurrentFileText(target.file.uri, currentText);
			}

			await this.refreshFile(target.file.uri, { reconcileExternalChanges: false });
		} catch (error) {
			this.showError(error);
		} finally {
			if (operationKey) {
				this.hunkOperationKeys.delete(operationKey);
			}
		}
	}

	private async acceptFile(uriString?: string | ReviewFileState): Promise<void> {
		try {
			const file = this.resolveFile(uriString);
			if (!file) {
				vscode.window.showInformationMessage('No CLI Diff file selected.');
				return;
			}

			const current = await this.readCurrentText(file.uri);
			file.newText = current.text;
			file.currentExists = current.exists;
			for (const hunk of file.hunks) {
				this.recordDecisionHunk(file, hunk, 'accept');
			}
			file.oldText = file.newText;
			if (this.activeSession?.mode === 'snapshot') {
				await this.snapshotStore.updateBaselineFile(file.uri, file.oldText);
			}
			await this.refreshFile(file.uri, { reconcileExternalChanges: false });
		} catch (error) {
			this.showError(error);
		}
	}

	private async rejectFile(uriString?: string | ReviewFileState): Promise<void> {
		try {
			const file = this.resolveFile(uriString);
			if (!file) {
				vscode.window.showInformationMessage('No CLI Diff file selected.');
				return;
			}

			await this.restoreDecisionsToPending(file);
			if (this.activeSession?.mode === 'snapshot') {
				await this.snapshotStore.updateBaselineFile(file.uri, file.oldText);
			}
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
			await this.writeCurrentFileText(uri, editedText, 'human');

			if (this.activeSession?.mode === 'snapshot') {
				await this.snapshotStore.updateBaselineFile(file.uri, file.oldText);
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
					await this.snapshotStore.updateBaselineFile(file.uri, file.oldText);
				}
				this.refreshUi();
				return;
			}

			this.applyManualEditsToBaseline(file, document.getText(), editedRanges);
			if (this.activeSession?.mode === 'snapshot') {
				await this.snapshotStore.updateBaselineFile(file.uri, file.oldText);
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
		let baselineText = file.oldText;

		for (const manualHunk of [...manualHunks].sort((left, right) => right.oldStart - left.oldStart)) {
			if (this.manualHunkTouchesPending(manualHunk, pendingBefore, editedRanges)) {
				continue;
			}

			const baselineStart = this.mapCurrentLineToBaseline(manualHunk.oldStart, pendingBefore);
			baselineText = replaceLineBlock(baselineText, baselineStart, manualHunk.oldLines, manualHunk.newText);
		}

		this.syncDecisionHunksAfterEdit(file, manualHunks, editedText);
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
		this.reviewWebview.open(uri);
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
		for (const file of files) {
			file.acceptedHunks = [];
			file.rejectedHunks = [];
			if (this.activeSession.mode === 'snapshot') {
				await this.snapshotStore.updateBaselineFile(file.uri, file.oldText);
			}
			await this.refreshFile(file.uri, { reconcileExternalChanges: false });
		}

		if (this.activeSession.mode === 'git') {
			await this.refreshGitSessionFiles();
		}
	}

	private async refreshGitSessionFiles(): Promise<void> {
		if (!this.activeSession || this.activeSession.mode !== 'git') {
			return;
		}

		const folder = vscode.workspace.getWorkspaceFolder(this.activeSession.rootUri)
			?? vscode.workspace.workspaceFolders?.find((workspaceFolder) => uriKey(workspaceFolder.uri) === uriKey(this.activeSession?.rootUri ?? workspaceFolder.uri));
		if (!folder) {
			return;
		}

		const pairs = await this.gitService.createFilePairs(folder);
		for (const pair of pairs) {
			const key = uriKey(pair.uri);
			if (this.activeSession.files.has(key)) {
				continue;
			}

			const file = this.createFileState(pair);
			if (file.hunks.length > 0 || file.skippedReason) {
				this.activeSession.files.set(key, file);
			}
		}
		this.refreshUi();
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
			if (file.hunks.length === 0 && !file.skippedReason) {
				return;
			}
			this.activeSession.files.set(key, file);
			this.refreshUi();
			return;
		}

		const current = await this.readCurrentText(uri, { preferDisk: options.preferDisk });
		if (options.reconcileExternalChanges !== false && current.text !== file.newText && this.decisionHunks(file).length > 0) {
			const externalHunks = computeLineDiff(file.uri.toString(), file.newText, current.text);
			this.reconcileDecisionHunksForExternalChanges(file, externalHunks);
		}
		file.newText = current.text;
		file.currentExists = current.exists;
		const diff = this.computeReviewHunks(file.uri, file.oldText, file.newText);
		file.hunks = diff.hunks;
		file.skippedReason = diff.skippedReason;
		if (file.hunks.length === 0 && this.decisionHunks(file).length === 0 && !file.skippedReason && this.activeSession.mode !== 'git') {
			this.activeSession.files.delete(key);
		}
		this.refreshUi();
	}

	private computeReviewHunks(uri: vscode.Uri, oldText: string, newText: string): { hunks: ReviewHunk[]; skippedReason?: string } {
		const config = vscode.workspace.getConfiguration('cliDiff');
		const maxFileBytes = config.get<number>('maxFileBytes', 524288);
		const maxDiffLines = config.get<number>('maxDiffLines', 5000);
		if (Buffer.byteLength(oldText, 'utf8') > maxFileBytes || Buffer.byteLength(newText, 'utf8') > maxFileBytes) {
			return { hunks: [], skippedReason: 'File exceeds cliDiff.maxFileBytes.' };
		}

		const lineCount = splitLines(oldText).length + splitLines(newText).length;
		if (lineCount > maxDiffLines) {
			return { hunks: [], skippedReason: 'File exceeds cliDiff.maxDiffLines.' };
		}

		return { hunks: computeLineDiff(uri.toString(), oldText, newText) };
	}

	private refreshUi(): void {
		this.treeProvider.refresh();
		this.reviewWebview.refresh();
	}

	private isOpenDocumentDirty(uri: vscode.Uri): boolean {
		return vscode.workspace.textDocuments.some((document) => document.uri.toString() === uri.toString() && document.isDirty);
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
			this.activeSession = {
				id: `git-${Date.now()}`,
				mode: 'git',
				rootUri: folder?.uri ?? vscode.Uri.file(path.dirname(uri.fsPath)),
				createdAt: Date.now(),
				files: new Map<string, ReviewFileState>(),
			};
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
			return await this.gitService.createFilePairForUri(uri, folder, { preferDisk: options.preferDisk });
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

	private hunkOperationKey(uriString?: string, hunkId?: string): string | undefined {
		if (!hunkId) {
			return undefined;
		}
		return `${uriString ?? 'active'}::${hunkId}`;
	}

	private flattenHunks(): Array<{ file: ReviewFileState; hunk: ReviewHunk }> {
		if (!this.activeSession) {
			return [];
		}

		return [...this.activeSession.files.values()]
			.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
			.flatMap((file) => file.hunks.map((hunk) => ({ file, hunk })));
	}

	private recordDecisionHunk(file: ReviewFileState, hunk: ReviewHunk, reviewSource: ReviewSource): void {
		const displayLines = reviewSource === 'reject' ? hunk.oldLines : hunk.newLines;
		const decision = this.createDecisionHunk(hunk, reviewSource, hunk.newStart, displayLines);
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

	private createDecisionHunk(hunk: ReviewHunk, reviewSource: ReviewSource, displayStart: number, displayLines: number): ReviewedHunk {
		return {
			...hunk,
			id: `${reviewSource}-${Date.now()}-${hunk.id}`,
			status: reviewSource === 'reject' ? 'rejected' : 'accepted',
			reviewSource,
			displayStart,
			displayLines,
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
		const accepted = [...file.acceptedHunks].sort((left, right) => right.displayStart - left.displayStart);
		const rejected = [...file.rejectedHunks].sort((left, right) => right.displayStart - left.displayStart);
		if (accepted.length === 0 && rejected.length === 0) {
			return;
		}

		let baselineText = file.oldText;
		for (const hunk of accepted) {
			baselineText = replaceLineBlock(baselineText, hunk.displayStart, hunk.newLines, hunk.oldText);
		}

		const current = await this.readCurrentText(file.uri);
		let currentText = current.text;
		for (const hunk of rejected) {
			currentText = replaceLineBlock(currentText, hunk.displayStart, hunk.displayLines, hunk.newText);
		}

		file.oldText = baselineText;
		file.newText = currentText;
		file.currentExists = true;
		file.acceptedHunks = [];
		file.rejectedHunks = [];
		await this.writeCurrentFileText(file.uri, currentText);
	}

	private syncDecisionHunksAfterEdit(file: ReviewFileState, manualHunks: ReviewHunk[], editedText: string): void {
		if (manualHunks.length === 0) {
			return;
		}

		file.acceptedHunks = file.acceptedHunks.map((hunk) => this.syncDecisionHunkAfterEdit(hunk, manualHunks, editedText));
		file.rejectedHunks = file.rejectedHunks.map((hunk) => this.syncDecisionHunkAfterEdit(hunk, manualHunks, editedText));
	}

	private syncDecisionHunkAfterEdit(hunk: ReviewedHunk, manualHunks: ReviewHunk[], editedText: string): ReviewedHunk {
		let displayStart = this.mapPreviousLineToEditedLine(hunk.displayStart, manualHunks);
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
		}

		displayStart = Math.max(0, displayStart);
		displayLines = Math.max(0, displayLines);
		if (!touched) {
			return { ...hunk, displayStart };
		}

		const editedBlockText = this.lineBlock(editedText, displayStart, displayLines);
		if (hunk.reviewSource === 'reject') {
			return {
				...hunk,
				oldLines: displayLines,
				oldText: editedBlockText,
				displayStart,
				displayLines,
			};
		}

		return {
			...hunk,
			newLines: displayLines,
			newText: editedBlockText,
			displayStart,
			displayLines,
		};
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

	private async readCurrentWorkspaceFiles(): Promise<Map<string, { uri: vscode.Uri; relativePath: string; text: string; exists: boolean }>> {
		const folders = vscode.workspace.workspaceFolders ?? [];
		const maxFileBytes = vscode.workspace.getConfiguration('cliDiff').get<number>('maxFileBytes', 524288);
		const maxFiles = vscode.workspace.getConfiguration('cliDiff').get<number>('maxFiles', 2000);
		const exclude = vscode.workspace.getConfiguration('cliDiff').get<string>('exclude', '**/{.git,node_modules,dist,out,.vscode-test}/**');
		const files = new Map<string, { uri: vscode.Uri; relativePath: string; text: string; exists: boolean }>();

		for (const folder of folders) {
			const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), exclude, maxFiles);
			for (const uri of uris) {
				const data = await vscode.workspace.fs.readFile(uri);
				if (data.length > maxFileBytes || isProbablyBinary(data)) {
					continue;
				}
				files.set(uriKey(uri), {
					uri,
					relativePath: relativePath(folder.uri, uri),
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

	private registerCommand(command: string, callback: (...args: any[]) => unknown): vscode.Disposable {
		return vscode.commands.registerCommand(command, callback);
	}

	private showError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`CLI Diff: ${message}`);
	}
}
