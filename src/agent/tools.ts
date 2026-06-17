import * as path from 'path';
import * as vscode from 'vscode';
import { gitIgnoredReviewPaths, normalizeReviewPath } from '../reviewFileFilter';
import { decodeUtf8, encodeUtf8, isProbablyBinary, relativePath } from '../text';
import { ReviewFileState, ReviewSession } from '../types';
import { throwIfAborted } from '../wiki/cancellation';
import { AgentTool } from './runtime';

export interface AgentToolOptions {
	root: vscode.WorkspaceFolder;
	generatedFiles?: Set<string>;
	maxFiles?: number;
	maxFileBytes?: number;
	maxReadChars?: number;
	reviewSession?: ReviewSession;
	includeWikiTools?: boolean;
}

const protectedWikiFiles = new Set(['schema.md', 'SKILL.md', '.state.json']);
const requiredWikiFiles = new Set([
	'index.md',
	'overview.md',
	'architecture.md',
	'modules.md',
	'interfaces.md',
	'workflows.md',
	'decisions.md',
	'open-questions.md',
	'log.md',
]);

export function createReadOnlyAgentTools(options: AgentToolOptions): AgentTool[] {
	const tools = [
		tool('list_workspace_files', 'List readable source files in the workspace. Arguments: {}.', objectSchema({}), async (_args, signal) => {
			return { files: await listWorkspaceFiles(options, signal) };
		}),
		tool('read_workspace_file', 'Read one source file. Arguments: {"path":"src/app.ts"}.', objectSchema({ path: stringSchema('Repository-relative source path.') }), async (args, signal) => {
			return readWorkspaceFile(options, stringArgument(args, 'path'), signal);
		}),
		tool('search_workspace', 'Search readable source files for a literal text query. Arguments: {"query":"symbol","limit":50}.', objectSchema({
			query: stringSchema('Literal text query.'),
			limit: { type: 'integer', description: 'Maximum results from 1 to 200.', minimum: 1, maximum: 200 },
		}), async (args, signal) => {
			return searchWorkspace(options, stringArgument(args, 'query'), numberArgument(args, 'limit', 50), signal);
		}),
	];
	if (!options.includeWikiTools) {
		return tools;
	}
	return [
		...tools,
		tool('list_wiki_files', 'List existing Markdown files under .skills/llm-code-wiki/references. Arguments: {}.', objectSchema({}), async (_args, signal) => {
			return { files: await listWikiFiles(options.root.uri, signal) };
		}),
		tool('read_wiki_file', 'Read one Markdown file under .skills/llm-code-wiki/references. Arguments: {"path":"architecture.md"}.', objectSchema({ path: stringSchema('Path relative to the Wiki references directory.') }), async (args, signal) => {
			return readTextFile(options, wikiFileUri(options.root.uri, stringArgument(args, 'path'), true), signal);
		}),
	];
}

export function createWikiAgentTools(options: AgentToolOptions): AgentTool[] {
	return [
		...createReadOnlyAgentTools({ ...options, includeWikiTools: true }),
		tool('write_wiki_file', 'Create or replace generated Markdown under .skills/llm-code-wiki/references. Arguments: {"path":"overview.md","content":"# Overview"}; protected files cannot be changed.', objectSchema({
			path: stringSchema('Markdown path relative to the Wiki references directory.'),
			content: stringSchema('Complete Markdown file content.'),
		}), async (args, signal) => {
			throwIfAborted(signal);
			const relativePath = normalizeWikiMarkdownPath(stringArgument(args, 'path'), false);
			const content = stringArgument(args, 'content');
			const uri = wikiFileUri(options.root.uri, relativePath, false);
			await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
			throwIfAborted(signal);
			await vscode.workspace.fs.writeFile(uri, encodeUtf8(content));
			options.generatedFiles?.add(relativePath);
			return { path: relativePath, chars: content.length };
		}),
		tool('delete_generated_wiki_file', 'Delete one previously generated Markdown file under .skills/llm-code-wiki/references. Arguments: {"path":"modules/old.md"}.', objectSchema({ path: stringSchema('Generated Markdown path relative to the Wiki references directory.') }), async (args, signal) => {
			throwIfAborted(signal);
			const relativePath = normalizeWikiMarkdownPath(stringArgument(args, 'path'), false);
			if (requiredWikiFiles.has(relativePath)) {
				throw new Error(`Required wiki file cannot be deleted: ${relativePath}`);
			}
			if (!options.generatedFiles?.has(relativePath)) {
				throw new Error('Only tracked generated wiki files may be deleted.');
			}
			try {
				await vscode.workspace.fs.delete(wikiFileUri(options.root.uri, relativePath, false));
			} catch {
				// Deleting an already absent generated file is idempotent.
			}
			options.generatedFiles.delete(relativePath);
			return { path: relativePath, deleted: true };
		}),
		tool('append_wiki_log', 'Append a short Markdown entry to .skills/llm-code-wiki/references/log.md. Arguments: {"content":"## Entry..."}.', objectSchema({ content: stringSchema('Short Markdown log entry.') }), async (args, signal) => {
			throwIfAborted(signal);
			const uri = wikiFileUri(options.root.uri, 'log.md', false);
			let existing = '';
			try {
				existing = decodeUtf8(await vscode.workspace.fs.readFile(uri));
			} catch {
				existing = '# Log\n';
			}
			const content = stringArgument(args, 'content');
			await vscode.workspace.fs.writeFile(uri, encodeUtf8(`${existing.trimEnd()}\n\n${content.trim()}\n`));
			options.generatedFiles?.add('log.md');
			return { path: 'log.md', appendedChars: content.length };
		}),
	];
}

