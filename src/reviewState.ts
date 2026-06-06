export function isStaleRevision(currentRevision: number, expectedRevision?: number): boolean {
	return typeof expectedRevision === 'number' && currentRevision !== expectedRevision;
}

export interface CurrentTextState {
	text: string;
	exists: boolean;
	skippedReason?: string;
}

export interface LineEdit {
	oldStart: number;
	oldLines: number;
	newLines: number;
}

export function skippedCurrentFile(skippedReason: string): CurrentTextState {
	return { text: '', exists: true, skippedReason };
}

export function shouldDeleteRejectedCurrentFileOnRefresh(
	baselineExists: boolean,
	currentText: string,
	acceptedHunkCount: number,
	rejectedHunkCount: number,
): boolean {
	return !baselineExists && currentText.length === 0 && acceptedHunkCount === 0 && rejectedHunkCount > 0;
}

export function mapLineAfterLineEdits(line: number, edits: LineEdit[]): number {
	let mappedLine = line;
	for (const edit of [...edits].sort((left, right) => left.oldStart - right.oldStart)) {
		if (edit.oldStart < line && edit.oldStart + edit.oldLines <= line) {
			mappedLine += edit.newLines - edit.oldLines;
		}
	}
	return Math.max(0, mappedLine);
}

export class SerialOperationQueue<TKey> {
	private readonly queues = new Map<TKey, Promise<void>>();

	public async enqueue(key: TKey, operation: () => Promise<void>): Promise<void> {
		const previous = this.queues.get(key) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(operation);
		this.queues.set(key, current);
		try {
			await current;
		} finally {
			if (this.queues.get(key) === current) {
				this.queues.delete(key);
			}
		}
	}
}
