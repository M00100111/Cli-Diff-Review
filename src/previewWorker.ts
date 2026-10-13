import { computeHunkHighlights, HunkHighlightRequest } from './previewComputation';
// Avoid adding DOM globals to the extension's TypeScript compilation.
const scope = globalThis as unknown as {
	onmessage: (event: { data: HunkHighlightRequest }) => void;
	postMessage: (message: unknown) => void;
};
scope.onmessage = ({ data }) => {
	try { scope.postMessage({ id: data.id, uri: data.uri, revision: data.revision, ...computeHunkHighlights(data) }); }
	catch { scope.postMessage({ id: data.id, uri: data.uri, revision: data.revision, failed: true }); }
};
