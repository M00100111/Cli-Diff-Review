import * as vscode from 'vscode';
import { hasAggregateReviewTarget, ReviewFileState, ReviewProject, ReviewSession, visibleReviewFiles } from './types';

export interface ReviewProjectTreeNode {
	kind: 'project';
	project: ReviewProject;
}

export type ReviewTreeNode = ReviewFileState | ReviewProjectTreeNode;

export class ReviewTreeProvider implements vscode.TreeDataProvider<ReviewTreeNode> {
	private readonly emitter = new vscode.EventEmitter<ReviewTreeNode | undefined | null | void>();
	public readonly onDidChangeTreeData = this.emitter.event;

	public constructor(private readonly getSession: () => ReviewSession | undefined) {}

	public getTreeItem(element: ReviewTreeNode): vscode.TreeItem {
		if (isProjectNode(element)) {
			return this.projectTreeItem(element);
		}
		const item = new vscode.TreeItem(element.relativePath, vscode.TreeItemCollapsibleState.None);
		const pending = element.hunks.length;
		const reviewed = element.acceptedHunks.length + element.rejectedHunks.length;
		item.resourceUri = element.uri;
		if (element.skippedReason) {
			item.description = 'skipped';
			item.tooltip = `${element.relativePath}\n${element.skippedReason}`;
			item.contextValue = 'cliDiffFileSkipped';
		} else {
			item.description = pending > 0 && reviewed > 0
				? `${pending} pending, ${reviewed} reviewed`
				: pending > 0 ? `${pending} pending` : `${reviewed} reviewed`;
			item.contextValue = pending > 0 && reviewed > 0
			? 'cliDiffFilePendingReviewed'
			: pending > 0 ? 'cliDiffFilePending' : reviewed > 0 ? 'cliDiffFileReviewed' : 'cliDiffFile';
		}
		item.command = {
			command: 'cli-diff.openReviewView',
			title: 'Open Review',
			arguments: [element.uri.toString()],
		};
		return item;
	}

	public getChildren(element?: ReviewTreeNode): ReviewTreeNode[] {
		const session = this.getSession();
		if (!session || (element && !isProjectNode(element))) {
			return [];
		}

		const files = visibleReviewFiles(session)
			.filter((file) => file.hunks.length > 0 || file.acceptedHunks.length > 0 || file.rejectedHunks.length > 0 || file.skippedReason)
			.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
		if (element && isProjectNode(element)) {
			return files.filter((file) => file.projectId === element.project.id);
		}
		if (hasAggregateReviewTarget(session) && session.trackingTarget?.kind === 'aggregate') {
			const projectIdsWithFiles = new Set(files.map((file) => file.projectId));
			return (session.projects ?? [])
				.filter((project) => projectIdsWithFiles.has(project.id))
				.map((project) => ({ kind: 'project', project }));
		}
		return files;
	}

	public refresh(): void {
		this.emitter.fire();
	}

	private projectTreeItem(element: ReviewProjectTreeNode): vscode.TreeItem {
		const files = [...(this.getSession()?.files.values() ?? [])].filter((file) => file.projectId === element.project.id);
		const pending = files.reduce((total, file) => total + file.hunks.length, 0);
		const reviewed = files.reduce((total, file) => total + file.acceptedHunks.length + file.rejectedHunks.length, 0);
		const item = new vscode.TreeItem(element.project.name, vscode.TreeItemCollapsibleState.Expanded);
		item.contextValue = 'cliDiffProject';
		item.description = pending > 0 && reviewed > 0
			? `${pending} pending, ${reviewed} reviewed`
			: pending > 0 ? `${pending} pending` : `${reviewed} reviewed`;
		item.tooltip = element.project.rootUri.fsPath;
		return item;
	}
}

function isProjectNode(element: ReviewTreeNode): element is ReviewProjectTreeNode {
	return 'kind' in element && element.kind === 'project';
}
