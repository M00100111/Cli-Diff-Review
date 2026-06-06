import * as vscode from 'vscode';

export type ReviewMode = 'git' | 'snapshot';

export type ChangeKind = 'add' | 'delete' | 'modify';

export type ReviewSource = 'accept' | 'reject';

export type ReviewDecisionStatus = 'accepted' | 'rejected';

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
}

export interface ReviewFileState {
	uri: vscode.Uri;
	relativePath: string;
	oldText: string;
	newText: string;
	hunks: ReviewHunk[];
	acceptedHunks: ReviewedHunk[];
	rejectedHunks: ReviewedHunk[];
	originalText: string;
	originalExists: boolean;
	baselineExists: boolean;
	currentExists: boolean;
	revision: number;
	skippedReason?: string;
}

export interface ReviewSession {
	id: string;
	mode: ReviewMode;
	rootUri: vscode.Uri;
	createdAt: number;
	files: Map<string, ReviewFileState>;
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
	oldText: string;
	newText: string;
	baselineExists: boolean;
	currentExists: boolean;
	skippedReason?: string;
}

export function uriKey(uri: vscode.Uri): string {
	return uri.toString();
}
