import { spawn } from 'child_process';
import { realpathSync } from 'fs';
import { dirname as pathDirname, relative as pathRelative, resolve as pathResolve } from 'path';
import { StringDecoder } from 'string_decoder';
import * as vscode from 'vscode';
import { combineGitHunkPatches, parseGitPatch, ParsedGitFilePatch } from './gitPatch';
import { isGitIgnoredReviewPath, normalizeReviewPath, shouldSkipReviewPath } from './reviewFileFilter';
import { FilePair, GitReviewHunk, ReviewProject, uriKey } from './types';
import { decodeUtf8, isProbablyBinary, uriFromRelativePath } from './text';

export interface GitIndexEntry {
	exists: boolean;
	text: string;
	mode: string;
	oid?: string;
}

export interface GitApplyOptions {
	cached?: boolean;
	reverse?: boolean;
	check?: boolean;
}

const diffOptions = [
	'--full-index', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=3', '--relative', '--',
];

export class GitService {
	public async discoverProjects(workspaceRoot: vscode.WorkspaceFolder): Promise<ReviewProject[]> {
		const workspaceProject = await this.reviewProjectIfRoot(workspaceRoot.uri, workspaceRoot.name);
		if (workspaceProject) {
			return [workspaceProject];
		}
		const entries = await vscode.workspace.fs.readDirectory(workspaceRoot.uri);
		const directories = entries.filter(([, type]) => type === vscode.FileType.Directory);
		const projects = (await mapWithConcurrency(directories, 8, ([name]) => (
			this.reviewProjectIfRoot(vscode.Uri.joinPath(workspaceRoot.uri, name), name)
		)))
			.filter((project): project is ReviewProject => Boolean(project));
		return projects.sort((left, right) => left.name.localeCompare(right.name));
	}

	public async isGitRoot(uri: vscode.Uri): Promise<boolean> {
		try {
			const topLevel = (await this.gitInPath(uri.fsPath, ['rev-parse', '--show-toplevel'])).trim();
			return canonicalPath(topLevel) === canonicalPath(uri.fsPath);
		} catch {
			return false;
		}
	}

