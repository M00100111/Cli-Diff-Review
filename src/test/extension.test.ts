import * as assert from 'assert';
import { acceptHunkInBaseline, computeLineDiff } from '../diffEngine';
import { isDotReviewPath, shouldSkipReviewPath } from '../reviewFileFilter';
import { isStaleRevision, mapLineAfterLineEdits, SerialOperationQueue, shouldDeleteRejectedCurrentFileOnRefresh, skippedCurrentFile } from '../reviewState';
import { replaceLineBlock, splitLines } from '../text';
import { ReviewedHunk, ReviewHunk } from '../types';

suite('Diff engine', () => {
	test('detects added lines', () => {
		const hunks = computeLineDiff('file:///demo.ts', 'const a = 1;\n', 'const a = 1;\nconst b = 2;\n');

		assert.strictEqual(hunks.length, 1);
		assert.strictEqual(hunks[0].kind, 'add');
		assert.strictEqual(hunks[0].oldStart, 1);
		assert.strictEqual(hunks[0].oldLines, 0);
		assert.strictEqual(hunks[0].newStart, 1);
		assert.strictEqual(hunks[0].newLines, 1);
		assert.strictEqual(hunks[0].newText, 'const b = 2;\n');
	});

	test('detects deleted lines', () => {
		const hunks = computeLineDiff('file:///demo.ts', 'a\nb\nc\n', 'a\nc\n');

		assert.strictEqual(hunks.length, 1);
		assert.strictEqual(hunks[0].kind, 'delete');
		assert.strictEqual(hunks[0].oldStart, 1);
		assert.strictEqual(hunks[0].oldLines, 1);
		assert.strictEqual(hunks[0].newStart, 1);
		assert.strictEqual(hunks[0].newLines, 0);
		assert.strictEqual(hunks[0].oldText, 'b\n');
	});

	test('detects modified blocks', () => {
		const hunks = computeLineDiff('file:///demo.ts', 'a\nold\nc\n', 'a\nnew\nc\n');

		assert.strictEqual(hunks.length, 1);
		assert.strictEqual(hunks[0].kind, 'modify');
		assert.strictEqual(hunks[0].oldText, 'old\n');
		assert.strictEqual(hunks[0].newText, 'new\n');
	});

	test('preserves CRLF line endings in accepted hunks', () => {
		const oldText = 'a\r\nold\r\nc\r\n';
		const newText = 'a\r\nnew\r\nc\r\n';
		const [hunk] = computeLineDiff('file:///demo.ts', oldText, newText);

		assert.strictEqual(acceptHunkInBaseline(oldText, hunk), newText);
	});

	test('accepting every hunk makes the baseline match the current text', () => {
		let baseline = 'one\nold\nthree\n';
		const current = 'zero\none\nnew\nthree\nfour\n';

		while (baseline !== current) {
			const [hunk] = computeLineDiff('file:///demo.ts', baseline, current);
			baseline = acceptHunkInBaseline(baseline, hunk);
		}

		assert.strictEqual(baseline, current);
		assert.deepStrictEqual(computeLineDiff('file:///demo.ts', baseline, current), []);
	});

	test('undoing an accepted hunk uses the baseline coordinate', () => {
		const baseline = 'a\nb\nc\n';
		const current = 'a\nx\nb\nC\n';
		const target = shiftedModifyHunk(baseline, current);
		const accepted = reviewedHunk(target, 'accept', target.newStart, target.newLines, target.oldStart, target.newStart);
		const acceptedBaseline = acceptHunkInBaseline(baseline, target);

		const restoredWithDisplayStart = replaceLineBlock(acceptedBaseline, accepted.displayStart, accepted.newLines, accepted.oldText);
		const restoredWithBaselineStart = replaceLineBlock(acceptedBaseline, accepted.baselineStart, accepted.newLines, accepted.oldText);

		assert.notStrictEqual(restoredWithDisplayStart, baseline);
		assert.strictEqual(restoredWithBaselineStart, baseline);
	});

	test('keeps shifted hunk content stable across accept undo reject undo accept', () => {
		const originalBaseline = 'a\nb\nc\n';
		const originalCurrent = 'a\nx\nb\nC\n';
		let baseline = originalBaseline;
		let current = originalCurrent;

		let target = shiftedModifyHunk(baseline, current);
		let accepted = reviewedHunk(target, 'accept', target.newStart, target.newLines, target.oldStart, target.newStart);
		baseline = acceptHunkInBaseline(baseline, target);
		baseline = replaceLineBlock(baseline, accepted.baselineStart, accepted.newLines, accepted.oldText);

		assert.strictEqual(baseline, originalBaseline);

		target = shiftedModifyHunk(baseline, current);
		const rejected = reviewedHunk(target, 'reject', target.newStart, target.oldLines, target.oldStart, target.newStart);
		current = replaceLineBlock(current, target.newStart, target.newLines, target.oldText);
		current = replaceLineBlock(current, rejected.currentStart, rejected.displayLines, rejected.newText);

		assert.strictEqual(current, originalCurrent);

		target = shiftedModifyHunk(baseline, current);
		accepted = reviewedHunk(target, 'accept', target.newStart, target.newLines, target.oldStart, target.newStart);
		baseline = acceptHunkInBaseline(baseline, target);

		assert.strictEqual(accepted.baselineStart, 2);
		assert.strictEqual(accepted.displayStart, 3);
		assert.strictEqual(baseline, 'a\nb\nC\n');
		assert.strictEqual(current, originalCurrent);
	});
});

