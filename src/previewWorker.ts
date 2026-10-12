import { computePreview, PreviewRequest } from './previewComputation';
// Avoid adding DOM globals to the extension's TypeScript compilation.
const scope = globalThis as unknown as {
	onmessage: (event: { data: PreviewRequest }) => void;
	postMessage: (message: unknown) => void;
};
scope.onmessage = ({ data }) => {
	try { scope.postMessage({ id: data.id, uri: data.uri, baselineVersion: data.baselineVersion, modelVersion: data.modelVersion, ...computePreview(data) }); }
	catch { scope.postMessage({ id: data.id, uri: data.uri, baselineVersion: data.baselineVersion, modelVersion: data.modelVersion, failed: true }); }
};
