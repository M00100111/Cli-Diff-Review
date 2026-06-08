export class OperationCancelledError extends Error {
	public constructor() {
		super('Operation cancelled.');
		this.name = 'AbortError';
	}
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new OperationCancelledError();
	}
}

export function isAbortError(error: unknown): boolean {
	return error instanceof OperationCancelledError
		|| error instanceof Error && error.name === 'AbortError';
}