suite('Review state', () => {
	test('skips dot files and dot folders in review file discovery', () => {
		assert.strictEqual(isDotReviewPath('.env'), true);
		assert.strictEqual(isDotReviewPath('.github/workflows/release.yml'), true);
		assert.strictEqual(isDotReviewPath('src/.cache/output.txt'), true);
		assert.strictEqual(shouldSkipReviewPath('src/app.ts'), false);
		assert.strictEqual(shouldSkipReviewPath('src/file.name.ts'), false);
	});

	test('treats mismatched expected revisions as stale', () => {
		assert.strictEqual(isStaleRevision(3), false);
		assert.strictEqual(isStaleRevision(3, 3), false);
		assert.strictEqual(isStaleRevision(3, 2), true);
	});

	test('serializes operations for the same file key', async () => {
		const queue = new SerialOperationQueue<string>();
		const order: string[] = [];
		let releaseFirst: () => void = () => undefined;

		const first = queue.enqueue('file:///demo.ts', async () => {
			order.push('first:start');
			await new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			order.push('first:end');
		});
		const second = queue.enqueue('file:///demo.ts', async () => {
			order.push('second');
		});

		await Promise.resolve();
		await Promise.resolve();
		assert.deepStrictEqual(order, ['first:start']);

		releaseFirst();
		await Promise.all([first, second]);
		assert.deepStrictEqual(order, ['first:start', 'first:end', 'second']);
	});

	test('allows refresh to delete a rejected empty new current file', () => {
		assert.strictEqual(shouldDeleteRejectedCurrentFileOnRefresh(false, '', 0, 1), true);
		assert.strictEqual(shouldDeleteRejectedCurrentFileOnRefresh(true, '', 0, 1), false);
		assert.strictEqual(shouldDeleteRejectedCurrentFileOnRefresh(false, 'kept\n', 0, 1), false);
		assert.strictEqual(shouldDeleteRejectedCurrentFileOnRefresh(false, '', 1, 1), false);
		assert.strictEqual(shouldDeleteRejectedCurrentFileOnRefresh(false, '', 0, 0), false);
	});

	test('maps reviewed baseline starts through manual edits before the hunk', () => {
		const acceptedBaseline = 'a\nmanual\nb\nC\n';
		const mappedBaselineStart = mapLineAfterLineEdits(2, [{ oldStart: 1, oldLines: 0, newLines: 1 }]);
		const restored = replaceLineBlock(acceptedBaseline, mappedBaselineStart, 1, 'c\n');

		assert.strictEqual(mappedBaselineStart, 3);
		assert.strictEqual(restored, 'a\nmanual\nb\nc\n');
	});

	test('keeps skipped current snapshot files marked as existing', () => {
		const current = skippedCurrentFile('File exceeds cliDiff.maxFileBytes.');

		assert.strictEqual(current.exists, true);
		assert.strictEqual(current.text, '');
		assert.strictEqual(current.skippedReason, 'File exceeds cliDiff.maxFileBytes.');
	});
});

suite('Text helpers', () => {
	test('splits lines while preserving terminators', () => {
		assert.deepStrictEqual(splitLines('a\nb\r\nc'), ['a\n', 'b\r\n', 'c']);
	});

	test('replaces a line block', () => {
		assert.strictEqual(replaceLineBlock('a\nb\nc\n', 1, 1, 'B\n'), 'a\nB\nc\n');
	});
});

function shiftedModifyHunk(baseline: string, current: string): ReviewHunk {
	const hunk = computeLineDiff('file:///demo.ts', baseline, current).find((item) => item.kind === 'modify');
	assert.ok(hunk);
	assert.notStrictEqual(hunk.oldStart, hunk.newStart);
	return hunk;
}

function reviewedHunk(
	hunk: ReviewHunk,
	reviewSource: 'accept' | 'reject',
	displayStart: number,
	displayLines: number,
	baselineStart: number,
	currentStart: number,
): ReviewedHunk {
	return {
		...hunk,
		id: `${reviewSource}-${hunk.id}`,
		status: reviewSource === 'accept' ? 'accepted' : 'rejected',
		reviewSource,
		displayStart,
		displayLines,
		baselineStart,
		currentStart,
		reviewedAt: 1,
	};
}
