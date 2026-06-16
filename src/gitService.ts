import { execFile } from 'child_process';
import { realpathSync } from 'fs';
import { dirname as pathDirname, relative as pathRelative, resolve as pathResolve } from 'path';
import * as vscode from 'vscode';
import { gitIgnoredReviewPaths, isGitIgnoredReviewPath, normalizeReviewPath, shouldSkipReviewPath } from './reviewFileFilter';
import { FilePair, ReviewProject, uriKey } from './types';
import { decodeUtf8, isProbablyBinary, uriFromRelativePath } from './text';

export class GitService {
	public async discoverProjects(workspaceRoot: vscode.WorkspaceFolder): Promise<ReviewProject[]> {
		if (await this.isGitRoot(workspaceRoot.uri)) {
			return [reviewProject(workspaceRoot.uri, workspaceRoot.name)];
		}

		const entries = await vscode.workspace.fs.readDirectory(workspaceRoot.uri);
		const projects: ReviewProject[] = [];
		for (const [name, type] of entries) {
			if (type !== vscode.FileType.Directory) {
				continue;
			}
			const uri = vscode.Uri.joinPath(workspaceRoot.uri, name);
			if (await this.isGitRoot(uri)) {
				projects.push(reviewProject(uri, name));
			}
		}
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
		await this.git(root, ['rev-parse', '--show-toplevel']);
		const tracked = await this.gitLines(root, ['diff', '--name-only', '--relative', '--']);
		const untracked = await this.gitLines(root, ['ls-files', '--others', '--exclude-standard']);
		const untrackedPaths = new Set(untracked.map((relativePath) => normalizeReviewPath(relativePath)));
		const paths = [...new Set([...tracked, ...untracked])]
			.map((relativePath) => normalizeReviewPath(relativePath))
			.filter((relativePath) => relativePath.length > 0 && !shouldSkipReviewPath(relativePath));
		const ignoredPaths = await gitIgnoredReviewPaths(root, paths);
		const pairs: FilePair[] = [];

		for (const relativePath of paths) {
			if (ignoredPaths.has(relativePath)) {
				continue;
			}

			const uri = uriFromRelativePath(root.uri, relativePath);
			const baseline = !untrackedPaths.has(relativePath)
				? await this.readIndexText(root, relativePath)
				: { exists: false, text: '' };
			const current = await readCurrentText(uri);
			pairs.push({
				uri,
				relativePath,
				oldText: baseline.text,
				newText: current.text,
				baselineExists: baseline.exists,
				currentExists: current.exists,
			});
		}

		return pairs;
	}

	public async createFilePairForUri(uri: vscode.Uri, root?: vscode.WorkspaceFolder, options: { preferDisk?: boolean } = {}): Promise<FilePair | undefined> {
		const rootPath = root?.uri.fsPath ?? await this.findGitRoot(uri);
		if (!rootPath) {
			return undefined;
		}

		const relativePath = pathRelative(rootPath, uri.fsPath).replace(/\\/g, '/');
		if (shouldSkipReviewPath(relativePath) || await isGitIgnoredReviewPath(rootPath, relativePath)) {
			return undefined;
		}

		const baseline = await this.readIndexTextPath(rootPath, relativePath);
		const current = await readCurrentText(uri, { preferDisk: options.preferDisk });

		if (!baseline.exists && !current.exists) {
			return undefined;
		}

		return {
			uri,
			relativePath,
			oldText: baseline.text,
			newText: current.text,
			baselineExists: baseline.exists,
			currentExists: current.exists,
		};
	}

	public async indexStateSignature(root: vscode.WorkspaceFolder): Promise<string> {
		return this.indexStateSignaturePath(root.uri.fsPath);
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

	private async readIndexText(root: vscode.WorkspaceFolder, relativePath: string): Promise<{ exists: boolean; text: string }> {
		return this.readIndexTextPath(root.uri.fsPath, relativePath);
	}

	private async readIndexTextPath(rootPath: string, relativePath: string): Promise<{ exists: boolean; text: string }> {
		try {
			return { exists: true, text: await this.gitInPath(rootPath, ['show', `:${relativePath}`]) };
		} catch {
			return { exists: false, text: '' };
		}
	}

	private async gitLines(root: vscode.WorkspaceFolder, args: string[]): Promise<string[]> {
		const output = await this.git(root, args);
		return output.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean);
	}

	private git(root: vscode.WorkspaceFolder, args: string[]): Promise<string> {
		return this.gitInPath(root.uri.fsPath, args);
	}

	private gitInPath(cwd: string, args: string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
				if (error) {
					reject(new Error(stderr || error.message));
					return;
				}

				resolve(stdout);
			});
		});
	}
}

function reviewProject(rootUri: vscode.Uri, name: string): ReviewProject {
	return { id: uriKey(rootUri), name, rootUri };
}

function canonicalPath(candidate: string): string {
	try {
		return pathResolve(realpathSync.native(candidate));
	} catch {
		return pathResolve(candidate);
	}
}

async function readCurrentText(uri: vscode.Uri, options: { preferDisk?: boolean } = {}): Promise<{ exists: boolean; text: string }> {
	const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
	if (openDocument && (!options.preferDisk || openDocument.isDirty)) {
		return { exists: true, text: openDocument.getText() };
	}

	try {
		const data = await vscode.workspace.fs.readFile(uri);
		if (isProbablyBinary(data)) {
			return { exists: true, text: '' };
		}

		return { exists: true, text: decodeUtf8(data) };
	} catch {
		return { exists: false, text: '' };
	}
}
