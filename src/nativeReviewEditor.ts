import * as vscode from 'vscode';
import { firstReviewRevealPosition } from './reviewState';
import { replaceLineBlock, splitLines } from './text';
import { ReviewedHunk, ReviewFileState, ReviewSession, uriKey } from './types';

export interface NativeReviewRevealPosition {
	line?: number;
	column?: number;
	hunkId?: string;
}

type NativeReviewSide = 'before' | 'after';

export class NativeReviewEditorManager implements vscode.Disposable {
	private static readonly beforeDocumentScheme = 'cli-diff-review-before';
	private static readonly afterDocumentScheme = 'cli-diff-review-after';

	private readonly disposables: vscode.Disposable[] = [];
	private readonly beforeDocumentEmitter = new vscode.EventEmitter<vscode.Uri>();
	private readonly openFileKeys = new Set<string>();

	public constructor(
		private readonly getSession: () => ReviewSession | undefined,
		private readonly isEnabled: () => boolean,
	) {
		this.disposables.push(
			this.beforeDocumentEmitter,
			vscode.workspace.registerTextDocumentContentProvider(NativeReviewEditorManager.beforeDocumentScheme, {
				onDidChange: this.beforeDocumentEmitter.event,
				provideTextDocumentContent: (uri) => this.provideReviewDocumentContent(uri),
			}),
			vscode.workspace.registerTextDocumentContentProvider(NativeReviewEditorManager.afterDocumentScheme, {
				onDidChange: this.beforeDocumentEmitter.event,
				provideTextDocumentContent: (uri) => this.provideReviewDocumentContent(uri),
			}),
			vscode.window.tabGroups.onDidChangeTabs((event) => {
				for (const tab of event.opened) {
					const input = this.textDiffInput(tab);
					const fileUri = input ? this.fileUriFromDiffInput(input) : undefined;
					if (fileUri) {
						this.openFileKeys.add(uriKey(fileUri));
					}
				}
				for (const tab of event.closed) {
					const input = this.textDiffInput(tab);
					const fileUri = input ? this.fileUriFromDiffInput(input) : undefined;
					if (fileUri) {
						this.openFileKeys.delete(uriKey(fileUri));
					}
				}
			}),
		);
	}

