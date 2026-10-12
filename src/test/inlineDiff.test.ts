import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { computeDisplayDiff } from '../inlineDiff';
import { computePreview } from '../previewComputation';

suite('Display-only word diff', () => {
	test('highlights whole identifiers and separate edits', () => {
		const b = computeDisplayDiff('const count = oldValue;\n', 'const counter = newValue;\n').blocks[0];
		assert.deepStrictEqual(b.oldRanges, [{ line: 0, start: 6, end: 11 }, { line: 0, start: 14, end: 22 }]);
		assert.deepStrictEqual(b.newRanges, [{ line: 0, start: 6, end: 13 }, { line: 0, start: 16, end: 24 }]);
	});
	test('aligns inserted and repeated lines around unchanged anchors', () => {
		const result = computeDisplayDiff('repeat\nkeep\nrepeat\ncount\n', 'insert\nrepeat\nkeep\nrepeat\ncounter\n');
		assert.strictEqual(result.blocks.length, 2);
		assert.strictEqual(result.blocks[0].kind, 'add');
		assert.deepStrictEqual(result.blocks[0].newRanges, []);
		assert.strictEqual(result.blocks[1].newStart, 4);
	});
	test('leaves inserted whole lines light when adjacent lines are also modified', () => {
		const result = computeDisplayDiff('// staged baseline\nconst count = 1;\n', '// new unsaved block\n  // staged baseline\nconst counter = 1;\n');
		const block = result.blocks[0];
		assert.ok(block.newRanges.every(r => r.line !== 0));
		assert.ok(block.newRanges.some(r => r.line === 2 && r.start === 6 && r.end === 13));
	});
	test('uses UTF-16 columns with Unicode, tabs and escaped markup', () => {
		const b = computeDisplayDiff('\t😀 const 名称 = "<&>";\r\n', '\t😀 const 名字 = "<+>";\r\n').blocks[0];
		assert.deepStrictEqual(b.oldRanges, [{ line: 0, start: 10, end: 12 }, { line: 0, start: 17, end: 18 }]);
		assert.deepStrictEqual(b.newRanges, b.oldRanges);
	});
	test('handles empty files, final newline, whitespace and identical text', () => {
		assert.deepStrictEqual(computeDisplayDiff('same', 'same').blocks, []);
		assert.strictEqual(computeDisplayDiff('', 'x').blocks[0].kind, 'add');
		assert.strictEqual(computeDisplayDiff('x', '').blocks[0].kind, 'delete');
		assert.deepStrictEqual(computeDisplayDiff('x\r\n', 'x\n').blocks[0].newRanges, []);
		assert.deepStrictEqual(computeDisplayDiff('x', 'x\n').blocks[0].newRanges, []);
		assert.deepStrictEqual(computeDisplayDiff('a b', 'a  b').blocks[0].newRanges, [{ line: 0, start: 1, end: 3 }]);
	});
	test('returns no partial line result when over budget', () => {
		assert.deepStrictEqual(computeDisplayDiff('a', 'b', 0), { blocks: [], timedOut: true, wordsTimedOut: false });
	});
	test('drops every word range when token budget is exhausted', () => {
		const result = computeDisplayDiff('a '.repeat(1200), 'b '.repeat(1200), 10000);
		assert.strictEqual(result.timedOut, false);
		assert.strictEqual(result.wordsTimedOut, true);
		assert.deepStrictEqual(result.blocks[0].newRanges, []);
	});
	test('keeps formal hunk identities without producing mutation data', () => {
		const result = computePreview({ id: 1, uri: 'file:a', baselineVersion: 1, modelVersion: 1, oldText: '', newText: '', hunks: [{ id: 'git-id', oldText: 'count', newText: 'counter' }] });
		assert.ok(result.hunks?.['git-id'].blocks[0].newRanges.length);
		assert.strictEqual('patch' in result.hunks!['git-id'].blocks[0], false);
	});
	test('reconstructs randomly edited text from line blocks', () => {
		let seed = 42;
		const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
		for (let sample = 0; sample < 150; sample++) {
			const old = Array.from({ length: random() % 25 }, () => String(random() % 6) + '\n');
			const next = Array.from({ length: random() % 25 }, () => String(random() % 6) + '\n');
			const result = computeDisplayDiff(old.join(''), next.join(''), 1000);
			assert.strictEqual(result.timedOut, false);
			const rebuilt = [...old];
			for (const b of [...result.blocks].reverse()) { rebuilt.splice(b.oldStart, b.oldLines, ...(b.newText.match(/[^\n]*\n|[^\n]+$/g) || [])); }
			assert.strictEqual(rebuilt.join(''), next.join(''));
		}
	});
});

