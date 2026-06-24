import * as path from 'path';
import * as vscode from 'vscode';
import { gitIgnoredReviewPaths, normalizeReviewPath, shouldSkipReviewPath } from '../reviewFileFilter';
import { decodeUtf8, isProbablyBinary, relativePath } from '../text';
import { throwIfAborted } from './cancellation';
import { isGeneratedAgentsGuidancePath } from './paths';

interface DigestFile {
	uri: vscode.Uri;
	relativePath: string;
	size: number;
	text?: string;
	skippedReason?: string;
}

const digestMaxFiles = 500;
const digestMaxFileBytes = 160000;
const digestMaxFileContentChars = 12000;
const digestMaxTotalContentChars = 260000;
const digestInventoryLimit = 500;

export async function buildWorkspaceDigest(root: vscode.WorkspaceFolder, signal?: AbortSignal): Promise<string> {
	throwIfAborted(signal);
	const uris = await vscode.workspace.findFiles(
		new vscode.RelativePattern(root, '**/*'),
		'**/{.git,.agents,.skills,node_modules,dist,out,.vscode-test}/**',
		digestMaxFiles,
	);
	throwIfAborted(signal);

	const relativePaths = new Map(uris.map((uri) => [uri.toString(), relativePath(root.uri, uri)]));
	const ignoredPaths = await gitIgnoredReviewPaths(root, [...relativePaths.values()]);
	const files: DigestFile[] = [];

	for (const uri of uris) {
		throwIfAborted(signal);
		const currentRelativePath = normalizeReviewPath(relativePaths.get(uri.toString()) ?? relativePath(root.uri, uri));
		if (shouldSkipDigestPath(currentRelativePath) || ignoredPaths.has(currentRelativePath)) {
			continue;
		}
		try {
			const data = await vscode.workspace.fs.readFile(uri);
			if (data.length > digestMaxFileBytes) {
				files.push({ uri, relativePath: currentRelativePath, size: data.length, skippedReason: 'too large' });
				continue;
			}
			if (isProbablyBinary(data)) {
				files.push({ uri, relativePath: currentRelativePath, size: data.length, skippedReason: 'binary' });
				continue;
			}
			files.push({
				uri,
				relativePath: currentRelativePath,
				size: data.length,
				text: decodeUtf8(data),
			});
		} catch {
			files.push({ uri, relativePath: currentRelativePath, size: 0, skippedReason: 'unreadable' });
		}
	}

	files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
	const selected = selectDigestFiles(files);
	return renderDigest(root, files, selected);
}

function shouldSkipDigestPath(relativePath: string): boolean {
	if (!relativePath || isGeneratedAgentsGuidancePath(relativePath) || shouldSkipReviewPath(relativePath)) {
		return true;
	}
	const segments = relativePath.split('/');
	return segments.some((segment) => [
		'node_modules',
		'dist',
		'out',
		'.git',
		'.agents',
		'.skills',
		'.vscode-test',
	].includes(segment));
}

function selectDigestFiles(files: DigestFile[]): DigestFile[] {
	let remaining = digestMaxTotalContentChars;
	const selected: DigestFile[] = [];
	for (const file of [...files].sort(digestPrioritySort)) {
		if (!file.text || remaining <= 0) {
			continue;
		}
		const content = file.text.slice(0, Math.min(digestMaxFileContentChars, remaining));
		selected.push({ ...file, text: content });
		remaining -= content.length;
	}
	return selected.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function digestPrioritySort(left: DigestFile, right: DigestFile): number {
	return digestPriority(left.relativePath) - digestPriority(right.relativePath)
		|| left.relativePath.localeCompare(right.relativePath);
}

function digestPriority(relativePath: string): number {
	const basename = path.posix.basename(relativePath);
	if (['package.json', 'tsconfig.json', 'README.md', 'CHANGELOG.md'].includes(basename)) {
		return 0;
	}
	if (relativePath.startsWith('src/') && relativePath.endsWith('.ts')) {
		return 1;
	}
	if (relativePath.includes('/test/') || relativePath.includes('/tests/')) {
		return 2;
	}
	if (['.ts', '.tsx', '.js', '.jsx', '.json', '.md'].some((extension) => relativePath.endsWith(extension))) {
		return 3;
	}
	return 4;
}

function renderDigest(root: vscode.WorkspaceFolder, files: DigestFile[], selected: DigestFile[]): string {
	const inventory = files.slice(0, digestInventoryLimit).map((file) => {
		const suffix = file.skippedReason ? ` (${file.skippedReason}, ${file.size} bytes)` : ` (${file.size} bytes)`;
		return `- ${file.relativePath}${suffix}`;
	}).join('\n');
	const contents = selected.map((file) => [
		`### ${file.relativePath}`,
		'```text',
		file.text ?? '',
		'```',
	].join('\n')).join('\n\n');
	return [
		'# Workspace Digest',
		'',
		`Root name: ${root.name}`,
		`Root path: ${root.uri.fsPath}`,
		`File count included in inventory: ${files.length}`,
		'',
		'## File inventory',
		'',
		inventory || '- No files found.',
		'',
		'## Selected file contents',
		'',
		contents || 'No readable text files selected.',
	].join('\n');
}