	public async createFilePairs(root: vscode.WorkspaceFolder): Promise<FilePair[]> {
		const projectId = uriKey(root.uri);
		const maxFileBytes = vscode.workspace.getConfiguration('cliDiff').get<number>('maxFileBytes', 2097152);
		const [pendingBlocks, statusOutput, headOid] = await Promise.all([
			this.gitPatchBlocks(root, ['diff', ...diffOptions], maxFileBytes, [0, 1]),
			this.gitBuffer(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no']),
			this.headOid(root),
		]);
		const pending = pendingBlocks.flatMap((block) => parseGitPatch(block, projectId, 'pending', maxFileBytes));
		const status = parsePorcelainStatus(statusOutput);
		const untrackedPaths = status.untrackedPaths.map(normalizeReviewPath).filter(Boolean);
		const untrackedPatches = await mapWithConcurrency(
			untrackedPaths.filter((relativePath) => !shouldSkipReviewPath(relativePath)),
			4,
			async (relativePath) => {
				const blocks = await this.gitPatchBlocks(root, [
					'diff', '--no-index', '--full-index', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=3', '--relative', '--', '/dev/null', relativePath,
				], maxFileBytes, [0, 1]);
				return blocks.flatMap((block) => parseGitPatch(block, projectId, 'pending', maxFileBytes));
			},
		);
		pending.push(...untrackedPatches.flat());

		return this.buildFilePairs(root, pending, new Set(status.conflictPaths.map(normalizeReviewPath)), headOid, maxFileBytes);
	}

	private async buildFilePairs(
		root: vscode.WorkspaceFolder,
		pending: ParsedGitFilePatch[],
		conflicts: Set<string>,
		headOid: string,
		maxFileBytes: number,
	): Promise<FilePair[]> {
		const byPath = new Map<string, { pending?: ParsedGitFilePatch }>();
		for (const file of pending) {
			byPath.set(file.relativePath, { ...byPath.get(file.relativePath), pending: file });
		}
		for (const conflict of conflicts) {
			if (conflict) {
				byPath.set(conflict, byPath.get(conflict) ?? {});
			}
		}

		const entries = [...byPath].filter(([relativePath]) => relativePath && !shouldSkipReviewPath(relativePath)).map(([relativePath, layers]) => {
			const uri = uriFromRelativePath(root.uri, relativePath);
			assignFileOccurrences(layers.pending?.hunks ?? []);
			return {
				relativePath,
				layers,
				uri,
				indexBlobOid: layers.pending?.oldOid,
				skippedReason: conflicts.has(relativePath)
					? 'Unsupported Git change: merge conflict. Resolve it in Source Control.'
					: layers.pending?.unsupportedReason,
			};
		});
		const workingStates = await Promise.all(entries.map((entry) => readCurrentText(entry.uri, {
			preferDisk: true,
			maxFileBytes: entry.skippedReason ? 0 : maxFileBytes,
		})));
		for (const [index, working] of workingStates.entries()) {
			if (working.tooLarge && !entries[index].skippedReason) {
				entries[index].skippedReason = 'File exceeds cliDiff.maxFileBytes.';
			}
		}
		const blobOids = entries.flatMap((entry) => entry.skippedReason
			? []
			: [entry.indexBlobOid].filter((oid): oid is string => Boolean(oid)));
		const blobs = await this.readBlobs(root, blobOids);

		const pairs: FilePair[] = [];
		for (const [entryIndex, entry] of entries.entries()) {
			const { relativePath, layers, uri, indexBlobOid, skippedReason } = entry;
			const working = workingStates[entryIndex];
			const index = blobText(blobs.get(indexBlobOid ?? ''));
			const pendingHunks = (layers.pending?.hunks ?? []).map((hunk) => ({ ...hunk, fileUri: uri.toString() }));
			pairs.push({
				uri,
				relativePath,
				oldText: index,
				newText: working.text,
				baselineExists: Boolean(indexBlobOid),
				currentExists: working.exists,
				skippedReason,
				gitSnapshot: {
					headText: index,
					indexText: index,
					workingText: working.text,
					headExists: Boolean(indexBlobOid),
					indexExists: Boolean(indexBlobOid),
					workingExists: working.exists,
					indexBlobOid,
				},
				pendingHunks,
				headOid,
			});
		}
		return pairs.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
	}

	private async readBlobs(root: vscode.WorkspaceFolder, objectIds: string[]): Promise<Map<string, Buffer>> {
		const unique = [...new Set(objectIds)];
		if (unique.length === 0) {
			return new Map();
		}
		const result = await this.runGit(root.uri.fsPath, ['cat-file', '--batch'], { input: `${unique.join('\n')}\n` });
		return parseCatFileBatch(result.stdout);
	}

	public async createFilePairForUri(uri: vscode.Uri, root?: vscode.WorkspaceFolder, options: { preferDisk?: boolean } = {}): Promise<FilePair | undefined> {
		const rootPath = root?.uri.fsPath ?? await this.findGitRoot(uri);
		if (!rootPath) {
			return undefined;
		}
		const folder: vscode.WorkspaceFolder = root ?? { uri: vscode.Uri.file(rootPath), name: rootPath.split('/').pop() ?? 'Git', index: 0 };
		const relativePath = normalizeReviewPath(pathRelative(rootPath, uri.fsPath));
		if (shouldSkipReviewPath(relativePath) || (!root && await isGitIgnoredReviewPath(rootPath, relativePath))) {
			return undefined;
		}
		void options;
		const projectId = uriKey(folder.uri);
		const maxFileBytes = vscode.workspace.getConfiguration('cliDiff').get<number>('maxFileBytes', 2097152);
		const pathDiffOptions = [...diffOptions.slice(0, -1), '--', relativePath];
		const [pendingBlocks, statusOutput, headOid] = await Promise.all([
			this.gitPatchBlocks(folder, ['diff', ...pathDiffOptions], maxFileBytes, [0, 1]),
			this.gitBuffer(folder, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no', '--', relativePath]),
			this.headOid(folder),
		]);
		const pending = pendingBlocks.flatMap((block) => parseGitPatch(block, projectId, 'pending', maxFileBytes));
		const status = parsePorcelainStatus(statusOutput);
		if (status.untrackedPaths.map(normalizeReviewPath).includes(relativePath)) {
			const blocks = await this.gitPatchBlocks(folder, [
				'diff', '--no-index', '--full-index', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=3', '--relative', '--', '/dev/null', relativePath,
			], maxFileBytes, [0, 1]);
			pending.push(...blocks.flatMap((block) => parseGitPatch(block, projectId, 'pending', maxFileBytes)));
		}
		const pairs = await this.buildFilePairs(
			folder,
			pending,
			new Set(status.conflictPaths.map(normalizeReviewPath)),
			headOid,
			maxFileBytes,
		);
		return pairs.find((pair) => pair.relativePath === relativePath);
	}

	public async applyPatch(root: vscode.WorkspaceFolder, patch: string, options: GitApplyOptions = {}): Promise<void> {
		const args = ['apply', '--whitespace=nowarn', '--recount'];
		if (options.cached) {
			args.push('--cached');
		}
		if (options.reverse) {
			args.push('--reverse');
		}
		if (options.check) {
			args.push('--check');
		}
		args.push('-');
		await this.git(root, args, { input: patch });
	}

	public combinePatches(hunks: GitReviewHunk[]): string {
		return combineGitHunkPatches(hunks);
	}

	public async headOid(root: vscode.WorkspaceFolder): Promise<string> {
		return this.headOidPath(root.uri.fsPath);
	}

	public async indexStateSignature(root: vscode.WorkspaceFolder): Promise<string> {
		return this.indexStateSignaturePath(root.uri.fsPath);
	}

	public async readIndexEntry(root: vscode.WorkspaceFolder, relativePath: string): Promise<GitIndexEntry> {
		return this.readIndexEntryPath(root.uri.fsPath, relativePath);
	}

	public async stageFile(root: vscode.WorkspaceFolder, relativePath: string): Promise<void> {
		await this.git(root, ['add', '--', relativePath]);
	}

	public async stageIndexText(root: vscode.WorkspaceFolder, relativePath: string, text: string, mode = '100644', add = false): Promise<void> {
		const blob = (await this.git(root, ['hash-object', '-w', '--stdin', `--path=${relativePath}`], { input: text })).trim();
		const args = ['update-index'];
		if (add) {
			args.push('--add');
		}
		args.push('--cacheinfo', mode, blob, relativePath);
		await this.git(root, args);
	}

	private async reviewProjectIfRoot(rootUri: vscode.Uri, name: string): Promise<ReviewProject | undefined> {
		try {
			const output = await this.gitInPath(rootUri.fsPath, ['rev-parse', '--show-toplevel', 'HEAD']);
			const [topLevel, headOid = ''] = output.trim().split(/\r?\n/);
			if (canonicalPath(topLevel) !== canonicalPath(rootUri.fsPath)) {
				return undefined;
			}
			return { id: uriKey(rootUri), name, rootUri, headOid };
		} catch {
			if (!await this.isGitRoot(rootUri)) {
				return undefined;
			}
			return { id: uriKey(rootUri), name, rootUri, headOid: '' };
		}
	}

	private async indexStateSignaturePath(rootPath: string): Promise<string> {
		const head = await this.headOidPath(rootPath);
		const index = await this.gitInPath(rootPath, ['ls-files', '-s']);
		return `${head}\0${index}`;
	}

	private async findGitRoot(uri: vscode.Uri): Promise<string | undefined> {
		try {
			return (await this.gitInPath(pathDirname(uri.fsPath), ['rev-parse', '--show-toplevel'])).trim();
		} catch {
			return undefined;
		}
	}

	private async headOidPath(rootPath: string): Promise<string> {
		try {
			return (await this.gitInPath(rootPath, ['rev-parse', '--verify', 'HEAD'])).trim();
		} catch {
			return '';
		}
	}

	private async readHeadText(root: vscode.WorkspaceFolder, relativePath: string): Promise<{ exists: boolean; text: string }> {
		try {
			return { exists: true, text: await this.git(root, ['show', `HEAD:${relativePath}`]) };
		} catch {
			return { exists: false, text: '' };
		}
	}

	private async readIndexText(root: vscode.WorkspaceFolder, relativePath: string): Promise<{ exists: boolean; text: string }> {
		const entry = await this.readIndexEntry(root, relativePath);
		return { exists: entry.exists, text: entry.text };
	}

	private async readIndexEntryPath(rootPath: string, relativePath: string): Promise<GitIndexEntry> {
		try {
			const listing = (await this.gitInPath(rootPath, ['ls-files', '-s', '--', relativePath]))
				.split(/\r?\n/g).find((line) => line.trim().length > 0);
			if (!listing) {
				return { exists: false, text: '', mode: '100644' };
			}
			const mode = listing.match(/^(\d{6})\s+/)?.[1] ?? '100644';
			const oid = listing.match(/^\d{6}\s+([0-9a-f]{40,64})\s+/i)?.[1];
			return { exists: true, text: await this.gitInPath(rootPath, ['show', `:${relativePath}`]), mode, oid };
		} catch {
			return { exists: false, text: '', mode: '100644' };
		}
	}

	private git(root: vscode.WorkspaceFolder, args: string[], options: GitRunOptions = {}): Promise<string> {
		return this.gitInPath(root.uri.fsPath, args, options);
	}

	private async gitBuffer(root: vscode.WorkspaceFolder, args: string[]): Promise<Buffer> {
		return this.runGit(root.uri.fsPath, args, {}).then((result) => result.stdout);
	}

	private gitPatchBlocks(root: vscode.WorkspaceFolder, args: string[], maxFileBytes: number, allowedExitCodes = [0]): Promise<string[]> {
		return new Promise((resolve, reject) => {
			const child = spawn('git', ['-C', root.uri.fsPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
			const blocks: string[] = [];
			let block = '';
			let blockBytes = 0;
			let remainder = '';
			const decoder = new StringDecoder('utf8');
			const stderr: Buffer[] = [];
			const limit = maxFileBytes + 1;
			const appendLine = (line: string) => {
				if (line.startsWith('diff --git ')) {
					if (block) {
						blocks.push(block);
					}
					block = '';
					blockBytes = 0;
				}
				if (!block && !line.startsWith('diff --git ')) {
					return;
				}
				if (blockBytes >= limit) {
					return;
				}
				const data = Buffer.from(line, 'utf8');
				const slice = data.subarray(0, Math.max(0, limit - blockBytes));
				block += slice.toString('utf8');
				blockBytes += slice.length;
			};
			child.stdout.on('data', (chunk: Buffer) => {
				remainder += decoder.write(chunk);
				let newline: number;
				while ((newline = remainder.indexOf('\n')) >= 0) {
					appendLine(remainder.slice(0, newline + 1));
					remainder = remainder.slice(newline + 1);
				}
			});
			child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
			child.on('error', reject);
			child.on('close', (code) => {
				remainder += decoder.end();
				appendLine(remainder);
				if (block) {
					blocks.push(block);
				}
				if (code === null || !allowedExitCodes.includes(code)) {
					reject(new Error(Buffer.concat(stderr).toString('utf8') || `Git exited with code ${code ?? 'unknown'}.`));
					return;
				}
				resolve(blocks);
			});
		});
	}

	private async gitInPath(cwd: string, args: string[], options: GitRunOptions = {}): Promise<string> {
		const result = await this.runGit(cwd, args, options);
		return result.stdout.toString('utf8');
	}

	private runGit(cwd: string, args: string[], options: GitRunOptions): Promise<{ stdout: Buffer; stderr: Buffer }> {
		return new Promise((resolve, reject) => {
			const child = spawn('git', ['-C', cwd, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
			child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
			child.on('error', reject);
			child.on('close', (code) => {
				const allowed = options.allowedExitCodes ?? [0];
				const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
				if (code === null || !allowed.includes(code)) {
					reject(new Error(result.stderr.toString('utf8') || `Git exited with code ${code ?? 'unknown'}.`));
					return;
				}
				resolve(result);
			});
			child.stdin.end(options.input);
		});
	}
}

interface GitRunOptions {
	input?: string;
	allowedExitCodes?: number[];
}

function canonicalPath(candidate: string): string {
	try {
		return pathResolve(realpathSync.native(candidate));
	} catch {
		return pathResolve(candidate);
	}
}

function splitNul(value: Buffer): string[] {
	return value.toString('utf8').split('\0').filter(Boolean);
}

function parsePorcelainStatus(value: Buffer): { untrackedPaths: string[]; conflictPaths: string[] } {
	const records = splitNul(value);
	const untrackedPaths: string[] = [];
	const conflictPaths: string[] = [];
	const unmerged = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		const status = record.slice(0, 2);
		const relativePath = record.slice(3);
		if (status === '??') {
			untrackedPaths.push(relativePath);
		} else if (unmerged.has(status)) {
			conflictPaths.push(relativePath);
		}
		if (status.includes('R') || status.includes('C')) {
			index += 1;
		}
	}
	return { untrackedPaths, conflictPaths };
}

export function parseCatFileBatch(output: Buffer): Map<string, Buffer> {
	const blobs = new Map<string, Buffer>();
	let offset = 0;
	while (offset < output.length) {
		const lineEnd = output.indexOf(0x0a, offset);
		if (lineEnd < 0) {
			break;
		}
		const header = output.subarray(offset, lineEnd).toString('ascii');
		offset = lineEnd + 1;
		const match = header.match(/^([0-9a-f]+) (\S+) (\d+)$/i);
		if (!match) {
			continue;
		}
		const size = Number(match[3]);
		const end = offset + size;
		if (!Number.isSafeInteger(size) || end > output.length) {
			break;
		}
		if (match[2] === 'blob') {
			blobs.set(match[1], output.subarray(offset, end));
		}
		offset = end + (output[end] === 0x0a ? 1 : 0);
	}
	return blobs;
}

function blobText(data: Buffer | undefined): string {
	return data && !isProbablyBinary(data) ? decodeUtf8(data) : '';
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, map: (value: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(values.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
		while (next < values.length) {
			const index = next++;
			results[index] = await map(values[index]);
		}
	});
	await Promise.all(workers);
	return results;
}

function assignFileOccurrences(hunks: GitReviewHunk[]): void {
	const occurrences = new Map<string, number>();
	for (const hunk of [...hunks].sort((left, right) => left.newStart - right.newStart || left.oldStart - right.oldStart)) {
		const occurrence = occurrences.get(hunk.fingerprint) ?? 0;
		occurrences.set(hunk.fingerprint, occurrence + 1);
		hunk.occurrence = occurrence;
		hunk.id = `${hunk.fingerprint}-${occurrence}`;
	}
}

async function readCurrentText(
	uri: vscode.Uri,
	options: { preferDisk?: boolean; maxFileBytes?: number } = {},
): Promise<{ exists: boolean; text: string; tooLarge?: boolean }> {
	const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
	if (openDocument && !options.preferDisk) {
		const text = openDocument.getText();
		return options.maxFileBytes !== undefined && Buffer.byteLength(text, 'utf8') > options.maxFileBytes
			? { exists: true, text: '', tooLarge: true }
			: { exists: true, text };
	}
	try {
		const stat = await vscode.workspace.fs.stat(uri);
		if (options.maxFileBytes !== undefined && stat.size > options.maxFileBytes) {
			return { exists: true, text: '', tooLarge: true };
		}
		const data = await vscode.workspace.fs.readFile(uri);
		if (isProbablyBinary(data)) {
			return { exists: true, text: '' };
		}
		return { exists: true, text: decodeUtf8(data) };
	} catch {
		return { exists: false, text: '' };
	}
}
