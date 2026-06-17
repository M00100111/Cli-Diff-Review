import * as path from 'path';
import * as vscode from 'vscode';
import { AgentRunner, type AgentTraceEvent } from '../agent/runtime';
import { createWikiAgentTools } from '../agent/tools';
import { LlmClient } from '../llm/client';
import { LlmRuntimeConfig } from '../llm/config';
import { isJsonObject } from '../llm/json';
import { decodeUtf8, encodeUtf8 } from '../text';
import { isAbortError, OperationCancelledError, throwIfAborted } from './cancellation';
import { SourceFingerprintDiff, WikiState, WikiStateService } from './state';

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
	onTrace?: (event: AgentTraceEvent) => void;
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
	'modules.md',
	'interfaces.md',
	'workflows.md',
	'decisions.md',
	'open-questions.md',
	'log.md',
];

export class WikiInitializationService {
	private readonly stateService: WikiStateService;
	private readonly runner = new AgentRunner();

	public constructor(extensionUri: vscode.Uri) {
		this.stateService = new WikiStateService(extensionUri);
	}

	public async initialize(options: WikiInitializationOptions): Promise<WikiInitializationResult> {
		throwIfAborted(options.signal);
		const existingState = await this.stateService.read(options.root.uri);
		if (existingState?.status === 'ready') {
			throw new Error('LLM Code Wiki is already initialized for this workspace.');
		}

		const state = await this.stateService.ensureScaffold(options.root, 'initializing', options.signal);
		const generatedFiles = new Set(state.generatedFiles);
		try {
			const result = await this.runWikiAgent(
				options,
				state,
				generatedFiles,
				initializationSystemPrompt(),
				initializationUserPrompt(),
			);
			await this.ensureRequiredFiles(options.root.uri);
			await this.appendRunLog(options.root.uri, 'initialize', result.summary, options.config);
			generatedFiles.add('log.md');
			await this.stateService.completeRun(options.root, state, result.summary, [...generatedFiles], options.signal);
			return { summary: result.summary, fileCount: generatedFiles.size, warnings: result.warnings };
		} catch (error) {
			state.generatedFiles = [...generatedFiles];
			await this.recordInterruptedState(options.root.uri, state, error);
			throw error;
		}
	}

	public async update(options: WikiInitializationOptions): Promise<WikiInitializationResult> {
		throwIfAborted(options.signal);
		const existing = await this.stateService.read(options.root.uri);
		if (!existing || existing.status !== 'ready') {
			throw new Error('Initialize LLM Code Wiki before updating it.');
		}
		const diff = await this.stateService.sourceDiff(options.root, existing, options.signal);
		if (!hasSourceChanges(diff)) {
			return { summary: 'Wiki is already synchronized.', fileCount: 0, warnings: [] };
		}
		const state: WikiState = { ...existing, status: 'updating' };
		await this.stateService.write(options.root.uri, state);
		const generatedFiles = new Set(state.generatedFiles);
		try {
			const result = await this.runWikiAgent(
				options,
				state,
				generatedFiles,
				updateSystemPrompt(),
				updateUserPrompt(diff),
			);
			await this.ensureRequiredFiles(options.root.uri);
			await this.appendRunLog(options.root.uri, 'update', result.summary, options.config);
			generatedFiles.add('log.md');
			await this.stateService.completeRun(options.root, state, result.summary, [...generatedFiles], options.signal, diff.current);
			return { summary: result.summary, fileCount: generatedFiles.size, warnings: result.warnings };
		} catch (error) {
			state.generatedFiles = [...generatedFiles];
			if (isAbortError(error)) {
				state.status = 'ready';
				state.lastRunSummary = 'Wiki update cancelled before synchronization.';
				await this.stateService.write(options.root.uri, state);
			} else {
				await this.recordInterruptedState(options.root.uri, state, error);
			}
			throw error;
		}
	}

