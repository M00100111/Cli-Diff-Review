/** Display-only differences: zero-based UTF-16 columns, end exclusive. */
export interface WordRange { line: number; start: number; end: number }
export interface DisplayDiff {
	oldStart: number; newStart: number; oldLines: number; newLines: number;
	oldText: string; newText: string; kind: 'add' | 'delete' | 'modify';
	oldRanges: WordRange[]; newRanges: WordRange[];
}
export interface DiffResult { blocks: DisplayDiff[]; timedOut: boolean; wordsTimedOut: boolean }
class BudgetExceeded extends Error {}
type Op = { kind: 'equal' | 'delete' | 'insert'; index: number };

/** Bounded Myers: limit both elapsed time and retained frontier memory. */
function myers(a: string[], b: string[], check: () => void): Op[] {
	const trace: Map<number, number>[] = [];
	let frontier = new Map<number, number>([[1, 0]]), cells = 0;
	for (let d = 0; d <= a.length + b.length; d++) {
		check();
		const next = new Map<number, number>();
		for (let k = -d; k <= d; k += 2) {
			if (++cells > 500_000) { throw new BudgetExceeded(); }
			if ((cells & 255) === 0) { check(); }
			let x = k === -d || (k !== d && (frontier.get(k - 1) ?? -1) < (frontier.get(k + 1) ?? -1))
				? frontier.get(k + 1) ?? 0 : (frontier.get(k - 1) ?? 0) + 1;
			let y = x - k;
			while (x < a.length && y < b.length && a[x] === b[y]) {
				x++; y++;
				if ((x & 255) === 0) { check(); }
			}
			next.set(k, x);
			if (x >= a.length && y >= b.length) {
				trace.push(next);
				const ops: Op[] = [];
				for (let distance = trace.length - 1; distance > 0; distance--) {
					check();
					const prev = trace[distance - 1], diagonal = x - y;
					const pk = diagonal === -distance || (diagonal !== distance && (prev.get(diagonal - 1) ?? -1) < (prev.get(diagonal + 1) ?? -1)) ? diagonal + 1 : diagonal - 1;
					const px = prev.get(pk) ?? 0, py = px - pk;
					while (x > px && y > py) { ops.push({ kind: 'equal', index: --x }); y--; }
					if (x === px) { ops.push({ kind: 'insert', index: --y }); }
					else { ops.push({ kind: 'delete', index: --x }); }
				}
				while (x > 0 && y > 0) { ops.push({ kind: 'equal', index: --x }); y--; }
				while (x > 0) { ops.push({ kind: 'delete', index: --x }); }
				while (y > 0) { ops.push({ kind: 'insert', index: --y }); }
				return ops.reverse();
			}
		}
		trace.push(next); frontier = next;
	}
	return [];
}
function lines(text: string): string[] {
	return text.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g) ?? [];
}
type Token = WordRange & { text: string };
function tokens(text: string, check: () => void): Token[] {
	const result: Token[] = [];
	lines(text).forEach((line, index) => {
		check();
		const content = line.replace(/\r\n$|[\r\n]$/u, '');
		for (const match of content.matchAll(/[\p{L}\p{N}\p{M}_$]+|[^\S\r\n]+|[^\r\n]/gu)) {
			check();
			result.push({ text: match[0], line: index, start: match.index!, end: match.index! + match[0].length });
		}
		if (content.length !== line.length) { result.push({ text: '\n', line: index, start: content.length, end: content.length }); }
	});
	return result;
}

/** Pair changed lines by token similarity before word diffing. Unpaired lines
	* retain only their whole-line background; tokens never match across lines. */
