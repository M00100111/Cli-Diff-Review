import { computeDisplayDiff, DiffResult } from './inlineDiff';
export interface PreviewRequest {
	id: number; uri: string; baselineVersion: number; modelVersion: number;
	oldText: string; newText: string;
	hunks?: { id: string; oldText: string; newText: string }[];
}
export function computePreview(request: PreviewRequest): { result?: DiffResult; hunks?: Record<string, DiffResult> } {
	if (!request.hunks) { return { result: computeDisplayDiff(request.oldText, request.newText) }; }
	const deadline = performance.now() + 200;
	const hunks: Record<string, DiffResult> = {};
	for (const hunk of request.hunks) {
		hunks[hunk.id] = computeDisplayDiff(hunk.oldText, hunk.newText, Math.max(0, deadline - performance.now()));
	}
	return { hunks };
}