	public async needsUpdate(root: vscode.WorkspaceFolder, signal?: AbortSignal): Promise<boolean> {
		const state = await this.stateService.read(root.uri);
		if (!state || state.status !== 'ready') {
			return false;
		}
		return hasSourceChanges(await this.stateService.sourceDiff(root, state, signal));
	}

	public async state(rootUri: vscode.Uri): Promise<WikiState | undefined> {
		return this.stateService.read(rootUri);
	}

	public async wikiExists(rootUri: vscode.Uri): Promise<boolean> {
		return this.stateService.wikiExists(rootUri);
	}

	public async deleteWiki(rootUri: vscode.Uri): Promise<void> {
		const target = this.stateService.wikiUri(rootUri);
		if (path.resolve(target.fsPath) !== path.resolve(rootUri.fsPath, '.skills', 'llm-code-wiki')) {
			throw new Error('Refusing to delete a path outside the workspace LLM Code Wiki skill directory.');
		}
		try {
			await vscode.workspace.fs.delete(target, { recursive: true, useTrash: false });
		} catch {
			// Reverting is complete if the skill directory is already absent.
		}
	}

	private async runWikiAgent(
		options: WikiInitializationOptions,
		state: WikiState,
		generatedFiles: Set<string>,
		systemPrompt: string,
		userPrompt: string,
	): Promise<{ summary: string; warnings: string[] }> {
		const repositorySpecification = decodeUtf8(await vscode.workspace.fs.readFile(this.stateService.schemaUri(options.root.uri)));
		const result = await this.runner.run({
			config: options.config,
			client: options.client,
			systemPrompt: `${systemPrompt}\n\nRepository Wiki skill schema:\n${repositorySpecification}`,
			userPrompt,
			tools: createWikiAgentTools({ root: options.root, generatedFiles }),
			signal: options.signal,
			onProgress: (progress) => options.onProgress?.({ message: progress.message }),
			onTrace: options.onTrace,
		});
		const summary = typeof result.result.summary === 'string' && result.result.summary.trim()
			? result.result.summary
			: `Wiki Agent completed in ${result.rounds} rounds.`;
		const warnings = Array.isArray(result.result.warnings)
			? result.result.warnings.filter((warning): warning is string => typeof warning === 'string')
			: [];
		state.generatedFiles = [...generatedFiles];
		return { summary, warnings };
	}

	private async ensureRequiredFiles(rootUri: vscode.Uri): Promise<void> {
		for (const required of requiredWikiFiles) {
			try {
				await vscode.workspace.fs.stat(vscode.Uri.joinPath(this.stateService.referencesUri(rootUri), required));
			} catch {
				throw new Error(`Wiki Agent did not create required file: ${required}`);
			}
		}
	}

	private async appendRunLog(rootUri: vscode.Uri, operation: 'initialize' | 'update', summary: string, config: LlmRuntimeConfig): Promise<void> {
		const logUri = vscode.Uri.joinPath(this.stateService.referencesUri(rootUri), 'log.md');
		let existing = '# Log\n';
		try {
			existing = decodeUtf8(await vscode.workspace.fs.readFile(logUri));
		} catch {
			// A missing log will be created below.
		}
		const entry = [
			`## [${new Date().toISOString()}] ${operation} | LLM Code Wiki`,
			'',
			`- Provider: ${config.provider}`,
			`- Model: ${config.model}`,
			`- Summary: ${summary}`,
		].join('\n');
		await vscode.workspace.fs.writeFile(logUri, encodeUtf8(`${existing.trimEnd()}\n\n${entry}\n`));
	}

	private async recordInterruptedState(rootUri: vscode.Uri, state: WikiState, error: unknown): Promise<void> {
		state.status = error instanceof OperationCancelledError || (error instanceof Error && error.name === 'AbortError') ? 'paused' : 'failed';
		state.lastRunSummary = error instanceof Error ? error.message : String(error);
		await this.stateService.write(rootUri, state);
	}

}

