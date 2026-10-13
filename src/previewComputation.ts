import { computeDisplayDiff, WordRange } from './inlineDiff';
export interface HunkHighlightRequest {
	id: number; uri: string; revision: number;
	hunks: { id: string; oldText: string; newText: string }[];
}
export interface HunkWordRanges { oldRanges: WordRange[]; newRanges: WordRange[] }
/** Only returns ranges inside supplied Git hunks, never replacement chunks. */
export function computeHunkHighlights(request: HunkHighlightRequest): { hunks: Record<string, HunkWordRanges> } {
	const deadline = performance.now() + 200;
	const hunks: Record<string, HunkWordRanges> = {};
	for (const hunk of request.hunks) {
		const result = computeDisplayDiff(hunk.oldText, hunk.newText, Math.max(0, deadline - performance.now()));
		const ranges: HunkWordRanges = { oldRanges: [], newRanges: [] };
		if (!result.timedOut && !result.wordsTimedOut) {
			for (const block of result.blocks) {
				ranges.oldRanges.push(...block.oldRanges.map(range => ({ ...range, line: range.line + block.oldStart })));
				ranges.newRanges.push(...block.newRanges.map(range => ({ ...range, line: range.line + block.newStart })));
			}
		}
		hunks[hunk.id] = ranges;
	}
	return { hunks };
}
