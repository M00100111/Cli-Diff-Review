import { execFile } from 'child_process';
import { dirname as pathDirname, relative as pathRelative } from 'path';
import * as vscode from 'vscode';
import { FilePair } from './types';
import { decodeUtf8, isProbablyBinary, uriFromRelativePath } from './text';

export class GitService {
	public async createFilePairs(root: vscode.WorkspaceFolder): Promise<FilePair[]> {
		await this.git(root, ['rev-parse', '--show-toplevel']);
		const hasHead = await this.hasHead(root);
		const tracked = hasHead
			? await this.gitLines(root, ['diff', '--name-only', '--relative', 'HEAD', '--'])
			: await this.gitLines(root, ['ls-files', '--cached']);
		const untracked = await this.gitLines(root, ['ls-files', '--others', '--exclude-standard']);
		const paths = [...new Set([...tracked, ...untracked])].filter(Boolean);
		const pairs: FilePair[] = [];

		for (const relativePath of paths) {
			const uri = uriFromRelativePath(root.uri, relativePath);
			const head = hasHead && !untracked.includes(relativePath)
				? await this.readHeadText(root, relativePath)
				: { exists: false, text: '' };
			const current = await readCurrentText(uri);
			pairs.push({
				uri,
				relativePath,
				oldText: head.text,
				newText: current.text,
				baselineExists: head.exists,
				currentExists: current.exists,
			});
		}

		return pairs;
	}

	public async createFilePairForUri(uri: vscode.Uri, root?: vscode.WorkspaceFolder): Promise<FilePair | undefined> {
		const rootPath = root?.uri.fsPath ?? await this.findGitRoot(uri);
		if (!rootPath) {
			return undefined;
		}

		const relativePath = pathRelative(rootPath, uri.fsPath).replace(/\\/g, '/');
		const hasHead = await this.hasHeadPath(rootPath);
		const head = hasHead ? await this.readHeadTextPath(rootPath, relativePath) : { exists: false, text: '' };
		const current = await readCurrentText(uri);

		if (!head.exists && !current.exists) {
			return undefined;
		}

		return {
			uri,
			relativePath,
			oldText: head.text,
			newText: current.text,
			baselineExists: head.exists,
			currentExists: current.exists,
		};
	}

	private async findGitRoot(uri: vscode.Uri): Promise<string | undefined> {
		try {
			return (await this.gitInPath(pathDirname(uri.fsPath), ['rev-parse', '--show-toplevel'])).trim();
		} catch {
			return undefined;
		}
	}

	private async hasHead(root: vscode.WorkspaceFolder): Promise<boolean> {
		return this.hasHeadPath(root.uri.fsPath);
	}

	private async hasHeadPath(rootPath: string): Promise<boolean> {
		try {
			await this.gitInPath(rootPath, ['rev-parse', '--verify', 'HEAD']);
			return true;
		} catch {
			return false;
		}
	}

	private async readHeadText(root: vscode.WorkspaceFolder, relativePath: string): Promise<{ exists: boolean; text: string }> {
		return this.readHeadTextPath(root.uri.fsPath, relativePath);
	}

	private async readHeadTextPath(rootPath: string, relativePath: string): Promise<{ exists: boolean; text: string }> {
		try {
			return { exists: true, text: await this.gitInPath(rootPath, ['show', `HEAD:${relativePath}`]) };
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

async function readCurrentText(uri: vscode.Uri): Promise<{ exists: boolean; text: string }> {
	const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
	if (openDocument) {
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
