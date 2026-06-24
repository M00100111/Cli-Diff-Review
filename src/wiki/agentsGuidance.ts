import * as vscode from 'vscode';
import { decodeUtf8, encodeUtf8 } from '../text';
import { agentsGuidanceFileName } from './paths';

export const agentsGuidanceStartMarker = '<!-- CLI_DIFF_REVIEW_LLM_CODE_WIKI_START -->';
export const agentsGuidanceEndMarker = '<!-- CLI_DIFF_REVIEW_LLM_CODE_WIKI_END -->';

export async function writeManagedAgentsGuidance(rootUri: vscode.Uri, content: string): Promise<void> {
	const uri = vscode.Uri.joinPath(rootUri, agentsGuidanceFileName);
	const existing = await readOptionalText(uri);
	await vscode.workspace.fs.writeFile(uri, encodeUtf8(mergeManagedAgentsGuidance(existing, content)));
}

export async function removeManagedAgentsGuidance(rootUri: vscode.Uri): Promise<void> {
	const uri = vscode.Uri.joinPath(rootUri, agentsGuidanceFileName);
	const existing = await readOptionalText(uri);
	if (existing === undefined) {
		return;
	}
	const next = removeManagedAgentsGuidanceBlock(existing);
	if (next === undefined) {
		await vscode.workspace.fs.delete(uri, { useTrash: false });
		return;
	}
	if (next !== existing) {
		await vscode.workspace.fs.writeFile(uri, encodeUtf8(next));
	}
}

export function mergeManagedAgentsGuidance(existing: string | undefined, content: string): string {
	const block = renderManagedBlock(content);
	if (!existing || existing.trim().length === 0) {
		return `${block}\n`;
	}
	const range = managedBlockRange(existing);
	if (range) {
		return joinDocumentParts(existing.slice(0, range.start), block, existing.slice(range.end));
	}
	return joinDocumentParts(existing, block);
}

export function removeManagedAgentsGuidanceBlock(existing: string): string | undefined {
	const range = managedBlockRange(existing);
	if (!range) {
		return existing;
	}
	const next = joinDocumentParts(existing.slice(0, range.start), existing.slice(range.end));
	return next.trim().length > 0 ? next : undefined;
}

function renderManagedBlock(content: string): string {
	const normalized = content.trim();
	if (!normalized) {
		throw new Error('AGENTS.md guidance content cannot be empty.');
	}
	if (normalized.includes(agentsGuidanceStartMarker) || normalized.includes(agentsGuidanceEndMarker)) {
		throw new Error('AGENTS.md guidance content cannot include managed block markers.');
	}
	return [
		agentsGuidanceStartMarker,
		'',
		normalized,
		'',
		agentsGuidanceEndMarker,
	].join('\n');
}

function managedBlockRange(text: string): { start: number; end: number } | undefined {
	const start = text.indexOf(agentsGuidanceStartMarker);
	if (start < 0) {
		return undefined;
	}
	const endMarkerStart = text.indexOf(agentsGuidanceEndMarker, start + agentsGuidanceStartMarker.length);
	if (endMarkerStart < 0) {
		return undefined;
	}
	return { start, end: endMarkerStart + agentsGuidanceEndMarker.length };
}

function joinDocumentParts(...parts: string[]): string {
	const joined = parts
		.map((part) => part.trim())
		.filter(Boolean)
		.join('\n\n');
	return `${joined}\n`;
}

async function readOptionalText(uri: vscode.Uri): Promise<string | undefined> {
	try {
		return decodeUtf8(await vscode.workspace.fs.readFile(uri));
	} catch {
		return undefined;
	}
}
