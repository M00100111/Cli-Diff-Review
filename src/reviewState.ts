import { splitLines } from './text';
import type { FilePair, ReviewFileState, ReviewHunk } from './types';

export function isStaleRevision(currentRevision: number, expectedRevision?: number): boolean {
	return typeof expectedRevision === 'number' && currentRevision !== expectedRevision;
}

export interface CurrentTextState {
	text: string;
	exists: boolean;
	skippedReason?: string;
}

export interface LineEdit {
	oldStart: number;
	oldLines: number;
	newLines: number;
}

export interface LineBlockContext {
	before: string[];
	after: string[];
}

export interface GitManualBaseline {
	oldText: string;
	baselineExists: boolean;
}

export interface ReviewRevealPosition {
	line: number;
	column: number;
	hunkId: string;
}

export function skippedCurrentFile(skippedReason: string): CurrentTextState {
	return { text: '', exists: true, skippedReason };
}

export function firstReviewRevealPosition(file: Pick<ReviewFileState, 'hunks' | 'acceptedHunks' | 'rejectedHunks'>): ReviewRevealPosition | undefined {
	const firstPending = [...file.hunks]
		.sort((left, right) => left.newStart - right.newStart || left.id.localeCompare(right.id))[0];
	if (firstPending) {
		return { line: firstPending.newStart, column: 0, hunkId: firstPending.id };
	}

	const firstReviewed = [...file.acceptedHunks, ...file.rejectedHunks]
		.sort((left, right) => left.displayStart - right.displayStart || left.id.localeCompare(right.id))[0];
	if (firstReviewed) {
		return { line: firstReviewed.displayStart, column: 0, hunkId: firstReviewed.id };
	}

	return undefined;
}

export function reviewHunkIdentity(hunk: Pick<ReviewHunk, 'fileUri' | 'kind' | 'oldStart' | 'oldLines' | 'newStart' | 'newLines' | 'oldText' | 'newText'>): string {
	return JSON.stringify([
		hunk.fileUri,
		hunk.kind,
		hunk.oldStart,
		hunk.oldLines,
		hunk.newStart,
		hunk.newLines,
		hunk.oldText,
		hunk.newText,
	]);
}

export function shouldDeleteRejectedCurrentFileOnRefresh(
	baselineExists: boolean,
	currentText: string,
	acceptedHunkCount: number,
	rejectedHunkCount: number,
): boolean {
	return !baselineExists && currentText.length === 0 && acceptedHunkCount === 0 && rejectedHunkCount > 0;
}

export function shouldMergeReviewedFileOnRefresh(
	pendingHunkCount: number,
	acceptedHunkCount: number,
	rejectedHunkCount: number,
	skippedReason?: string,
): boolean {
	return pendingHunkCount === 0
		&& !skippedReason
		&& acceptedHunkCount + rejectedHunkCount > 0;
}

export function manualGitBaselineFromReviewedFile(file: ReviewFileState): GitManualBaseline | undefined {
	if (file.skippedReason || (!file.currentExists && file.acceptedHunks.length === 0)) {
		return undefined;
	}

	if (shouldMergeReviewedFileOnRefresh(file.hunks.length, file.acceptedHunks.length, file.rejectedHunks.length)) {
		return {
			oldText: file.newText,
			baselineExists: file.currentExists,
		};
	}

	if (file.acceptedHunks.length === 0) {
		return undefined;
	}

	return {
		oldText: file.oldText,
		baselineExists: file.baselineExists,
	};
}

export function applyManualGitBaselineToPair(pair: FilePair, baseline: GitManualBaseline | undefined): FilePair {
	if (!baseline || pair.skippedReason) {
		return pair;
	}

	return {
		...pair,
		oldText: baseline.oldText,
		baselineExists: baseline.baselineExists,
	};
}

export function mapLineAfterLineEdits(line: number, edits: LineEdit[]): number {
	let mappedLine = line;
	for (const edit of [...edits].sort((left, right) => left.oldStart - right.oldStart)) {
		if (edit.oldStart < line && edit.oldStart + edit.oldLines <= line) {
			mappedLine += edit.newLines - edit.oldLines;
		}
	}
	return Math.max(0, mappedLine);
}

export function mapLineAfterFileEdits(line: number, edits: LineEdit[]): number {
	let mappedLine = line;
	for (const edit of [...edits].sort((left, right) => left.oldStart - right.oldStart)) {
		if (edit.oldLines === 0) {
			if (edit.oldStart <= line) {
				mappedLine += edit.newLines;
			}
		} else if (edit.oldStart + edit.oldLines <= line) {
			mappedLine += edit.newLines - edit.oldLines;
		}
	}
	return Math.max(0, mappedLine);
}

export function captureLineBlockContext(linesOrText: string[] | string, startLine: number, lineCount: number, radius = 3): LineBlockContext {
	const lines = Array.isArray(linesOrText) ? linesOrText : splitLines(linesOrText);
	const start = Math.max(0, Math.min(startLine, lines.length));
	const count = Math.max(0, lineCount);
	const end = Math.max(start, Math.min(start + count, lines.length));
	return {
		before: lines.slice(Math.max(0, start - radius), start),
		after: lines.slice(end, Math.min(lines.length, end + radius)),
	};
}

export function lineBlockWithContextMatches(
	text: string,
	startLine: number,
	lineCount: number,
	expectedText: string,
	context: LineBlockContext,
): boolean {
	const lines = splitLines(text);
	const expectedLines = splitLines(expectedText);
	const start = Math.max(0, startLine);
	const count = Math.max(0, lineCount);
	if (start > lines.length || start + count > lines.length) {
		return false;
	}
	if (expectedLines.length !== count) {
		return false;
	}
	if (lines.slice(start, start + count).join('') !== expectedText) {
		return false;
	}
	if (start < context.before.length) {
		return false;
	}
	if (lines.slice(start - context.before.length, start).join('') !== context.before.join('')) {
		return false;
	}
	if (lines.slice(start + count, start + count + context.after.length).join('') !== context.after.join('')) {
		return false;
	}
	return true;
}

export function lineBlockWithContextMatchCount(
	text: string,
	lineCount: number,
	expectedText: string,
	context: LineBlockContext,
): number {
	const lines = splitLines(text);
	const count = Math.max(0, lineCount);
	let matches = 0;
	for (let start = 0; start <= lines.length - count; start += 1) {
		if (lineBlockWithContextMatches(text, start, count, expectedText, context)) {
			matches += 1;
		}
	}
	return matches;
}

export function lineBlockWithContextMatchesUniquely(
	text: string,
	startLine: number,
	lineCount: number,
	expectedText: string,
	context: LineBlockContext,
): boolean {
	return lineBlockWithContextMatches(text, startLine, lineCount, expectedText, context)
		&& lineBlockWithContextMatchCount(text, lineCount, expectedText, context) === 1;
}

export class SerialOperationQueue<TKey> {
	private readonly queues = new Map<TKey, Promise<void>>();

	public async enqueue(key: TKey, operation: () => Promise<void>): Promise<void> {
		const previous = this.queues.get(key) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(operation);
		this.queues.set(key, current);
		try {
			await current;
		} finally {
			if (this.queues.get(key) === current) {
				this.queues.delete(key);
			}
		}
	}
}