function pairLines(a: Token[][], b: Token[][], check: () => void): [number, number][] {
	const width = b.length + 1;
	if ((a.length + 1) * width > 40_000) { throw new BudgetExceeded(); }
	const costs = new Float64Array((a.length + 1) * width);
	const directions = new Uint8Array(costs.length);
	const bags = (rows: Token[][]) => rows.map(row => {
		const counts = new Map<string, number>(); let size = 0;
		for (const token of row) {
			check();
			if (!token.text.trim()) { continue; }
			counts.set(token.text, (counts.get(token.text) ?? 0) + 1); size += token.text.length;
		}
		return { counts, size };
	});
	const left = bags(a), right = bags(b);
	for (let i = 1; i <= a.length; i++) { costs[i * width] = i; directions[i * width] = 1; }
	for (let j = 1; j <= b.length; j++) { costs[j] = j; directions[j] = 2; }
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			check(); let common = 0;
			for (const [text, count] of left[i - 1].counts) {
				check(); common += Math.min(count, right[j - 1].counts.get(text) ?? 0) * text.length;
			}
			const similarity = 2 * common / Math.max(1, left[i - 1].size + right[j - 1].size);
			const diagonal = costs[(i - 1) * width + j - 1] + 1.9 - 1.8 * similarity;
			const remove = costs[(i - 1) * width + j] + 1, insert = costs[i * width + j - 1] + 1;
			const index = i * width + j;
			if (diagonal <= remove && diagonal <= insert) { costs[index] = diagonal; }
			else if (remove <= insert) { costs[index] = remove; directions[index] = 1; }
			else { costs[index] = insert; directions[index] = 2; }
		}
	}
	const pairs: [number, number][] = [];
	let i = a.length, j = b.length;
	while (i || j) {
		const direction = directions[i * width + j];
		if (direction === 1) { i--; }
		else if (direction === 2) { j--; }
		else { pairs.push([--i, --j]); }
	}
	return pairs.reverse();
}

export function computeDisplayDiff(oldText: string, newText: string, budgetMs = 200, now: () => number = () => performance.now()): DiffResult {
	const result: DiffResult = { blocks: [], timedOut: false, wordsTimedOut: false };
	if (oldText === newText) { return result; }
	const deadline = now() + budgetMs;
	const check = () => { if (now() >= deadline) { throw new BudgetExceeded(); } };
	try {
		check();
		const old = lines(oldText), next = lines(newText);
		const ops = myers(old, next, check);
		let x = 0, y = 0;
		let block: DisplayDiff | undefined;
		const flush = () => {
			if (!block) { return; }
			block.kind = block.oldLines === 0 ? 'add' : block.newLines === 0 ? 'delete' : 'modify';
			block.oldText = old.slice(block.oldStart, x).join('');
			block.newText = next.slice(block.newStart, y).join('');
			result.blocks.push(block); block = undefined;
		};
		for (const op of ops) {
			check();
			if (op.kind === 'equal') { flush(); x++; y++; continue; }
			block ??= { oldStart: x, newStart: y, oldLines: 0, newLines: 0, oldText: '', newText: '', kind: 'modify', oldRanges: [], newRanges: [] };
			if (op.kind === 'delete') { block.oldLines++; x++; }
			else { block.newLines++; y++; }
		}
		flush();
	} catch (error) {
		if (!(error instanceof BudgetExceeded)) { throw error; }
		return { blocks: [], timedOut: true, wordsTimedOut: false };
	}
	try {
		for (const block of result.blocks) {
			if (block.kind !== 'modify') { continue; }
			const a: Token[][] = Array.from({ length: block.oldLines }, () => []);
			const b: Token[][] = Array.from({ length: block.newLines }, () => []);
			for (const token of tokens(block.oldText, check)) { if (token.end > token.start) { a[token.line].push(token); } }
			for (const token of tokens(block.newText, check)) { if (token.end > token.start) { b[token.line].push(token); } }
			const oldRanges: WordRange[] = [], newRanges: WordRange[] = [];
			for (const [oldLine, newLine] of pairLines(a, b, check)) {
				const oldTokens = a[oldLine], newTokens = b[newLine];
				const ops = myers(oldTokens.map(t => t.text), newTokens.map(t => t.text), check);
				for (const op of ops) {
					check();
					if (op.kind === 'equal') { continue; }
					const token = (op.kind === 'delete' ? oldTokens : newTokens)[op.index];
					(op.kind === 'delete' ? oldRanges : newRanges).push({ line: token.line, start: token.start, end: token.end });
				}
			}
			block.oldRanges = oldRanges; block.newRanges = newRanges;
		}
	} catch (error) {
		if (!(error instanceof BudgetExceeded)) { throw error; }
		result.wordsTimedOut = true;
		for (const block of result.blocks) { block.oldRanges = []; block.newRanges = []; }
	}
	return result;
}
