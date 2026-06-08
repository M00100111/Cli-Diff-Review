import * as path from 'path';
import * as vscode from 'vscode';
import { LlmClient } from '../llm/client';
import { LlmRuntimeConfig } from '../llm/config';
import { isJsonObject, parseStrictJsonObject } from '../llm/json';
import { encodeUtf8, decodeUtf8 } from '../text';
import { OperationCancelledError, throwIfAborted } from './cancellation';
import { buildWorkspaceDigest } from './workspaceDigest';

export interface WikiInitializationProgress {
	message: string;
}

export interface WikiInitializationResult {
	summary: string;
	fileCount: number;
	warnings: string[];
}

export interface WikiInitializationOptions {
	root: vscode.WorkspaceFolder;
	config: LlmRuntimeConfig;
	client: LlmClient;
	signal?: AbortSignal;
	onProgress?: (progress: WikiInitializationProgress) => void;
}

export interface WikiFile {
	path: string;
	content: string;
}

export interface WikiInitializationResponse {
	version: 1;
	summary: string;
	files: WikiFile[];
	warnings: string[];
}

const requiredWikiFiles = [
	'index.md',
	'overview.md',
	'architecture.md',
	'extension-surface.md',
	'workflows.md',
	'modules.md',
	'decisions.md',
	'open-questions.md',
	'schema.md',
	'log.md',
];

export class WikiInitializationService {
	public constructor(private readonly extensionUri: vscode.Uri) {}

	public async initialize(options: WikiInitializationOptions): Promise<WikiInitializationResult> {
		throwIfAborted(options.signal);
		if (await this.wikiExists(options.root.uri)) {
			throw new Error('LLM Code Wiki is already initialized for this workspace.');
		}

		options.onProgress?.({ message: 'Reading wiki instructions' });
		const instructions = await this.readInstructions();
		throwIfAborted(options.signal);

		options.onProgress?.({ message: 'Scanning workspace' });
		const digest = await buildWorkspaceDigest(options.root, options.signal);
		throwIfAborted(options.signal);

		options.onProgress?.({ message: 'Requesting wiki files from LLM' });
		const raw = await options.client.completeJson({
			model: options.config.model,
			systemPrompt: wikiSystemPrompt(instructions),
			userPrompt: wikiUserPrompt(digest),
			temperature: 0,
			maxTokens: 12000,
		}, options.signal);
		throwIfAborted(options.signal);

		options.onProgress?.({ message: 'Parsing LLM JSON response' });
		const parsed = validateWikiInitializationResponse(parseStrictJsonObject(raw));
		throwIfAborted(options.signal);

		if (await this.wikiExists(options.root.uri)) {
			throw new Error('LLM Code Wiki was initialized while the request was running.');
		}

		options.onProgress?.({ message: 'Writing .wiki files' });
		await this.writeWiki(options.root.uri, parsed, options.config, options.signal);
		return {
			summary: parsed.summary,
			fileCount: parsed.files.length,
			warnings: parsed.warnings,
		};
	}

	public async wikiExists(rootUri: vscode.Uri): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(this.wikiUri(rootUri));
			return true;
		} catch {
			return false;
		}
	}

	public async deleteWiki(rootUri: vscode.Uri): Promise<void> {
		const target = this.wikiUri(rootUri);
		if (!isExactWikiPath(rootUri, target)) {
			throw new Error('Refusing to delete a path outside the workspace .wiki directory.');
		}
		try {
			await vscode.workspace.fs.delete(target, { recursive: true, useTrash: false });
		} catch {
			// Reverting a cancelled initialization is complete if .wiki is already gone.
		}
	}

	private async readInstructions(): Promise<string> {
		const uri = vscode.Uri.joinPath(this.extensionUri, 'llm-code-wiki', 'llm-code-wiki.md');
		try {
			return decodeUtf8(await vscode.workspace.fs.readFile(uri));
		} catch {
			return 'Create a local LLM Code Wiki under .wiki. Return only strict JSON with markdown files.';
		}
	}

	private async writeWiki(
		rootUri: vscode.Uri,
		response: WikiInitializationResponse,
		config: LlmRuntimeConfig,
		signal?: AbortSignal,
	): Promise<void> {
		const wikiUri = this.wikiUri(rootUri);
		if (!isExactWikiPath(rootUri, wikiUri)) {
			throw new Error('Invalid wiki path.');
		}
		throwIfAborted(signal);
		await vscode.workspace.fs.createDirectory(wikiUri);
		for (const file of response.files) {
			throwIfAborted(signal);
			const target = vscode.Uri.joinPath(wikiUri, ...file.path.split('/'));
			if (!isInsideWikiPath(wikiUri, target)) {
				throw new Error(`Invalid wiki file path: ${file.path}`);
			}
			await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target.fsPath)));
			throwIfAborted(signal);
			await vscode.workspace.fs.writeFile(target, encodeUtf8(file.content));
		}
		throwIfAborted(signal);
		await this.appendInitializationLog(wikiUri, response, config);
	}

	private async appendInitializationLog(wikiUri: vscode.Uri, response: WikiInitializationResponse, config: LlmRuntimeConfig): Promise<void> {
		const logUri = vscode.Uri.joinPath(wikiUri, 'log.md');
		let existing = '';
		try {
			existing = decodeUtf8(await vscode.workspace.fs.readFile(logUri));
		} catch {
			existing = '# Log\n';
		}
		const entry = [
			'',
			`## [${new Date().toISOString()}] initialize | LLM Code Wiki`,
			'',
			`- Provider: ${config.provider}`,
			`- Model: ${config.model}`,
			`- Files: ${response.files.length}`,
			`- Summary: ${response.summary}`,
		].join('\n');
		await vscode.workspace.fs.writeFile(logUri, encodeUtf8(`${existing.trimEnd()}\n${entry}\n`));
	}

	private wikiUri(rootUri: vscode.Uri): vscode.Uri {
		return vscode.Uri.joinPath(rootUri, '.wiki');
	}
}