export function validateWikiInitializationResponse(value: unknown): WikiInitializationResponse {
	if (!isJsonObject(value)) {
		throw new Error('LLM wiki response must be a JSON object.');
	}
	if (value.version !== 1 || typeof value.summary !== 'string' || !Array.isArray(value.files) || value.files.length === 0) {
		throw new Error('Invalid LLM wiki response.');
	}
	const seen = new Set<string>();
	const files = value.files.map((item): WikiFile => {
		if (!isJsonObject(item) || typeof item.path !== 'string' || typeof item.content !== 'string') {
			throw new Error('Each LLM wiki file must include path and content strings.');
		}
		const safePath = normalizeWikiFilePath(item.path);
		if (seen.has(safePath)) {
			throw new Error(`Duplicate wiki file path: ${safePath}`);
		}
		seen.add(safePath);
		return { path: safePath, content: item.content };
	});
	for (const required of requiredWikiFiles) {
		if (!seen.has(required)) {
			throw new Error(`LLM wiki response is missing required file: ${required}`);
		}
	}
	return {
		version: 1,
		summary: value.summary,
		files,
		warnings: Array.isArray(value.warnings) ? value.warnings.filter((warning): warning is string => typeof warning === 'string') : [],
	};
}

export function normalizeWikiFilePath(candidate: string): string {
	const normalized = candidate.trim().replace(/\\/g, '/');
	if (!normalized || normalized.endsWith('/') || normalized.startsWith('/') || normalized.includes('//')) {
		throw new Error(`Invalid wiki file path: ${candidate}`);
	}
	if (normalized.length >= 3 && normalized[1] === ':' && normalized[2] === '/') {
		throw new Error(`Invalid wiki file path: ${candidate}`);
	}
	if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..') || !normalized.endsWith('.md')) {
		throw new Error(`Invalid wiki file path: ${candidate}`);
	}
	return normalized;
}

function hasSourceChanges(diff: SourceFingerprintDiff): boolean {
	return diff.added.length > 0 || diff.modified.length > 0 || diff.deleted.length > 0;
}

function initializationSystemPrompt(): string {
	return [
		'You are the Wiki Initialization Agent for an arbitrary software repository.',
		'Source code is read-only. You may create only generated Markdown through wiki write tools.',
		'First read references/schema.md with read_wiki_file using path "schema.md", then inspect the repository incrementally.',
		'Create every required initial page described by the specification.',
		'Generate index.md as a normal coding-agent navigation page for business wiki content; do not list schema.md in the main index catalog.',
		'Use source paths as evidence and record uncertainty in open-questions.md.',
	].join('\n');
}

function initializationUserPrompt(): string {
	return [
		'Initialize the repository-local code knowledge base now.',
		'Use tools to inspect the repository and write the Wiki.',
		'Finish with {"type":"final","result":{"summary":"...","warnings":[]}}.',
	].join('\n');
}

function updateSystemPrompt(): string {
	return [
		'You are the Wiki Update Agent for an arbitrary software repository.',
		'Source code is read-only. Update only generated Markdown through wiki write tools.',
		'Read references/schema.md with read_wiki_file using path "schema.md" and relevant existing Wiki pages before editing.',
		'Keep accurate existing content and revise only what source evidence supports.',
		'Preserve and integrate source-grounded Wiki updates already made by normal coding agents; do not overwrite them without evidence.',
		'Do not add schema.md to the normal index.md catalog of business wiki pages.',
	].join('\n');
}

function updateUserPrompt(diff: SourceFingerprintDiff): string {
	return [
		'Update the repository-local Wiki for these source changes:',
		JSON.stringify({ added: diff.added, modified: diff.modified, deleted: diff.deleted }),
		'Inspect affected source and related Wiki pages, then update the Wiki and finish with a final summary.',
	].join('\n');
}

export { OperationCancelledError };
