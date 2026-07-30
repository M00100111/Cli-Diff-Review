import * as path from 'path';
import * as vscode from 'vscode';
import { gitIgnoredReviewPaths, normalizeReviewPath } from '../reviewFileFilter';
import { decodeUtf8, encodeUtf8, isProbablyBinary, relativePath, splitLines } from '../text';
import { ReviewFileState, ReviewSession } from '../types';
import { writeManagedAgentsGuidance } from '../wiki/agentsGuidance';
import { throwIfAborted } from '../wiki/cancellation';
import { isGeneratedAgentsGuidancePath, wikiReferencesPath } from '../wiki/paths';
import { AgentTool } from './runtime';

export interface AgentToolOptions {
	root: vscode.WorkspaceFolder;
	generatedFiles?: Set<string>;
	maxFiles?: number;
	maxReadChars?: number;
	reviewSession?: ReviewSession;
	includeWikiTools?: boolean;
	allowedWorkspacePaths?: string[];
	onAgentsGuidanceWritten?: () => void;
	onWikiMutation?: () => void | Promise<void>;
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
const searchModes = ['literal', 'fuzzy', 'regex'] as const;

type SearchMode = typeof searchModes[number];
type SearchMatch = { path: string; line: number; text: string };
type WorkspaceFileRead = {
	path: string;
	content: string;
	truncated: boolean;
	currentExists: boolean;
	contentSource: 'workspace' | 'reviewNewText' | 'reviewOldText';
	startLine: number;
	endLine: number;
	totalLines: number;
};

type WorkspaceDirectoryEntry = {
	name: string;
	path: string;
	type: 'file' | 'directory';
};

const excludedSourceDirectoryNames = new Set(['.git', '.agents', '.skills', 'node_modules', 'dist', 'out', '.vscode-test']);

export function createReadOnlyAgentTools(options: AgentToolOptions): AgentTool[] {
	const tools = [
		tool('list_workspace_files', 'List readable source files in the workspace. Arguments: {}.', objectSchema({}), async (_args, signal) => {
			return { files: await listWorkspaceFiles(options, signal) };
		}),
		tool('list_workspace_directory', 'List the direct files and directories under one source directory. Arguments: {"path":"src"}; use "." for the workspace root.', objectSchema({
			path: stringSchema('Repository-relative source directory path, or "." for the workspace root.'),
		}), async (args, signal) => {
			return listWorkspaceDirectory(options, stringArgument(args, 'path'), signal);
		}),
		tool('read_workspace_file', 'Read one source file, optionally by line range. Arguments: {"path":"src/app.ts","offset":120,"limit":50}; offset is a 1-based line number and limit 0 means no line-count limit.', objectSchema({
			path: stringSchema('Repository-relative source file path.'),
			offset: { type: 'integer', description: '1-based starting line. Use 1 to start at the beginning.', minimum: 1, default: 1 },
			limit: { type: 'integer', description: 'Maximum number of lines to return. Use 0 for no line-count limit.', minimum: 0, default: 0 },
		}), async (args, signal) => {
			return readWorkspaceFile(
				options,
				stringArgument(args, 'path'),
				optionalPositiveIntegerArgument(args, 'offset') ?? 1,
				optionalLineLimitArgument(args, 'limit'),
				signal,
			);
		}),
		tool('search_workspace', 'Search readable source files. Arguments: {"query":"symbol","mode":"literal","limit":50}. Modes: literal (case-sensitive substring), fuzzy (case-insensitive ordered characters), regex (JavaScript regular expression per line).', objectSchema({
			query: stringSchema('Search text or regular expression.'),
			mode: enumStringSchema('Search mode.', searchModes),
			limit: { type: 'integer', description: 'Maximum results from 1 to 200.', minimum: 1, maximum: 200 },
		}), async (args, signal) => {
			return searchWorkspace(options, stringArgument(args, 'query'), searchModeArgument(args), numberArgument(args, 'limit', 50), signal);
		}),
		tool('list_pending_changes', 'List all pending review changes and their hunks. Arguments: {}.', objectSchema({}), async (_args, signal) => {
			throwIfAborted(signal);
			return { files: pendingChangeFiles(options) };
		}),
		tool('read_pending_change', 'Read pending review hunks for one file. Arguments: {"path":"src/app.ts"}.', objectSchema({ path: stringSchema('Repository-relative pending review path.') }), async (args, signal) => {
			throwIfAborted(signal);
			return readPendingChange(options, stringArgument(args, 'path'));
		}),
	];
	if (!options.includeWikiTools) {
		return tools;
	}
	return [
		...tools,
		tool('list_wiki_files', `List existing Markdown files under ${wikiReferencesPath}. Arguments: {}.`, objectSchema({}), async (_args, signal) => {
			return { files: await listWikiFiles(options.root.uri, signal) };
		}),
		tool('read_wiki_file', `Read one Markdown file under ${wikiReferencesPath}. Arguments: {"path":"architecture.md"}.`, objectSchema({ path: stringSchema('Path relative to the Wiki references directory.') }), async (args, signal) => {
			return readTextFile(options, wikiFileUri(options.root.uri, stringArgument(args, 'path'), true), signal);
		}),
		tool('search_wiki_files', `Search Markdown files under ${wikiReferencesPath}. Arguments: {"query":"contract","mode":"literal","limit":50}. Modes: literal (case-sensitive substring), fuzzy (case-insensitive ordered characters), regex (JavaScript regular expression per line).`, objectSchema({
			query: stringSchema('Search text or regular expression.'),
			mode: enumStringSchema('Search mode.', searchModes),
			limit: { type: 'integer', description: 'Maximum results from 1 to 200.', minimum: 1, maximum: 200 },
		}), async (args, signal) => {
			return searchWikiFiles(options, stringArgument(args, 'query'), searchModeArgument(args), numberArgument(args, 'limit', 50), signal);
		}),
	];
}

export function createWikiAgentTools(options: AgentToolOptions): AgentTool[] {
	return [
		...createReadOnlyAgentTools({ ...options, includeWikiTools: true }),
		tool('write_wiki_file', `Create or replace generated Markdown under ${wikiReferencesPath}. Arguments: {"path":"overview.md","content":"# Overview"}; protected files cannot be changed.`, objectSchema({
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
			await options.onWikiMutation?.();
			return { path: relativePath, chars: content.length };
		}),
		tool('delete_generated_wiki_file', `Delete one previously generated Markdown file under ${wikiReferencesPath}. Arguments: {"path":"modules/old.md"}.`, objectSchema({ path: stringSchema('Generated Markdown path relative to the Wiki references directory.') }), async (args, signal) => {
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
			await options.onWikiMutation?.();
			return { path: relativePath, deleted: true };
		}),
		tool('append_wiki_log', `Append a short Markdown entry to ${wikiReferencesPath}/log.md. Arguments: {"content":"## Entry..."}.`, objectSchema({ content: stringSchema('Short Markdown log entry.') }), async (args, signal) => {
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
			await options.onWikiMutation?.();
			return { path: 'log.md', appendedChars: content.length };
		}),
		tool('write_agents_guidance', 'Create or refresh the Cli Diff Review managed block in the repository root AGENTS.md. Arguments: {"content":"# Project guide..."}; this tool cannot write any other file.', objectSchema({
			content: stringSchema('Complete Markdown content for the managed AGENTS.md block. Include a concise project introduction, invite coding agents to improve source-grounded wiki pages under .agents/skills/llm-code-wiki/references when code changes affect durable project knowledge, list the durable-knowledge triggers, explain that formatting-only/comment-only/mechanical cleanups usually do not need wiki updates if the final response says why, require agents to state whether wiki pages were updated, and state that SKILL.md, references/schema.md, and .state.json are protected.'),
		}), async (args, signal) => {
			throwIfAborted(signal);
			const content = stringArgument(args, 'content');
			await writeManagedAgentsGuidance(options.root.uri, content);
			options.onAgentsGuidanceWritten?.();
			await options.onWikiMutation?.();
			return { path: 'AGENTS.md', chars: content.length };
		}),
	];
}

async function listWorkspaceFiles(options: AgentToolOptions, signal?: AbortSignal): Promise<string[]> {
	throwIfAborted(signal);
	const uris = await vscode.workspace.findFiles(
		new vscode.RelativePattern(options.root, '**/*'),
		'**/{.git,.agents,.skills,node_modules,dist,out,.vscode-test}/**',
		options.maxFiles ?? 2000,
	);
	const paths = new Map(uris.map((uri) => [uri.toString(), normalizeReviewPath(relativePath(options.root.uri, uri))]));
	const ignored = await gitIgnoredReviewPaths(options.root, [...paths.values()]);
	const files: string[] = [];
	for (const uri of uris) {
		throwIfAborted(signal);
		const candidate = paths.get(uri.toString());
		if (!candidate
			|| isGeneratedAgentsGuidancePath(candidate)
			|| ignored.has(candidate)
			|| candidate.split('/').some((segment) => segment.startsWith('.'))
			|| !workspacePathAllowed(options, candidate)) {
			continue;
		}
		files.push(candidate);
	}
	for (const file of reviewSnapshotFiles(options)) {
		if (workspacePathAllowed(options, file.relativePath) && !files.includes(file.relativePath)) {
			files.push(file.relativePath);
		}
	}
	return files.sort();
}

async function listWorkspaceDirectory(
	options: AgentToolOptions,
	candidate: string,
	signal?: AbortSignal,
): Promise<{ path: string; entries: WorkspaceDirectoryEntry[] }> {
	throwIfAborted(signal);
	const normalized = normalizeSafeDirectoryPath(candidate);
	if (!workspaceDirectoryAllowed(options, normalized)) {
		throw new Error(`Workspace directory "${normalized || '.'}" is outside the assigned module scope.`);
	}
	const uri = normalized ? containedUri(options.root.uri, normalized) : options.root.uri;
	const displayPath = normalized || '.';
	const stat = await statWorkspacePath(uri, displayPath, 'directory');
	if ((stat.type & vscode.FileType.Directory) === 0) {
		if ((stat.type & vscode.FileType.File) !== 0) {
			throw new Error(`Workspace path "${displayPath}" is a file. Use read_workspace_file to read it.`);
		}
		throw new Error(`Workspace path "${displayPath}" is not a directory.`);
	}

	const rawEntries = await vscode.workspace.fs.readDirectory(uri);
	const candidates = rawEntries
		.filter(([name]) => !name.startsWith('.') && !excludedSourceDirectoryNames.has(name))
		.map(([name, type]) => ({
			name,
			path: normalized ? `${normalized}/${name}` : name,
			type,
		}));
	const ignored = await gitIgnoredReviewPaths(options.root, candidates.map((entry) => entry.path));
	const entries = candidates
		.filter((entry) => (
			!ignored.has(entry.path)
			&& !isGeneratedAgentsGuidancePath(entry.path)
			&& workspaceDirectoryAllowed(options, entry.path)
		))
		.flatMap((entry): WorkspaceDirectoryEntry[] => {
			if ((entry.type & vscode.FileType.Directory) !== 0) {
				return [{ name: entry.name, path: entry.path, type: 'directory' }];
			}
			if ((entry.type & vscode.FileType.File) !== 0) {
				return [{ name: entry.name, path: entry.path, type: 'file' }];
			}
			return [];
		})
		.sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
	return { path: displayPath, entries };
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

async function readWorkspaceFile(
	options: AgentToolOptions,
	candidate: string,
	offset: number,
	limit?: number,
	signal?: AbortSignal,
): Promise<WorkspaceFileRead> {
	const normalized = normalizeSafeRelativePath(candidate);
	if (normalized.split('/').some((segment) => segment.startsWith('.'))) {
		throw new Error('Source tools cannot read dot-path files.');
	}
	if (!workspacePathAllowed(options, normalized)) {
		throw new Error(`Workspace file "${normalized}" is outside the assigned module scope.`);
	}
	const reviewFile = reviewSnapshotFiles(options).find((file) => file.relativePath === normalized);
	if (reviewFile) {
		const text = reviewFile.currentExists ? reviewFile.newText : reviewFile.oldText;
		return {
			path: reviewFile.relativePath,
			...sliceWorkspaceFileText(text, offset, limit, options.maxReadChars ?? 50000),
			currentExists: reviewFile.currentExists,
			contentSource: reviewFile.currentExists ? 'reviewNewText' : 'reviewOldText',
		};
	}
	const uri = workspaceFileUri(options.root.uri, normalized);
	const stat = await statWorkspacePath(uri, normalized, 'file');
	if ((stat.type & vscode.FileType.Directory) !== 0) {
		throw new Error(`Workspace path "${normalized}" is a directory, not a file. Use list_workspace_directory to inspect it.`);
	}
	if ((stat.type & vscode.FileType.File) === 0) {
		throw new Error(`Workspace path "${normalized}" is not a regular file.`);
	}
	const text = await readUtf8TextFile(uri, signal);
	return {
		path: normalized,
		...sliceWorkspaceFileText(text, offset, limit, options.maxReadChars ?? 50000),
		currentExists: true,
		contentSource: 'workspace',
	};
}

function workspacePathAllowed(options: AgentToolOptions, candidate: string): boolean {
	const scopes = normalizedWorkspaceScopes(options.allowedWorkspacePaths);
	if (!scopes) {
		return true;
	}
	const normalized = normalizeReviewPath(candidate);
	return scopes.some((scope) => scope === '.' || normalized === scope || normalized.startsWith(`${scope}/`));
}

function workspaceDirectoryAllowed(options: AgentToolOptions, candidate: string): boolean {
	const scopes = normalizedWorkspaceScopes(options.allowedWorkspacePaths);
	if (!scopes) {
		return true;
	}
	const normalized = normalizeReviewPath(candidate) || '.';
	return scopes.some((scope) => (
		scope === '.'
		|| normalized === '.'
		|| normalized === scope
		|| normalized.startsWith(`${scope}/`)
		|| scope.startsWith(`${normalized}/`)
	));
}

function normalizedWorkspaceScopes(value: string[] | undefined): string[] | undefined {
	if (!value) {
		return undefined;
	}
	return [...new Set(value.map((scope) => normalizeReviewPath(scope) || '.'))];
}

async function readTextFile(options: AgentToolOptions, uri: vscode.Uri, signal?: AbortSignal): Promise<{ path: string; content: string; truncated: boolean }> {
	const text = await readUtf8TextFile(uri, signal);
	const maxChars = options.maxReadChars ?? 50000;
	return {
		path: normalizeReviewPath(relativePath(options.root.uri, uri)),
		content: text.slice(0, maxChars),
		truncated: text.length > maxChars,
	};
}

async function readUtf8TextFile(uri: vscode.Uri, signal?: AbortSignal): Promise<string> {
	throwIfAborted(signal);
	const data = await vscode.workspace.fs.readFile(uri);
	if (isProbablyBinary(data)) {
		throw new Error('File is binary.');
	}
	return decodeUtf8(data);
}

function sliceWorkspaceFileText(text: string, offset: number, limit: number | undefined, maxChars: number): Pick<WorkspaceFileRead, 'content' | 'truncated' | 'startLine' | 'endLine' | 'totalLines'> {
	const lines = splitLines(text);
	const startIndex = Math.min(offset - 1, lines.length);
	const requestedEndIndex = limit === undefined
		? lines.length
		: Math.min(lines.length, startIndex + limit);
	const selected = lines.slice(startIndex, requestedEndIndex).join('');
	const content = selected.slice(0, maxChars);
	const returnedLineCount = splitLines(content).length;
	return {
		content,
		truncated: startIndex > 0 || requestedEndIndex < lines.length || content.length < selected.length,
		startLine: offset,
		endLine: returnedLineCount > 0 ? offset + returnedLineCount - 1 : offset - 1,
		totalLines: lines.length,
	};
}

async function statWorkspacePath(uri: vscode.Uri, displayPath: string, expected: 'file' | 'directory'): Promise<vscode.FileStat> {
	try {
		return await vscode.workspace.fs.stat(uri);
	} catch {
		throw new Error(`Workspace ${expected} "${displayPath}" does not exist or cannot be accessed.`);
	}
}

async function searchWorkspace(options: AgentToolOptions, query: string, mode: SearchMode, limit: number, signal?: AbortSignal): Promise<{ matches: SearchMatch[] }> {
	return searchFiles(
		await listWorkspaceFiles(options, signal),
		async (candidate) => (await readWorkspaceFile(options, candidate, 1, undefined, signal)).content,
		query,
		mode,
		limit,
		signal,
	);
}

async function searchWikiFiles(options: AgentToolOptions, query: string, mode: SearchMode, limit: number, signal?: AbortSignal): Promise<{ matches: SearchMatch[] }> {
	return searchFiles(
		await listWikiFiles(options.root.uri, signal),
		async (candidate) => (await readTextFile(options, wikiFileUri(options.root.uri, candidate, true), signal)).content,
		query,
		mode,
		limit,
		signal,
	);
}

async function searchFiles(
	files: string[],
	readContent: (path: string) => Promise<string>,
	query: string,
	mode: SearchMode,
	limit: number,
	signal?: AbortSignal,
): Promise<{ matches: SearchMatch[] }> {
	if (!query) {
		throw new Error('Search query is required.');
	}
	const matchesLine = lineMatcher(query, mode);
	const matches: SearchMatch[] = [];
	const resultLimit = Math.max(1, Math.min(limit, 200));
	for (const candidate of files) {
		throwIfAborted(signal);
		try {
			const content = await readContent(candidate);
			for (const [index, line] of content.split(/\r?\n/).entries()) {
				throwIfAborted(signal);
				if (matchesLine(line)) {
					matches.push({ path: candidate, line: index + 1, text: line.slice(0, 500) });
					if (matches.length >= resultLimit) {
						return { matches };
					}
				}
			}
		} catch {
			throwIfAborted(signal);
			// Files can disappear or become unreadable while an agent is searching.
		}
	}
	return { matches };
}

function lineMatcher(query: string, mode: SearchMode): (line: string) => boolean {
	if (mode === 'literal') {
		return (line) => line.includes(query);
	}
	if (mode === 'fuzzy') {
		const normalizedQuery = [...query.toLowerCase()];
		return (line) => isFuzzyMatch(normalizedQuery, line.toLowerCase());
	}
	const expression = new RegExp(query);
	return (line) => expression.test(line);
}

function isFuzzyMatch(query: string[], candidate: string): boolean {
	let queryIndex = 0;
	for (const character of candidate) {
		if (character === query[queryIndex]) {
			queryIndex += 1;
			if (queryIndex === query.length) {
				return true;
			}
		}
	}
	return false;
}

function pendingChangeFiles(options: AgentToolOptions): Array<{ path: string; uri: string; currentExists: boolean; hunks: Array<Record<string, unknown>> }> {
	return reviewSnapshotFiles(options)
		.filter((file) => file.hunks.length > 0)
		.map((file) => ({
			path: file.relativePath,
			uri: file.uri.toString(),
			currentExists: file.currentExists,
			hunks: file.hunks.map(pendingHunkForTool),
		}));
}

function readPendingChange(options: AgentToolOptions, candidate: string): { path: string; uri: string; oldText: string; newText: string; currentExists: boolean; hunks: Array<Record<string, unknown>> } {
	const normalized = normalizeSafeRelativePath(candidate);
	const file = reviewSnapshotFiles(options).find((item) => item.relativePath === normalized);
	if (!file) {
		throw new Error(`Pending review file not found: ${candidate}`);
	}
	return {
		path: file.relativePath,
		uri: file.uri.toString(),
		oldText: file.oldText,
		newText: file.newText,
		currentExists: file.currentExists,
		hunks: file.hunks.map(pendingHunkForTool),
	};
}

function pendingHunkForTool(hunk: ReviewFileState['hunks'][number]): Record<string, unknown> {
	return {
		hunkId: hunk.id,
		kind: hunk.kind,
		oldStart: hunk.oldStart,
		newStart: hunk.newStart,
		oldLines: hunk.oldLines,
		newLines: hunk.newLines,
		oldText: hunk.oldText,
		newText: hunk.newText,
		contextBefore: hunk.newContextBefore,
		contextAfter: hunk.newContextAfter,
	};
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

function enumStringSchema(description: string, values: readonly string[]): Record<string, unknown> {
	return { type: 'string', enum: values, description };
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

function optionalPositiveIntegerArgument(args: Record<string, unknown>, name: string): number | undefined {
	const value = args[name];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
		throw new Error(`Tool argument ${name} must be a positive integer.`);
	}
	return value;
}

function optionalLineLimitArgument(args: Record<string, unknown>, name: string): number | undefined {
	const value = args[name];
	if (value === undefined || value === 0) {
		return undefined;
	}
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
		throw new Error(`Tool argument ${name} must be a non-negative integer.`);
	}
	return value;
}

function searchModeArgument(args: Record<string, unknown>): SearchMode {
	const value = args.mode;
	if (typeof value === 'string' && (searchModes as readonly string[]).includes(value)) {
		return value as SearchMode;
	}
	throw new Error('Tool argument mode must be literal, fuzzy, or regex.');
}

function workspaceFileUri(rootUri: vscode.Uri, candidate: string): vscode.Uri {
	const normalized = normalizeSafeRelativePath(candidate);
	if (normalized.split('/').some((segment) => segment.startsWith('.'))) {
		throw new Error('Source tools cannot read dot-path files.');
	}
	return containedUri(rootUri, normalized);
}

function normalizeSafeDirectoryPath(candidate: string): string {
	const trimmed = candidate.trim().replace(/\\/g, '/');
	if (trimmed === '.') {
		return '';
	}
	return normalizeSafeRelativePath(trimmed);
}

function wikiFileUri(rootUri: vscode.Uri, candidate: string, allowProtected: boolean): vscode.Uri {
	const normalized = normalizeWikiMarkdownPath(candidate, allowProtected);
	return containedUri(wikiReferencesUri(rootUri), normalized);
}

function wikiReferencesUri(rootUri: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(rootUri, ...wikiReferencesPath.split('/'));
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