async function listWorkspaceFiles(options: AgentToolOptions, signal?: AbortSignal): Promise<string[]> {
	throwIfAborted(signal);
	const uris = await vscode.workspace.findFiles(
		new vscode.RelativePattern(options.root, '**/*'),
		'**/{.git,.skills,node_modules,dist,out,.vscode-test}/**',
		options.maxFiles ?? 2000,
	);
	const paths = new Map(uris.map((uri) => [uri.toString(), normalizeReviewPath(relativePath(options.root.uri, uri))]));
	const ignored = await gitIgnoredReviewPaths(options.root, [...paths.values()]);
	const files: string[] = [];
	for (const uri of uris) {
		throwIfAborted(signal);
		const candidate = paths.get(uri.toString());
		if (!candidate || ignored.has(candidate) || candidate.split('/').some((segment) => segment.startsWith('.'))) {
			continue;
		}
		files.push(candidate);
	}
	for (const file of reviewSnapshotFiles(options)) {
		if (!files.includes(file.relativePath)) {
			files.push(file.relativePath);
		}
	}
	return files.sort();
}

async function listWikiFiles(rootUri: vscode.Uri, signal?: AbortSignal): Promise<string[]> {
	throwIfAborted(signal);
	const wikiUri = wikiReferencesUri(rootUri);
	try {
		const entries = await vscode.workspace.fs.readDirectory(wikiUri);
		return listWikiEntries(wikiUri, entries, '', signal);
	} catch {
		return [];
	}
}

async function listWikiEntries(
	parent: vscode.Uri,
	entries: [string, vscode.FileType][],
	prefix: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const files: string[] = [];
	for (const [name, type] of entries) {
		throwIfAborted(signal);
		const candidate = prefix ? `${prefix}/${name}` : name;
		if (type === vscode.FileType.Directory) {
			files.push(...await listWikiEntries(vscode.Uri.joinPath(parent, name), await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(parent, name)), candidate, signal));
		} else if (candidate.endsWith('.md')) {
			files.push(candidate);
		}
	}
	return files.sort();
}

async function readWorkspaceFile(options: AgentToolOptions, candidate: string, signal?: AbortSignal): Promise<{
	path: string;
	content: string;
	truncated: boolean;
	currentExists: boolean;
	contentSource: 'workspace' | 'reviewNewText' | 'reviewOldText';
}> {
	const normalized = normalizeSafeRelativePath(candidate);
	if (normalized.split('/').some((segment) => segment.startsWith('.'))) {
		throw new Error('Source tools cannot read dot-path files.');
	}
	const reviewFile = reviewSnapshotFiles(options).find((file) => file.relativePath === normalized);
	if (reviewFile) {
		const text = reviewFile.currentExists ? reviewFile.newText : reviewFile.oldText;
		const maxChars = options.maxReadChars ?? 50000;
		return {
			path: reviewFile.relativePath,
			content: text.slice(0, maxChars),
			truncated: text.length > maxChars,
			currentExists: reviewFile.currentExists,
			contentSource: reviewFile.currentExists ? 'reviewNewText' : 'reviewOldText',
		};
	}
	const result = await readTextFile(options, workspaceFileUri(options.root.uri, normalized), signal);
	return { ...result, currentExists: true, contentSource: 'workspace' };
}