export function validateWikiInitializationResponse(value: unknown): WikiInitializationResponse {
	if (!isJsonObject(value)) {
		throw new Error('LLM wiki response must be a JSON object.');
	}
	if (value.version !== 1) {
		throw new Error('LLM wiki response version must be 1.');
	}
	if (typeof value.summary !== 'string' || !value.summary.trim()) {
		throw new Error('LLM wiki response summary is required.');
	}
	if (!Array.isArray(value.files) || value.files.length === 0) {
		throw new Error('LLM wiki response files must be a non-empty array.');
	}
	const seen = new Set<string>();
	const files: WikiFile[] = [];
	for (const item of value.files) {
		if (!isJsonObject(item) || typeof item.path !== 'string' || typeof item.content !== 'string') {
			throw new Error('Each LLM wiki file must include path and content strings.');
		}
		const safePath = normalizeWikiFilePath(item.path);
		if (seen.has(safePath)) {
			throw new Error(`Duplicate wiki file path: ${safePath}`);
		}
		seen.add(safePath);
		files.push({ path: safePath, content: item.content });
	}
	for (const required of requiredWikiFiles) {
		if (!seen.has(required)) {
			throw new Error(`LLM wiki response is missing required file: ${required}`);
		}
	}
	const warnings = Array.isArray(value.warnings)
		? value.warnings.filter((warning): warning is string => typeof warning === 'string')
		: [];
	return {
		version: 1,
		summary: value.summary,
		files,
		warnings,
	};
}

export function normalizeWikiFilePath(candidate: string): string {
	const normalized = candidate.trim().replace(/\\/g, '/');
	if (!normalized || normalized.endsWith('/') || normalized.startsWith('/') || normalized.includes('//')) {
		throw new Error(`Invalid wiki file path: ${candidate}`);
	}
	if (isWindowsAbsolutePath(normalized)) {
		throw new Error(`Invalid wiki file path: ${candidate}`);
	}
	const segments = normalized.split('/');
	if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
		throw new Error(`Invalid wiki file path: ${candidate}`);
	}
	if (!normalized.endsWith('.md')) {
		throw new Error(`Wiki file must be markdown: ${candidate}`);
	}
	return normalized;
}

function isWindowsAbsolutePath(candidate: string): boolean {
	if (candidate.length < 3 || candidate[1] !== ':') {
		return false;
	}
	const drive = candidate[0].toLowerCase();
	return drive >= 'a' && drive <= 'z' && (candidate[2] === '/' || candidate[2] === '\\');
}

function isExactWikiPath(rootUri: vscode.Uri, wikiUri: vscode.Uri): boolean {
	return path.resolve(wikiUri.fsPath) === path.resolve(rootUri.fsPath, '.wiki');
}

function isInsideWikiPath(wikiUri: vscode.Uri, targetUri: vscode.Uri): boolean {
	const wikiPath = path.resolve(wikiUri.fsPath);
	const targetPath = path.resolve(targetUri.fsPath);
	return targetPath === wikiPath || targetPath.startsWith(`${wikiPath}${path.sep}`);
}

function wikiSystemPrompt(instructions: string): string {
	return [
		'You initialize a local code wiki for a software repository.',
		'You must return only one strict JSON object.',
		'Do not wrap the JSON in markdown fences.',
		'Do not include prose before or after the JSON.',
		'Do not include comments in JSON.',
		'Use this LLM Code Wiki specification:',
		'',
		instructions,
	].join('\n');
}

function wikiUserPrompt(digest: string): string {
	return [
		'Initialize the repository .wiki from this workspace digest.',
		'Return JSON with version, summary, files, and optional warnings.',
		'Every file path must be relative to .wiki.',
		'All required files from the specification must be present.',
		'',
		digest,
	].join('\n');
}

export { OperationCancelledError };
