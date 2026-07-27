import * as vscode from 'vscode';
import type { StoredAiReview } from './agent/codeReview';
import { hasAggregateReviewTarget, ReviewFileState, ReviewProject, ReviewSession, visibleReviewFiles } from './types';

export interface ReviewProjectTreeNode {
	kind: 'project';
	project: ReviewProject;
}

export type ReviewTreeNode = ReviewFileState | ReviewProjectTreeNode;

export class ReviewTreeProvider implements vscode.TreeDataProvider<ReviewTreeNode> {
	private readonly emitter = new vscode.EventEmitter<ReviewTreeNode | undefined | null | void>();
	public readonly onDidChangeTreeData = this.emitter.event;

	public constructor(
		private readonly getSession: () => ReviewSession | undefined,
		private readonly getAiReview: () => StoredAiReview | undefined = () => undefined,
	) {}

	public getTreeItem(element: ReviewTreeNode): vscode.TreeItem {
		if (isProjectNode(element)) {
			return this.projectTreeItem(element);
		}
		const item = new vscode.TreeItem(element.relativePath, vscode.TreeItemCollapsibleState.None);
		const pending = element.hunks.length;
		const accepted = element.acceptedHunks.length;
		const rejected = element.rejectedHunks.length;
		const reviewed = accepted + rejected;
		item.resourceUri = element.uri;
		if (element.skippedReason) {
			item.description = 'Unsupported Git change';
			item.tooltip = `${element.relativePath}\n${element.skippedReason}`;
			item.contextValue = 'cliDiffFileSkipped';
		} else {
			item.description = fileDescription(pending, accepted, rejected, fileAiReviewCounts(element, this.getAiReview()));
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
		const accepted = files.reduce((total, file) => total + file.acceptedHunks.length, 0);
		const rejected = files.reduce((total, file) => total + file.rejectedHunks.length, 0);
		const label = element.project.branchName
			? `${element.project.name}  ${element.project.branchName}`
			: element.project.name;
		const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
		item.contextValue = 'cliDiffProject';
		item.description = [
			pending > 0 ? `${pending} Pending` : undefined,
			accepted > 0 ? `${accepted} Accepted` : undefined,
			rejected > 0 ? `${rejected} Rejected` : undefined,
		].filter(Boolean).join(', ') || '0 Reviewed';
		item.tooltip = element.project.rootUri.fsPath;
		return item;
	}
}

function isProjectNode(element: ReviewTreeNode): element is ReviewProjectTreeNode {
	return 'kind' in element && element.kind === 'project';
}

function fileDescription(
	pending: number,
	accepted: number,
	rejected: number,
	aiCounts: { findings: number; suggestions: number },
): string {
	const parts: string[] = [];
	if (pending > 0) {
		parts.push(`${pending} Pending`);
	}
	if (accepted > 0) {
		parts.push(`${accepted} Accepted`);
	}
	if (rejected > 0) {
		parts.push(`${rejected} Rejected`);
	}
	if (parts.length === 0) {
		parts.push('0 Reviewed');
	}
	if (aiCounts.findings > 0) {
		parts.push(`${aiCounts.findings} ${aiCounts.findings === 1 ? 'finding' : 'findings'}`);
	}
	if (aiCounts.suggestions > 0) {
		parts.push(`${aiCounts.suggestions} ${aiCounts.suggestions === 1 ? 'suggestion' : 'suggestions'}`);
	}
	return parts.join(', ');
}

function fileAiReviewCounts(file: ReviewFileState, review: StoredAiReview | undefined): { findings: number; suggestions: number } {
	if (!review) {
		return { findings: 0, suggestions: 0 };
	}
	const uri = file.uri.toString();
	return {
		findings: review.findings.filter((finding) => finding.uri === uri).length,
		suggestions: review.suggestions.filter((suggestion) => suggestion.uri === uri).length,
	};
}
