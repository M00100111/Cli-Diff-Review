import * as path from 'path';
import * as vscode from 'vscode';

export function splitLines(text: string): string[] {
	if (text.length === 0) {
		return [];
	}

	const matches = text.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g);
	return matches ?? [];
}

export function replaceLineBlock(text: string, start: number, deleteCount: number, insertText: string): string {
	const lines = splitLines(text);
	const clampedStart = Math.max(0, Math.min(start, lines.length));
	lines.splice(clampedStart, Math.max(0, deleteCount), ...splitLines(insertText));
	return lines.join('');
}

export function lineRange(document: vscode.TextDocument, startLine: number, lineCount: number): vscode.Range {
	if (lineCount === 0) {
		const position = positionAtLineBoundary(document, startLine);
		return new vscode.Range(position, position);
	}

	const start = positionAtLineBoundary(document, startLine);
	const end = positionAtLineBoundary(document, startLine + lineCount);
	return new vscode.Range(start, end);
}

function positionAtLineBoundary(document: vscode.TextDocument, line: number): vscode.Position {
	if (line <= 0) {
		return new vscode.Position(0, 0);
	}

	if (line >= document.lineCount) {
		return document.positionAt(document.getText().length);
	}

	return new vscode.Position(line, 0);
}

export function isProbablyBinary(data: Uint8Array): boolean {
	const sampleLength = Math.min(data.length, 8000);
	for (let index = 0; index < sampleLength; index += 1) {
		if (data[index] === 0) {
			return true;
		}
	}

	return false;
}

export function decodeUtf8(data: Uint8Array): string {
	return Buffer.from(data).toString('utf8');
}

export function encodeUtf8(text: string): Uint8Array {
	return Buffer.from(text, 'utf8');
}

export function relativePath(root: vscode.Uri, uri: vscode.Uri): string {
	return path.relative(root.fsPath, uri.fsPath).replace(/\\/g, '/');
}

export function uriFromRelativePath(root: vscode.Uri, relative: string): vscode.Uri {
	return vscode.Uri.joinPath(root, ...relative.split('/').filter(Boolean));
}