async function readTextFile(options: AgentToolOptions, uri: vscode.Uri, signal?: AbortSignal): Promise<{ path: string; content: string; truncated: boolean }> {
	throwIfAborted(signal);
	const data = await vscode.workspace.fs.readFile(uri);
	if (data.length > (options.maxFileBytes ?? 300000) || isProbablyBinary(data)) {
		throw new Error('File is binary or exceeds the agent file size limit.');
	}
	const text = decodeUtf8(data);
	const maxChars = options.maxReadChars ?? 50000;
	return {
		path: normalizeReviewPath(relativePath(options.root.uri, uri)),
		content: text.slice(0, maxChars),
		truncated: text.length > maxChars,
	};
}

async function searchWorkspace(options: AgentToolOptions, query: string, limit: number, signal?: AbortSignal): Promise<{ matches: Array<{ path: string; line: number; text: string }> }> {
	if (!query) {
		throw new Error('Search query is required.');
	}
	const matches: Array<{ path: string; line: number; text: string }> = [];
	for (const candidate of await listWorkspaceFiles(options, signal)) {
		throwIfAborted(signal);
		try {
			const read = await readWorkspaceFile(options, candidate, signal);
			for (const [index, line] of read.content.split(/\r?\n/).entries()) {
				if (line.includes(query)) {
					matches.push({ path: candidate, line: index + 1, text: line.slice(0, 500) });
					if (matches.length >= Math.max(1, Math.min(limit, 200))) {
						return { matches };
					}
				}
			}
		} catch {
			// Files can disappear while an agent is searching.
		}
	}
	return { matches };
}

function reviewSnapshotFiles(options: AgentToolOptions): ReviewFileState[] {
	return options.reviewSession
		? [...options.reviewSession.files.values()]
			.filter((file) => !file.relativePath.replace(/\\/g, '/').split('/').some((segment) => segment.startsWith('.')))
			.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
		: [];
}

function tool(name: string, description: string, parameters: Record<string, unknown>, execute: AgentTool['execute']): AgentTool {
	return { name, description, parameters, execute };
}

function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
	return {
		type: 'object',
		properties,
		required: Object.keys(properties),
		additionalProperties: false,
	};
}

function stringSchema(description: string): Record<string, unknown> {
	return { type: 'string', description };
}

function stringArgument(args: Record<string, unknown>, name: string): string {
	const value = args[name];
	if (typeof value !== 'string') {
		throw new Error(`Tool argument ${name} must be a string.`);
	}
	return value;
}

function numberArgument(args: Record<string, unknown>, name: string, fallback: number): number {
	const value = args[name];
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function workspaceFileUri(rootUri: vscode.Uri, candidate: string): vscode.Uri {
	const normalized = normalizeSafeRelativePath(candidate);
	if (normalized.split('/').some((segment) => segment.startsWith('.'))) {
		throw new Error('Source tools cannot read dot-path files.');
	}
	return containedUri(rootUri, normalized);
}

function wikiFileUri(rootUri: vscode.Uri, candidate: string, allowProtected: boolean): vscode.Uri {
	const normalized = normalizeWikiMarkdownPath(candidate, allowProtected);
	return containedUri(wikiReferencesUri(rootUri), normalized);
}

function wikiReferencesUri(rootUri: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(rootUri, '.skills', 'llm-code-wiki', 'references');
}

function normalizeWikiMarkdownPath(candidate: string, allowProtected: boolean): string {
	const normalized = normalizeSafeRelativePath(candidate);
	if (!normalized.endsWith('.md')) {
		throw new Error('Wiki tools only support Markdown files.');
	}
	if (!allowProtected && protectedWikiFiles.has(normalized)) {
		throw new Error(`Wiki file is protected: ${normalized}`);
	}
	return normalized;
}

function normalizeSafeRelativePath(candidate: string): string {
	const normalized = candidate.trim().replace(/\\/g, '/');
	if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
		throw new Error(`Invalid relative path: ${candidate}`);
	}
	if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
		throw new Error(`Invalid relative path: ${candidate}`);
	}
	return normalized;
}

function containedUri(rootUri: vscode.Uri, relative: string): vscode.Uri {
	const target = vscode.Uri.joinPath(rootUri, ...relative.split('/'));
	const rootPath = path.resolve(rootUri.fsPath);
	const targetPath = path.resolve(target.fsPath);
	if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
		throw new Error('Path escapes the allowed root.');
	}
	return target;
}
