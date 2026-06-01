import * as vscode from 'vscode';
import { ReviewFileState, ReviewSession } from './types';

export class ReviewTreeProvider implements vscode.TreeDataProvider<ReviewFileState> {
	private readonly emitter = new vscode.EventEmitter<ReviewFileState | undefined | null | void>();
	public readonly onDidChangeTreeData = this.emitter.event;

	public constructor(private readonly getSession: () => ReviewSession | undefined) {}

	public getTreeItem(element: ReviewFileState): vscode.TreeItem {
		const item = new vscode.TreeItem(element.relativePath, vscode.TreeItemCollapsibleState.None);
		const pending = element.hunks.length;
		const reviewed = element.acceptedHunks.length + element.rejectedHunks.length;
		item.resourceUri = element.uri;
		item.description = pending > 0 && reviewed > 0
			? `${pending} pending, ${reviewed} reviewed`
			: pending > 0 ? `${pending} pending` : `${reviewed} reviewed`;
		item.contextValue = pending > 0 && reviewed > 0
			? 'cliDiffFilePendingReviewed'
			: pending > 0 ? 'cliDiffFilePending' : reviewed > 0 ? 'cliDiffFileReviewed' : 'cliDiffFile';
		item.command = {
			command: 'cli-diff.openReviewView',
			title: 'Open Review',
			arguments: [element.uri.toString()],
		};
		return item;
	}

	public getChildren(element?: ReviewFileState): ReviewFileState[] {
		const session = this.getSession();
		if (!session || element) {
			return [];
		}

		return [...session.files.values()]
			.filter((file) => file.hunks.length > 0 || file.acceptedHunks.length > 0 || file.rejectedHunks.length > 0)
			.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
	}

	public refresh(): void {
		this.emitter.fire();
	}
}