	public dispose(): void {
		this.clear();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	public async open(uri: vscode.Uri, reveal?: NativeReviewRevealPosition, viewColumn?: vscode.ViewColumn): Promise<boolean> {
		if (!this.isEnabled()) {
			return false;
		}

		const file = this.getSession()?.files.get(uriKey(uri));
		if (!file || file.skippedReason) {
			return false;
		}

		try {
			await vscode.commands.executeCommand(
				'vscode.diff',
				this.reviewDocumentUri(file, 'before'),
				this.reviewDocumentUri(file, 'after'),
				`${file.relativePath} - Cli Diff Review`,
				{ preview: false, viewColumn },
			);
			await this.reveal(file, reveal);
			this.openFileKeys.add(uriKey(file.uri));
			return true;
		} catch {
			return false;
		}
	}

	public async syncOpen(uri: vscode.Uri, reveal?: NativeReviewRevealPosition): Promise<boolean> {
		if (!this.isEnabled()) {
			return false;
		}

		const tabs = this.nativeDiffTabs(uri);
		const key = uriKey(uri);
		if (tabs.length === 0 && !this.openFileKeys.has(key) && !this.isActiveReviewDocumentForFile(uri)) {
			return false;
		}

		const file = this.getSession()?.files.get(uriKey(uri));
		if (!file || file.skippedReason) {
			return false;
		}

		this.refresh(uri);
		await this.reveal(file, reveal ?? firstReviewRevealPosition(file));
		this.openFileKeys.add(key);
		return true;
	}

	public async revealChunk(uri: vscode.Uri, hunkId: string): Promise<boolean> {
		const file = this.getSession()?.files.get(uriKey(uri));
		if (!file) {
			return false;
		}
		const pending = file.hunks.find((hunk) => hunk.id === hunkId);
		const reviewed = pending ? undefined : [...file.acceptedHunks, ...file.rejectedHunks]
			.find((hunk) => hunk.id === hunkId || hunk.id.endsWith(`-${hunkId}`));
		return this.open(uri, {
			line: pending?.newStart ?? reviewed?.displayStart ?? 0,
			column: 0,
			hunkId: pending?.id ?? reviewed?.id ?? hunkId,
		});
	}

	public refresh(uri?: vscode.Uri): void {
		if (!this.isEnabled()) {
			this.clear(uri);
			return;
		}

		const session = this.getSession();
		if (!session) {
			this.clear(uri);
			return;
		}

		const openTabs = this.nativeDiffTabs(uri);
		for (const tab of openTabs) {
			const input = this.textDiffInput(tab);
			if (input) {
				this.beforeDocumentEmitter.fire(input.original);
				this.beforeDocumentEmitter.fire(input.modified);
			}
		}

		if (uri) {
			const file = session.files.get(uriKey(uri));
			if (file) {
				this.beforeDocumentEmitter.fire(this.reviewDocumentUri(file, 'before'));
				this.beforeDocumentEmitter.fire(this.reviewDocumentUri(file, 'after'));
			}
			return;
		}

		for (const file of session.files.values()) {
			this.beforeDocumentEmitter.fire(this.reviewDocumentUri(file, 'before'));
			this.beforeDocumentEmitter.fire(this.reviewDocumentUri(file, 'after'));
		}
	}

	public clear(uri?: vscode.Uri): void {
		const tabs = this.nativeDiffTabs(uri);
		if (tabs.length > 0) {
			void vscode.window.tabGroups.close(tabs, true);
		}
		if (uri) {
			this.openFileKeys.delete(uriKey(uri));
		} else {
			this.openFileKeys.clear();
		}
	}

	public clearActive(uri?: vscode.Uri): void {
		if (uri) {
			void this.syncOpen(uri);
			return;
		}
		this.refresh(uri);
	}

	public closeCompleted(): vscode.Uri[] {
		const files = this.getSession()?.files;
		const closed: vscode.Uri[] = [];
		const tabs = this.nativeDiffTabs();
		for (const tab of tabs) {
			const input = this.textDiffInput(tab);
			if (!input) {
				continue;
			}
			const fileUri = this.fileUriFromDiffInput(input);
			if (!fileUri) {
				continue;
			}
			if ((files?.get(uriKey(fileUri))?.hunks.length ?? 0) > 0) {
				continue;
			}
			closed.push(fileUri);
		}

		if (closed.length > 0) {
			const closedKeys = new Set(closed.map(uriKey));
			void vscode.window.tabGroups.close(tabs.filter((tab) => {
				const input = this.textDiffInput(tab);
				const fileUri = input ? this.fileUriFromDiffInput(input) : undefined;
				return Boolean(fileUri && closedKeys.has(uriKey(fileUri)));
			}), true);
		}

		return closed;
	}

	private provideReviewDocumentContent(uri: vscode.Uri): string {
		const payload = this.reviewDocumentPayload(uri);
		if (!payload) {
			return '';
		}
		const file = this.getSession()?.files.get(uriKey(payload.fileUri));
		if (!file) {
			return '';
		}
		return payload.side === 'after' ? file.newText : this.beforeText(file);
	}

	private beforeText(file: ReviewFileState): string {
		return [...file.acceptedHunks]
			.sort((left, right) => this.acceptedBaselineStart(right) - this.acceptedBaselineStart(left))
			.reduce((text, hunk) => replaceLineBlock(
				text,
				this.acceptedBaselineStart(hunk),
				hunk.oldLines,
				hunk.newText,
			), file.oldText);
	}

	private acceptedBaselineStart(hunk: ReviewedHunk): number {
		return Number.isFinite(hunk.baselineStart) ? hunk.baselineStart : hunk.oldStart;
	}

	private reviewDocumentUri(file: ReviewFileState, side: NativeReviewSide): vscode.Uri {
		return this.reviewDocumentUriForFileUri(file.uri, side);
	}

	private reviewDocumentUriForFileUri(uri: vscode.Uri, side: NativeReviewSide): vscode.Uri {
		return vscode.Uri.from({
			scheme: side === 'after' ? NativeReviewEditorManager.afterDocumentScheme : NativeReviewEditorManager.beforeDocumentScheme,
			path: uri.path,
			query: encodeURIComponent(JSON.stringify({ uri: uri.toString(), side })),
		});
	}

	private reviewDocumentPayload(uri: vscode.Uri): { fileUri: vscode.Uri; side: NativeReviewSide } | undefined {
		if (uri.scheme !== NativeReviewEditorManager.beforeDocumentScheme && uri.scheme !== NativeReviewEditorManager.afterDocumentScheme) {
			return undefined;
		}
		try {
			const decoded = decodeURIComponent(uri.query);
			const parsed = JSON.parse(decoded) as { uri?: unknown; side?: unknown };
			if (typeof parsed.uri === 'string') {
				const side = parsed.side === 'after' || uri.scheme === NativeReviewEditorManager.afterDocumentScheme ? 'after' : 'before';
				return { fileUri: vscode.Uri.parse(parsed.uri), side };
			}
			return undefined;
		} catch {
			try {
				return { fileUri: vscode.Uri.parse(decodeURIComponent(uri.query)), side: uri.scheme === NativeReviewEditorManager.afterDocumentScheme ? 'after' : 'before' };
			} catch {
				return undefined;
			}
		}
	}

	private async reveal(file: ReviewFileState, reveal?: NativeReviewRevealPosition): Promise<void> {
		const lineCount = Math.max(1, splitLines(file.newText).length);
		const line = Math.max(0, Math.min(reveal?.line ?? 0, lineCount - 1));
		const column = Math.max(0, reveal?.column ?? 0);
		await vscode.commands.executeCommand('revealLine', { lineNumber: line, at: 'center' });

		const editor = vscode.window.activeTextEditor;
		if (!editor || !this.isReviewDocumentForFile(editor.document.uri, file.uri)) {
			return;
		}

		const documentLine = Math.min(line, Math.max(0, editor.document.lineCount - 1));
		const documentColumn = Math.min(column, editor.document.lineAt(documentLine).text.length);
		const position = new vscode.Position(documentLine, documentColumn);
		editor.selection = new vscode.Selection(position, position);
		editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	}

	private nativeDiffTabs(uri?: vscode.Uri): vscode.Tab[] {
		const targetKey = uri ? uriKey(uri) : undefined;
		return vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => {
			const input = this.textDiffInput(tab);
			const fileUri = input ? this.fileUriFromDiffInput(input) : undefined;
			return Boolean(fileUri && (!targetKey || uriKey(fileUri) === targetKey));
		});
	}

