import { createHash } from 'crypto';
import { ReviewHunk } from './types';
import { captureLineBlockContext } from './reviewState';
import { replaceLineBlock, splitLines } from './text';

type DiffOp = { kind: 'equal' | 'delete' | 'insert'; text: string };

/**
 * Synthetic-test helper retained for compatibility. Production review state is
 * created only from Git patches. This uses Myers' frontier algorithm and does
 * not allocate the former oldLines × newLines LCS table.
 */
export function computeLineDiff(fileUri: string, oldText: string, newText: string): ReviewHunk[] {
	if (oldText === newText) {
		return [];
	}
	const oldLines = splitLines(oldText);
	const newLines = splitLines(newText);
	return buildHunks(fileUri, myersDiff(oldLines, newLines), oldLines, newLines);
}

export function acceptHunkInBaseline(oldText: string, hunk: ReviewHunk): string {
	return replaceLineBlock(oldText, hunk.oldStart, hunk.oldLines, hunk.newText);
}

function myersDiff(oldLines: string[], newLines: string[]): DiffOp[] {
	const maximum = oldLines.length + newLines.length;
	let frontier = new Map<number, number>([[1, 0]]);
	const trace: Array<Map<number, number>> = [];
	for (let distance = 0; distance <= maximum; distance += 1) {
		const next = new Map<number, number>();
		for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
			const down = diagonal === -distance
				|| (diagonal !== distance && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1));
			let oldIndex = down ? (frontier.get(diagonal + 1) ?? 0) : (frontier.get(diagonal - 1) ?? 0) + 1;
			let newIndex = oldIndex - diagonal;
			while (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
				oldIndex += 1;
				newIndex += 1;
			}
			next.set(diagonal, oldIndex);
			if (oldIndex >= oldLines.length && newIndex >= newLines.length) {
				trace.push(next);
				return backtrack(trace, oldLines, newLines);
			}
		}
		trace.push(next);
		frontier = next;
	}
	return [];
}

function backtrack(trace: Array<Map<number, number>>, oldLines: string[], newLines: string[]): DiffOp[] {
	const reversed: DiffOp[] = [];
	let oldIndex = oldLines.length;
	let newIndex = newLines.length;
	for (let distance = trace.length - 1; distance > 0; distance -= 1) {
		const previous = trace[distance - 1];
		const diagonal = oldIndex - newIndex;
		const previousDiagonal = diagonal === -distance
			|| (diagonal !== distance && (previous.get(diagonal - 1) ?? -1) < (previous.get(diagonal + 1) ?? -1))
			? diagonal + 1
			: diagonal - 1;
		const previousOld = previous.get(previousDiagonal) ?? 0;
		const previousNew = previousOld - previousDiagonal;
		while (oldIndex > previousOld && newIndex > previousNew) {
			reversed.push({ kind: 'equal', text: oldLines[oldIndex - 1] });
			oldIndex -= 1;
			newIndex -= 1;
		}
		if (oldIndex === previousOld) {
			reversed.push({ kind: 'insert', text: newLines[newIndex - 1] });
			newIndex -= 1;
		} else {
			reversed.push({ kind: 'delete', text: oldLines[oldIndex - 1] });
			oldIndex -= 1;
		}
	}
	while (oldIndex > 0 && newIndex > 0) {
		reversed.push({ kind: 'equal', text: oldLines[--oldIndex] });
		newIndex -= 1;
	}
	while (oldIndex > 0) {
		reversed.push({ kind: 'delete', text: oldLines[--oldIndex] });
	}
	while (newIndex > 0) {
		reversed.push({ kind: 'insert', text: newLines[--newIndex] });
	}
	return reversed.reverse();
}

function buildHunks(fileUri: string, ops: DiffOp[], oldLines: string[], newLines: string[]): ReviewHunk[] {
	const hunks: ReviewHunk[] = [];
	let oldCursor = 0;
	let newCursor = 0;
	let pending: { oldStart: number; newStart: number; old: string[]; next: string[] } | undefined;
	const flush = () => {
		if (!pending) {
			return;
		}
		const oldText = pending.old.join('');
		const newText = pending.next.join('');
		const fingerprint = createHash('sha1').update(`${fileUri}\0${pending.oldStart}\0${pending.newStart}\0${oldText}\0${newText}`).digest('hex').slice(0, 12);
		const oldContext = captureLineBlockContext(oldLines, pending.oldStart, pending.old.length);
		const newContext = captureLineBlockContext(newLines, pending.newStart, pending.next.length);
		hunks.push({
			id: `${fingerprint}-${pending.oldStart}-${pending.newStart}`,
			fileUri,
			oldStart: pending.oldStart,
			oldLines: pending.old.length,
			newStart: pending.newStart,
			newLines: pending.next.length,
			oldText,
			newText,
			kind: pending.old.length === 0 ? 'add' : pending.next.length === 0 ? 'delete' : 'modify',
			oldContextBefore: oldContext.before,
			oldContextAfter: oldContext.after,
			newContextBefore: newContext.before,
			newContextAfter: newContext.after,
			zoneAfterLineNumber: pending.newStart,
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
		pending ??= { oldStart: oldCursor, newStart: newCursor, old: [], next: [] };
		if (op.kind === 'delete') {
			pending.old.push(op.text);
			oldCursor += 1;
		} else {
			pending.next.push(op.text);
			newCursor += 1;
		}
	}
	flush();
	return hunks;
}
