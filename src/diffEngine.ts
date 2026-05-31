import { createHash } from 'crypto';
import { ReviewHunk } from './types';
import { replaceLineBlock, splitLines } from './text';

type DiffOpKind = 'equal' | 'delete' | 'insert';

interface DiffOp {
	kind: DiffOpKind;
	text: string;
	oldLine?: number;
	newLine?: number;
}

export function computeLineDiff(fileUri: string, oldText: string, newText: string): ReviewHunk[] {
	if (oldText === newText) {
		return [];
	}

	const oldLines = splitLines(oldText);
	const newLines = splitLines(newText);
	const ops = buildDiffOps(oldLines, newLines);
	return buildHunks(fileUri, ops);
}

export function acceptHunkInBaseline(oldText: string, hunk: ReviewHunk): string {
	return replaceLineBlock(oldText, hunk.oldStart, hunk.oldLines, hunk.newText);
}

function buildDiffOps(oldLines: string[], newLines: string[]): DiffOp[] {
	const rows = oldLines.length + 1;
	const columns = newLines.length + 1;
	const table: number[][] = Array.from({ length: rows }, () => Array<number>(columns).fill(0));

	for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
		for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
			if (oldLines[oldIndex] === newLines[newIndex]) {
				table[oldIndex][newIndex] = table[oldIndex + 1][newIndex + 1] + 1;
			} else {
				table[oldIndex][newIndex] = Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
			}
		}
	}

	const ops: DiffOp[] = [];
	let oldIndex = 0;
	let newIndex = 0;

	while (oldIndex < oldLines.length || newIndex < newLines.length) {
		if (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
			ops.push({ kind: 'equal', text: oldLines[oldIndex], oldLine: oldIndex, newLine: newIndex });
			oldIndex += 1;
			newIndex += 1;
		} else if (newIndex >= newLines.length || (oldIndex < oldLines.length && table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1])) {
			ops.push({ kind: 'delete', text: oldLines[oldIndex], oldLine: oldIndex });
			oldIndex += 1;
		} else {
			ops.push({ kind: 'insert', text: newLines[newIndex], newLine: newIndex });
			newIndex += 1;
		}
	}

	return ops;
}

function buildHunks(fileUri: string, ops: DiffOp[]): ReviewHunk[] {
	const hunks: ReviewHunk[] = [];
	let oldCursor = 0;
	let newCursor = 0;
	let pending: {
		oldStart: number;
		newStart: number;
		oldParts: string[];
		newParts: string[];
		oldLines: number;
		newLines: number;
	} | undefined;

	const flush = () => {
		if (!pending || (pending.oldLines === 0 && pending.newLines === 0)) {
			pending = undefined;
			return;
		}

		const oldText = pending.oldParts.join('');
		const newText = pending.newParts.join('');
		const kind = pending.oldLines === 0 ? 'add' : pending.newLines === 0 ? 'delete' : 'modify';
		const fingerprint = hash(`${fileUri}\0${pending.oldStart}\0${pending.newStart}\0${oldText}\0${newText}`);
		hunks.push({
			id: `${fingerprint}-${pending.oldStart}-${pending.newStart}`,
			fileUri,
			oldStart: pending.oldStart,
			oldLines: pending.oldLines,
			newStart: pending.newStart,
			newLines: pending.newLines,
			oldText,
			newText,
			kind,
		});
		pending = undefined;
	};

	for (const op of ops) {
		if (op.kind === 'equal') {
			flush();
			oldCursor += 1;
			newCursor += 1;
			continue;
		}

		if (!pending) {
			pending = {
				oldStart: oldCursor,
				newStart: newCursor,
				oldParts: [],
				newParts: [],
				oldLines: 0,
				newLines: 0,
			};
		}

		if (op.kind === 'delete') {
			pending.oldParts.push(op.text);
			pending.oldLines += 1;
			oldCursor += 1;
		} else {
			pending.newParts.push(op.text);
			pending.newLines += 1;
			newCursor += 1;
		}
	}

	flush();
	return hunks;
}

function hash(value: string): string {
	return createHash('sha1').update(value).digest('hex').slice(0, 12);
}
