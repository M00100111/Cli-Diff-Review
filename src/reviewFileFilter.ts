import { spawn } from 'child_process';
import * as vscode from 'vscode';

export function normalizeReviewPath(relativePath: string): string {
	return relativePath.replace(/\\/g, '/');
}

export function isDotReviewPath(relativePath: string): boolean {
	return normalizeReviewPath(relativePath)
		.split('/')
		.some((segment) => segment.length > 1 && segment.startsWith('.'));
}

export function isWikiReviewPath(relativePath: string): boolean {
	return normalizeReviewPath(relativePath).startsWith('.skills/llm-code-wiki/');
}

export function shouldSkipReviewPath(
	relativePath: string,
	reviewWikiChanges = vscode.workspace.getConfiguration('cliDiff').get<boolean>('reviewWikiChanges', true),
): boolean {
	const normalized = normalizeReviewPath(relativePath);
	if (normalized === '.skills/llm-code-wiki/.state.json') {
		return true;
	}
	if (normalized.startsWith('.skills/llm-code-wiki/')) {
		return !reviewWikiChanges || !normalized.endsWith('.md');
	}
	return isDotReviewPath(normalized);
}

export async function gitIgnoredReviewPaths(root: vscode.WorkspaceFolder, relativePaths: string[]): Promise<Set<string>> {
	return gitIgnoredReviewPathsInRoot(root.uri.fsPath, relativePaths);
}

export async function gitIgnoredReviewPathsInRoot(rootPath: string, relativePaths: string[]): Promise<Set<string>> {
	const candidates = [...new Set(relativePaths
		.map((relativePath) => normalizeReviewPath(relativePath))
		.filter((relativePath) => relativePath.length > 0 && !shouldSkipReviewPath(relativePath) && !isWikiReviewPath(relativePath)))];
	if (candidates.length === 0) {
		return new Set();
	}

	try {
		return await checkIgnored(rootPath, candidates);
	} catch {
		return new Set();
	}
}

export async function isGitIgnoredReviewPath(rootPath: string, relativePath: string): Promise<boolean> {
	const normalizedPath = normalizeReviewPath(relativePath);
	const ignored = await gitIgnoredReviewPathsInRoot(rootPath, [normalizedPath]);
	return ignored.has(normalizedPath);
}

function checkIgnored(rootPath: string, relativePaths: string[]): Promise<Set<string>> {
	return new Promise((resolve, reject) => {
		const child = spawn('git', ['-C', rootPath, 'check-ignore', '--no-index', '-z', '--stdin'], {
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];

		child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
		child.on('error', reject);
		child.on('close', (code) => {
			if (code !== 0 && code !== 1) {
				reject(new Error(Buffer.concat(stderr).toString('utf8')));
				return;
			}

			const output = Buffer.concat(stdout).toString('utf8');
			resolve(new Set(output.split('\0').map((line) => line.trim()).filter(Boolean)));
		});

		child.stdin.end(`${relativePaths.join('\0')}\0`);
	});
}
