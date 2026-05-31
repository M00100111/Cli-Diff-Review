import * as assert from 'assert';
import { acceptHunkInBaseline, computeLineDiff } from '../diffEngine';
import { replaceLineBlock, splitLines } from '../text';

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
});

suite('Text helpers', () => {
	test('splits lines while preserving terminators', () => {
		assert.deepStrictEqual(splitLines('a\nb\r\nc'), ['a\n', 'b\r\n', 'c']);
	});

	test('replaces a line block', () => {
		assert.strictEqual(replaceLineBlock('a\nb\nc\n', 1, 1, 'B\n'), 'a\nB\nc\n');
	});
});
