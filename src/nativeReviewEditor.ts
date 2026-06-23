import * as vscode from 'vscode';
import { splitLines } from './text';
import { ReviewFileState, ReviewSession, uriKey } from './types';

export interface NativeReviewRevealPosition {
	line?: number;
	column?: number;
	hunkId?: string;
}

export class NativeReviewEditorManager implements vscode.Disposable {
	private static readonly beforeDocumentScheme = 'cli-diff-review-before';

	private readonly disposables: vscode.Disposable[] = [];
	private readonly beforeDocumentEmitter = new vscode.EventEmitter<vscode.Uri>();

	public constructor(
		private readonly getSession: () => ReviewSession | undefined,
		private readonly isEnabled: () => boolean,
	) {
		this.disposables.push(
			this.beforeDocumentEmitter,
			vscode.workspace.registerTextDocumentContentProvider(NativeReviewEditorManager.beforeDocumentScheme, {
				onDidChange: this.beforeDocumentEmitter.event,
				provideTextDocumentContent: (uri) => this.provideBeforeDocumentContent(uri),
			}),
		);
	}

	public dispose(): void {
		this.clear();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	public async open(uri: vscode.Uri, reveal?: NativeReviewRevealPosition): Promise<boolean> {
		if (!this.isEnabled()) {
			return false;
		}

		const file = this.getSession()?.files.get(uriKey(uri));
		if (!file?.currentExists) {
			return false;
		}

		try {
			await this.ensureInlineDiffMode();
			await vscode.commands.executeCommand(
				'vscode.diff',
				this.beforeDocumentUri(file),
				file.uri,
				`${file.relativePath} - Cli Diff Review`,
				{ preview: false },
			);
			await this.reveal(file, reveal);
			return true;
		} catch {
			return false;
		}
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

		if (uri) {
			this.beforeDocumentEmitter.fire(this.beforeDocumentUriForFileUri(uri));
			return;
		}

		for (const file of session.files.values()) {
			this.beforeDocumentEmitter.fire(this.beforeDocumentUri(file));
		}
	}

	public clear(uri?: vscode.Uri): void {
		const tabs = this.nativeDiffTabs(uri);
		if (tabs.length > 0) {
			void vscode.window.tabGroups.close(tabs, true);
		}
	}

	public clearActive(_uri?: vscode.Uri): void {
		this.refresh(_uri);
	}

	public closeCompleted(): vscode.Uri[] {
		const files = this.getSession()?.files;
		const closed: vscode.Uri[] = [];
		const tabs = this.nativeDiffTabs();
		for (const tab of tabs) {
			const input = tab.input as vscode.TabInputTextDiff;
			const fileUri = input.modified;
			if ((files?.get(uriKey(fileUri))?.hunks.length ?? 0) > 0) {
				continue;
			}
			closed.push(fileUri);
		}

		if (closed.length > 0) {
			const closedKeys = new Set(closed.map(uriKey));
			void vscode.window.tabGroups.close(tabs.filter((tab) => {
				const input = tab.input as vscode.TabInputTextDiff;
				return closedKeys.has(uriKey(input.modified));
			}), true);
		}

		return closed;
	}

	private provideBeforeDocumentContent(uri: vscode.Uri): string {
		const fileUri = this.fileUriFromBeforeDocumentUri(uri);
		if (!fileUri) {
			return '';
		}
		return this.getSession()?.files.get(uriKey(fileUri))?.oldText ?? '';
	}

	private beforeDocumentUri(file: ReviewFileState): vscode.Uri {
		return this.beforeDocumentUriForFileUri(file.uri);
	}

	private beforeDocumentUriForFileUri(uri: vscode.Uri): vscode.Uri {
		return vscode.Uri.from({
			scheme: NativeReviewEditorManager.beforeDocumentScheme,
			path: uri.path,
			query: encodeURIComponent(uri.toString()),
		});
	}

	private fileUriFromBeforeDocumentUri(uri: vscode.Uri): vscode.Uri | undefined {
		try {
			return vscode.Uri.parse(decodeURIComponent(uri.query));
		} catch {
			return undefined;
		}
	}

	private async ensureInlineDiffMode(): Promise<void> {
		if (!vscode.workspace.getConfiguration('cliDiff').get<boolean>('nativeDiffInline', true)) {
			return;
		}

		const diffConfig = vscode.workspace.getConfiguration('diffEditor');
		if (diffConfig.get<boolean>('renderSideBySide') !== false) {
			await diffConfig.update('renderSideBySide', false, vscode.ConfigurationTarget.Workspace);
		}
	}

	private async reveal(file: ReviewFileState, reveal?: NativeReviewRevealPosition): Promise<void> {
		const lineCount = Math.max(1, splitLines(file.newText).length);
		const line = Math.max(0, Math.min(reveal?.line ?? 0, lineCount - 1));
		const column = Math.max(0, reveal?.column ?? 0);
		await vscode.commands.executeCommand('revealLine', { lineNumber: line, at: 'center' });

		const editor = vscode.window.activeTextEditor;
		if (!editor || uriKey(editor.document.uri) !== uriKey(file.uri)) {
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
			const input = tab.input;
			return input instanceof vscode.TabInputTextDiff
				&& input.original.scheme === NativeReviewEditorManager.beforeDocumentScheme
				&& (!targetKey || uriKey(input.modified) === targetKey);
		});
	}
}
