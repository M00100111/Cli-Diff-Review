import * as vscode from 'vscode';

export type ReviewMode = 'git';

export type ChangeKind = 'add' | 'delete' | 'modify';

export type ReviewSource = 'accept' | 'reject';

export type ReviewDecisionStatus = 'accepted' | 'rejected';

export type GitReviewLayer = 'pending' | 'accepted' | 'rejected';

export interface ReviewHunk {
	id: string;
	fileUri: string;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	oldText: string;
	newText: string;
	kind: ChangeKind;
	oldContextBefore: string[];
	oldContextAfter: string[];
	newContextBefore: string[];
	newContextAfter: string[];
	zoneAfterLineNumber: number;
	layer?: GitReviewLayer;
	patch?: string;
	patchHeader?: string;
	rawHunk?: string;
	fingerprint?: string;
	projectId?: string;
	occurrence?: number;
	operable?: boolean;
}

export interface GitReviewHunk extends ReviewHunk {
	layer: GitReviewLayer;
	patch: string;
	fingerprint: string;
	projectId: string;
}

export interface GitFileSnapshot {
	headText: string;
	indexText: string;
	workingText: string;
	headExists: boolean;
	indexExists: boolean;
	workingExists: boolean;
}

export interface ReviewedHunk extends ReviewHunk {
	status: ReviewDecisionStatus;
	reviewSource: ReviewSource;
	displayStart: number;
	displayLines: number;
	baselineStart: number;
	currentStart: number;
	baselineContextBefore: string[];
	baselineContextAfter: string[];
	currentContextBefore: string[];
	currentContextAfter: string[];
	reviewedAt: number;
	appliedAiSuggestion?: AppliedAiSuggestion;
}

export interface AppliedAiSuggestion {
	suggestionId: string;
	hunkId: string;
	originalHunk: ReviewHunk;
	replacementText: string;
	appliedHunk: ReviewHunk;
	appliedAt: number;
}

export interface ReviewFileState {
	uri: vscode.Uri;
	relativePath: string;
	projectId?: string;
	projectName?: string;
	oldText: string;
	newText: string;
	hunks: ReviewHunk[];
	acceptedHunks: ReviewedHunk[];
	rejectedHunks: ReviewedHunk[];
	appliedAiSuggestions: AppliedAiSuggestion[];
	originalText: string;
	originalExists: boolean;
	baselineExists: boolean;
	currentExists: boolean;
	revision: number;
	skippedReason?: string;
	gitSnapshot?: GitFileSnapshot;
	headOid?: string;
}

export interface ReviewProject {
	id: string;
	name: string;
	rootUri: vscode.Uri;
	headOid?: string;
}

export type ReviewTrackingTarget =
	| { kind: 'aggregate' }
	| { kind: 'project'; projectId: string };

export interface ReviewSession {
	id: string;
	mode: ReviewMode;
	rootUri: vscode.Uri;
	createdAt: number;
	files: Map<string, ReviewFileState>;
	projects?: ReviewProject[];
	trackingTarget?: ReviewTrackingTarget;
}

export interface BaselineFile {
	uri: vscode.Uri;
	relativePath: string;
	text: string;
	exists: boolean;
}

export interface FilePair {
	uri: vscode.Uri;
	relativePath: string;
	projectId?: string;
	projectName?: string;
	oldText: string;
	newText: string;
	baselineExists: boolean;
	currentExists: boolean;
	skippedReason?: string;
	gitSnapshot?: GitFileSnapshot;
	pendingHunks?: GitReviewHunk[];
	acceptedHunks?: ReviewedHunk[];
	headOid?: string;
}

export function uriKey(uri: vscode.Uri): string {
	return uri.toString();
}

export function reviewProjectFolder(project: ReviewProject, index = 0): vscode.WorkspaceFolder {
	return { uri: project.rootUri, name: project.name, index };
}

export function hasAggregateReviewTarget(session: ReviewSession | undefined): boolean {
	return Boolean(session?.mode === 'git'
		&& session.projects?.length
		&& !session.projects.some((project) => uriKey(project.rootUri) === uriKey(session.rootUri)));
}

export function currentReviewProject(session: ReviewSession | undefined): ReviewProject | undefined {
	if (!session?.projects || session.trackingTarget?.kind !== 'project') {
		return undefined;
	}
	const projectId = session.trackingTarget.projectId;
	return session.projects.find((project) => project.id === projectId);
}

export function visibleReviewFiles(session: ReviewSession | undefined): ReviewFileState[] {
	if (!session) {
		return [];
	}
	const projectId = session.trackingTarget?.kind === 'project' ? session.trackingTarget.projectId : undefined;
	return [...session.files.values()].filter((file) => !projectId || file.projectId === projectId);
}

export function projectReviewSession(session: ReviewSession, project: ReviewProject): ReviewSession {
	return {
		...session,
		rootUri: project.rootUri,
		files: new Map([...session.files].filter(([, file]) => file.projectId === project.id)),
		projects: [project],
		trackingTarget: { kind: 'project', projectId: project.id },
	};
}