function previewHarness() {
	const timers = new Map<number, () => void>(); let timer = 0;
	const workers: Array<{ terminated: boolean; request: any; onmessage: (event: any) => void; terminate(): void; postMessage(request: any): void }> = [];
	const context = vm.createContext({ window: {}, fetch: async () => ({ ok: true, text: async () => '' }), URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} }, Blob: class {},
		setTimeout: (callback: () => void) => { timers.set(++timer, callback); return timer; }, clearTimeout: (id: number) => timers.delete(id),
		Worker: class {
			terminated = false; request: any; onmessage = () => {};
			constructor() { workers.push(this); }
			terminate() { this.terminated = true; }
			postMessage(request: any) { this.request = request; }
		},
	});
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../../resources/reviewPreview.js'), 'utf8'), context);
	const api = context.window;
	const controller = new api.CliDiffPreview('worker.js', () => {});
	let text = 'counter', version = 1;
	const model = { getValue: () => text, getVersionId: () => version };
	const state = { uri: 'file:a', comparisonBaseText: 'count', reviewText: 'counter', dirty: false, pendingHunks: [{ id: 'h', kind: 'modify', oldText: 'count', newText: 'counter' }] };
	return { api, controller, state, model, workers,
		edit(value: string) { text = value; version++; },
		async tick() { const first = timers.entries().next().value; if (first) { timers.delete(first[0]); await first[1](); } },
	};
}
suite('Preview task lifecycle', () => {
	test('cancels obsolete tasks and rejects stale worker replies', async () => {
		const h = previewHarness();
		h.controller.update(h.state, h.model, true); await h.tick();
		const old = h.workers[0];
		h.edit('counter + extra'); h.controller.update({ ...h.state, dirty: true }, h.model, false); await h.tick();
		assert.ok(old.terminated);
		old.onmessage({ data: { ...old.request, result: { blocks: [{ kind: 'delete' }] } } });
		assert.strictEqual(h.controller.blocks, null);
		const latest = h.workers[1];
		latest.onmessage({ data: { ...latest.request, result: { blocks: [] } } });
		assert.strictEqual(h.controller.blocks.length, 0);
	});
	test('uses non-operable previews until the saved review snapshot catches up', () => {
		const h = previewHarness(); h.edit('other');
		h.controller.update({ ...h.state, dirty: false }, h.model, true);
		assert.strictEqual(h.controller.isPreview(), true);
		const entries = h.controller.entries([{ id: 'h', decided: false }, { id: 'accepted', decided: true }]);
		assert.strictEqual(entries.length, 1); assert.strictEqual(entries[0].preview, true);
		h.state.reviewText = 'other'; h.controller.update(h.state, h.model, true);
		assert.strictEqual(h.controller.isPreview(), false);
	});
	test('invalidates cache on baseline change and disposes pending workers', async () => {
		const h = previewHarness(); h.controller.update(h.state, h.model, true); await h.tick();
		const worker = h.workers[0]; worker.onmessage({ data: { ...worker.request, hunks: {} } });
		assert.strictEqual(h.controller.cache.size, 1);
		h.controller.update({ ...h.state, comparisonBaseText: 'new index' }, h.model, true); await h.tick();
		assert.strictEqual(h.controller.cache.size, 0);
		h.controller.dispose(); assert.ok(h.workers[1].terminated);
	});
	test('projects tabs and UTF-16 source ranges for old-side markup', () => {
		const { api } = previewHarness();
		const projection = api.cliPreviewRendering.projectLine('\t😀 count', [{ start: 4, end: 9 }], 4);
		assert.strictEqual(projection.text, '    😀 count');
		assert.strictEqual(projection.ranges[0].start, 7); assert.strictEqual(projection.ranges[0].end, 12);
	});
});