	private fileUriFromDiffInput(input: vscode.TabInputTextDiff): vscode.Uri | undefined {
		const original = this.reviewDocumentPayload(input.original);
		const modified = this.reviewDocumentPayload(input.modified);
		if (!original || !modified || original.side !== 'before' || modified.side !== 'after') {
			return undefined;
		}
		return uriKey(original.fileUri) === uriKey(modified.fileUri) ? original.fileUri : undefined;
	}

	private isReviewDocumentForFile(uri: vscode.Uri, fileUri: vscode.Uri): boolean {
		const payload = this.reviewDocumentPayload(uri);
		return Boolean(payload && uriKey(payload.fileUri) === uriKey(fileUri));
	}

	private isActiveReviewDocumentForFile(fileUri: vscode.Uri): boolean {
		const activeUri = vscode.window.activeTextEditor?.document.uri;
		return Boolean(activeUri && this.isReviewDocumentForFile(activeUri, fileUri));
	}

	private textDiffInput(tab: vscode.Tab): vscode.TabInputTextDiff | undefined {
		const input = tab.input;
		if (input instanceof vscode.TabInputTextDiff) {
			return input;
		}
		if (!input || typeof input !== 'object' || !('original' in input) || !('modified' in input)) {
			return undefined;
		}
		const candidate = input as { original?: unknown; modified?: unknown };
		if (this.isUriLike(candidate.original) && this.isUriLike(candidate.modified)) {
			return candidate as vscode.TabInputTextDiff;
		}
		return undefined;
	}

	private isUriLike(value: unknown): value is vscode.Uri {
		return Boolean(value
			&& typeof value === 'object'
			&& 'scheme' in value
			&& typeof (value as { scheme?: unknown }).scheme === 'string'
			&& typeof (value as { toString?: unknown }).toString === 'function');
	}
}
