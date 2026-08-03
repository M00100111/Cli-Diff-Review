import { createHash } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentRunCheckpoint, AgentRunner, type AgentTraceEvent } from '../agent/runtime';
import { createReadOnlyAgentTools, createWikiAgentTools } from '../agent/tools';
import { LlmClient } from '../llm/client';
import { LlmRuntimeConfig } from '../llm/config';
import { isJsonObject } from '../llm/json';
import { decodeUtf8, encodeUtf8 } from '../text';
import { agentsGuidanceStartMarker, removeManagedAgentsGuidance } from './agentsGuidance';
import { isAbortError, OperationCancelledError, throwIfAborted } from './cancellation';
import { agentsGuidanceFileName, wikiDirectoryPath } from './paths';
import { SourceFingerprintDiff, WikiState, WikiStateService } from './state';
import type { WikiFreshnessAssessment } from './state';
import {
	WikiAgentContinuation,
	WikiModuleAnalysis,
	WikiModulePlan,
	WikiPipelineCheckpoint,
	WikiPipelineOperation,
	WikiPipelineStage,
	WikiPipelineStore,
} from './wikiPipelineStore';

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
	onTrace?: (event: AgentTraceEvent, context: WikiAgentTraceContext) => void;
	onCheckpoint?: () => void;
	concurrency?: number;
}

export interface WikiAgentTraceContext {
	stage: WikiPipelineStage;
	moduleId?: string;
	moduleName?: string;
	moduleIndex?: number;
	moduleCount?: number;
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
	private readonly pipelineStore: WikiPipelineStore;

	public constructor(extensionUri: vscode.Uri, storageUri?: vscode.Uri) {
		this.stateService = new WikiStateService(extensionUri);
		this.pipelineStore = new WikiPipelineStore(storageUri);
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
			const sourceFingerprints = await this.stateService.computeSourceFingerprints(options.root, options.signal);
			const result = await this.runWikiPipeline(options, 'initialize', state, generatedFiles, sourceFingerprints);
			await this.ensureRequiredFiles(options.root.uri);
			await this.appendRunLog(options.root.uri, 'initialize', result.summary, options.config);
			generatedFiles.add('log.md');
			await this.stateService.completeRun(options.root, state, result.summary, [...generatedFiles], options.signal, sourceFingerprints);
			await this.pipelineStore.clear(options.root.uri);
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
		const resumable = await this.hasPipelineCheckpoint(options.root.uri, 'update');
		if (!existing || (existing.status !== 'ready' && !resumable)) {
			throw new Error('Initialize LLM Code Wiki before updating it.');
		}
		const diff = await this.stateService.sourceDiff(options.root, existing, options.signal);
		const agentsGuidanceMissing = !await this.hasAgentsGuidance(options.root.uri);
		if (!hasSourceChanges(diff) && !agentsGuidanceMissing && !resumable) {
			return { summary: 'Wiki is already synchronized.', fileCount: 0, warnings: [] };
		}
		const state: WikiState = { ...existing, status: 'updating' };
		await this.stateService.write(options.root.uri, state);
		const generatedFiles = new Set(state.generatedFiles);
		try {
			const result = await this.runWikiPipeline(options, 'update', state, generatedFiles, diff.current, diff);
			await this.ensureRequiredFiles(options.root.uri);
			await this.appendRunLog(options.root.uri, 'update', result.summary, options.config);
			generatedFiles.add('log.md');
			await this.stateService.completeRun(options.root, state, result.summary, [...generatedFiles], options.signal, diff.current);
			await this.pipelineStore.clear(options.root.uri);
			return { summary: result.summary, fileCount: generatedFiles.size, warnings: result.warnings };
		} catch (error) {
			state.generatedFiles = [...generatedFiles];
			state.status = 'ready';
			state.lastRunSummary = isAbortError(error)
				? 'Wiki update cancelled before synchronization.'
				: error instanceof Error ? error.message : String(error);
			await this.stateService.write(options.root.uri, state);
			throw error;
		}
	}

	public async needsUpdate(root: vscode.WorkspaceFolder, signal?: AbortSignal): Promise<boolean> {
		const state = await this.stateService.read(root.uri);
		if (!state || state.status !== 'ready') {
			return false;
		}
		return hasSourceChanges(await this.stateService.sourceDiff(root, state, signal))
			|| !await this.hasAgentsGuidance(root.uri);
	}

	public async assessFreshness(root: vscode.WorkspaceFolder, signal?: AbortSignal): Promise<WikiFreshnessAssessment> {
		return this.stateService.assessFreshness(root, signal);
	}
	public async state(rootUri: vscode.Uri): Promise<WikiState | undefined> {
		return this.stateService.read(rootUri);
	}

	public async recoverInterruptedUpdate(rootUri: vscode.Uri): Promise<void> {
		const state = await this.stateService.read(rootUri);
		if (!state || state.status !== 'updating') {
			return;
		}
		await this.stateService.write(rootUri, {
			...state,
			status: 'ready',
			lastRunSummary: 'Wiki update was interrupted before synchronization completed.',
		});
	}

	public async recoverInterruptedInitialization(rootUri: vscode.Uri): Promise<void> {
		const state = await this.stateService.read(rootUri);
		if (!state || state.status !== 'initializing') {
			return;
		}
		await this.stateService.write(rootUri, {
			...state,
			status: 'paused',
			lastRunSummary: 'Wiki initialization was interrupted before completion.',
		});
	}

	public async wikiExists(rootUri: vscode.Uri): Promise<boolean> {
		return this.stateService.wikiExists(rootUri);
	}

	public async deleteWiki(rootUri: vscode.Uri): Promise<void> {
		const target = this.stateService.wikiUri(rootUri);
		if (path.resolve(target.fsPath) !== path.resolve(rootUri.fsPath, wikiDirectoryPath)) {
			throw new Error('Refusing to delete a path outside the workspace LLM Code Wiki skill directory.');
		}
		try {
			await vscode.workspace.fs.delete(target, { recursive: true, useTrash: false });
		} catch {
			// Reverting is complete if the skill directory is already absent.
		}
		await removeManagedAgentsGuidance(rootUri);
		await this.pipelineStore.clear(rootUri);
	}

	public async hasPipelineCheckpoint(rootUri: vscode.Uri, operation?: WikiPipelineOperation): Promise<boolean> {
		const checkpoint = await this.pipelineStore.load(rootUri);
		return Boolean(checkpoint && (!operation || checkpoint.operation === operation));
	}

	public clearPipelineCheckpoint(rootUri: vscode.Uri): Promise<void> {
		return this.pipelineStore.clear(rootUri);
	}

	private async runWikiPipeline(
		options: WikiInitializationOptions,
		operation: WikiPipelineOperation,
		state: WikiState,
		generatedFiles: Set<string>,
		sourceFingerprints: Record<string, string>,
		diff?: SourceFingerprintDiff,
	): Promise<{ summary: string; warnings: string[] }> {
		const sourceSignature = recordSignature(sourceFingerprints);
		const inventory = repositoryInventory(sourceFingerprints, diff);
		const repositorySpecification = decodeUtf8(await vscode.workspace.fs.readFile(this.stateService.schemaUri(options.root.uri)));
		const currentWikiSignature = await this.wikiSignature(options.root.uri);
		let checkpoint = await this.pipelineStore.load(options.root.uri);
		const runFingerprint = wikiPipelineFingerprint(
			operation,
			options,
			inventory,
			diff,
			repositorySpecification,
			checkpoint?.plan,
			checkpoint?.completedModules ?? [],
		);
		if (checkpoint && !pipelineCompatible(checkpoint, operation, sourceSignature, currentWikiSignature, runFingerprint)) {
			await this.pipelineStore.clear(options.root.uri);
			throw new Error('The saved Wiki Agent continuation is incompatible with the current source, Wiki, model, or tools. Start the Wiki operation again.');
		}
		checkpoint ??= {
			version: 1,
			rootUri: options.root.uri.toString(),
			operation,
			stage: 'plan',
			sourceSignature,
			wikiSignature: currentWikiSignature,
			runFingerprint,
			completedModules: [],
			continuations: [],
			generatedFiles: [...generatedFiles],
			updatedAt: new Date().toISOString(),
		};
		for (const generatedFile of checkpoint.generatedFiles) {
			generatedFiles.add(generatedFile);
		}
		await this.savePipelineCheckpoint(options, checkpoint);

		if (!checkpoint.plan) {
			checkpoint.stage = 'plan';
			options.onProgress?.({ message: 'Planning Wiki modules' });
			const context: WikiAgentTraceContext = { stage: 'plan' };
			const tools = createReadOnlyAgentTools({ root: options.root, includeWikiTools: true });
			const result = await this.runPipelineAgent(
				options,
				checkpoint,
				context,
				plannerSystemPrompt(operation),
				plannerUserPrompt(operation, inventory, diff),
				tools,
			);
			checkpoint.plan = validateWikiModulePlan(result.result, diff);
			checkpoint.stage = 'module';
			removeContinuation(checkpoint, 'plan');
			checkpoint.runFingerprint = wikiPipelineFingerprint(
				operation,
				options,
				inventory,
				diff,
				repositorySpecification,
				checkpoint.plan,
				checkpoint.completedModules,
			);
			await this.savePipelineCheckpoint(options, checkpoint);
		}

		await this.runModuleAnalysts(options, checkpoint, operation, inventory, repositorySpecification, diff);
		checkpoint.stage = 'integration';
		checkpoint.runFingerprint = wikiPipelineFingerprint(
			operation,
			options,
			inventory,
			diff,
			repositorySpecification,
			checkpoint.plan,
			checkpoint.completedModules,
		);
		await this.savePipelineCheckpoint(options, checkpoint);

		let agentsGuidanceWritten = await this.hasAgentsGuidance(options.root.uri);
		const integrationContext: WikiAgentTraceContext = { stage: 'integration' };
		options.onProgress?.({ message: 'Integrating Wiki knowledge' });
		const integrationTools = createWikiAgentTools({
			root: options.root,
			generatedFiles,
			allowedWorkspacePaths: checkpoint.plan.flatMap((module) => [...module.sourceScopes, ...module.sharedPaths]),
			onAgentsGuidanceWritten: () => {
				agentsGuidanceWritten = true;
			},
			onWikiMutation: async () => {
				checkpoint.generatedFiles = [...generatedFiles];
				checkpoint.wikiSignature = await this.wikiSignature(options.root.uri);
				await this.savePipelineCheckpoint(options, checkpoint);
			},
		}).filter((tool) => tool.name !== 'append_wiki_log');
		const integration = await this.runPipelineAgent(
			options,
			checkpoint,
			integrationContext,
			integrationSystemPrompt(operation, repositorySpecification),
			integrationUserPrompt(operation, checkpoint.plan, checkpoint.completedModules, diff),
			integrationTools,
		);
		if (!agentsGuidanceWritten) {
			throw new Error(`Wiki Integration Agent did not create or refresh ${agentsGuidanceFileName} guidance.`);
		}
		await this.ensureAgentsGuidance(options.root.uri);
		const summary = typeof integration.result.summary === 'string' && integration.result.summary.trim()
			? integration.result.summary
			: `Wiki Integration Agent completed in ${integration.rounds} rounds.`;
		const warnings = Array.isArray(integration.result.warnings)
			? integration.result.warnings.filter((warning): warning is string => typeof warning === 'string')
			: [];
		state.generatedFiles = [...generatedFiles];
		return { summary, warnings };
	}

	private async runModuleAnalysts(
		options: WikiInitializationOptions,
		checkpoint: WikiPipelineCheckpoint,
		operation: WikiPipelineOperation,
		inventory: RepositoryInventory,
		repositorySpecification: string,
		diff?: SourceFingerprintDiff,
	): Promise<void> {
		const plan = checkpoint.plan ?? [];
		const completed = new Map(checkpoint.completedModules.map((analysis) => [analysis.moduleId, analysis]));
		const pending = plan.map((module, index) => ({ module, index })).filter(({ module }) => !completed.has(module.id));
		const concurrency = normalizeConcurrency(options.concurrency, pending.length);
		if (pending.length === 0) {
			return;
		}
		let nextIndex = 0;
		let firstFailure: unknown;
		const runWorker = async (): Promise<void> => {
			while (!firstFailure) {
				const entry = pending[nextIndex];
				nextIndex += 1;
				if (!entry) {
					return;
				}
				const context: WikiAgentTraceContext = {
					stage: 'module',
					moduleId: entry.module.id,
					moduleName: entry.module.name,
					moduleIndex: entry.index + 1,
					moduleCount: plan.length,
				};
				options.onProgress?.({ message: `Analyzing Wiki module ${entry.module.name} (${entry.index + 1}/${plan.length})` });
				try {
					const result = await this.runPipelineAgent(
						options,
						checkpoint,
						context,
						moduleAnalystSystemPrompt(),
						moduleAnalystUserPrompt(operation, entry.module, inventory, diff),
						createReadOnlyAgentTools({
							root: options.root,
							includeWikiTools: true,
							allowedWorkspacePaths: [...entry.module.sourceScopes, ...entry.module.sharedPaths],
						}),
					);
					completed.set(entry.module.id, validateWikiModuleAnalysis(result.result, entry.module));
					checkpoint.completedModules = plan.flatMap((module) => {
						const analysis = completed.get(module.id);
						return analysis ? [analysis] : [];
					});
					removeContinuation(checkpoint, 'module', entry.module.id);
					checkpoint.runFingerprint = wikiPipelineFingerprint(
						operation,
						options,
						inventory,
						diff,
						repositorySpecification,
						plan,
						checkpoint.completedModules,
					);
					await this.savePipelineCheckpoint(options, checkpoint);
				} catch (error) {
					if (isAbortError(error)) {
						throw error;
					}
					firstFailure ??= error;
				}
			}
		};
		await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
		if (firstFailure) {
			throw firstFailure;
		}
	}

	private async runPipelineAgent(
		options: WikiInitializationOptions,
		checkpoint: WikiPipelineCheckpoint,
		context: WikiAgentTraceContext,
		systemPrompt: string,
		userPrompt: string,
		tools: ReturnType<typeof createReadOnlyAgentTools>,
	) {
		const continuation = findContinuation(checkpoint, context.stage, context.moduleId);
		return this.runner.run({
			config: options.config,
			client: options.client,
			systemPrompt,
			userPrompt,
			tools,
			signal: options.signal,
			onProgress: (progress) => options.onProgress?.({ message: progress.message }),
			onTrace: (event) => options.onTrace?.(event, context),
			resumeFrom: continuation?.checkpoint,
			onCheckpoint: async (agentCheckpoint) => {
				upsertContinuation(checkpoint, context.stage, context.moduleId, agentCheckpoint);
				checkpoint.wikiSignature = await this.wikiSignature(options.root.uri);
				await this.savePipelineCheckpoint(options, checkpoint);
			},
		});
	}

	private async savePipelineCheckpoint(options: WikiInitializationOptions, checkpoint: WikiPipelineCheckpoint): Promise<void> {
		checkpoint.updatedAt = new Date().toISOString();
		await this.pipelineStore.save(checkpoint);
		options.onCheckpoint?.();
	}

	private async wikiSignature(rootUri: vscode.Uri): Promise<string> {
		const entries: Array<[string, string]> = [];
		await collectTextFiles(this.stateService.referencesUri(rootUri), '', entries);
		try {
			entries.push([agentsGuidanceFileName, decodeUtf8(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(rootUri, agentsGuidanceFileName)))]);
		} catch {
			// A missing root guidance file is part of the signature.
		}
		return createHash('sha256').update(JSON.stringify(entries.sort(([left], [right]) => left.localeCompare(right)))).digest('hex');
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

	private async ensureAgentsGuidance(rootUri: vscode.Uri): Promise<void> {
		if (await this.hasAgentsGuidance(rootUri)) {
			return;
		}
		throw new Error(`Wiki Agent did not create ${agentsGuidanceFileName} guidance.`);
	}

	private async hasAgentsGuidance(rootUri: vscode.Uri): Promise<boolean> {
		try {
			const content = decodeUtf8(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(rootUri, agentsGuidanceFileName)));
			return content.includes(agentsGuidanceStartMarker);
		} catch {
			return false;
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

interface RepositoryInventory {
	fileCount: number;
	topLevelCounts: Record<string, number>;
	extensionCounts: Record<string, number>;
	manifests: string[];
	entryPointCandidates: string[];
	changedPaths?: {
		added: string[];
		modified: string[];
		deleted: string[];
	};
}

function repositoryInventory(sourceFingerprints: Record<string, string>, diff?: SourceFingerprintDiff): RepositoryInventory {
	const paths = Object.keys(sourceFingerprints).sort();
	const topLevelCounts: Record<string, number> = {};
	const extensionCounts: Record<string, number> = {};
	const manifests: string[] = [];
	const entryPointCandidates: string[] = [];
	const manifestNames = new Set([
		'package.json', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts',
		'pyproject.toml', 'requirements.txt', 'Gemfile', 'composer.json', 'mix.exs',
	]);
	for (const current of paths) {
		const topLevel = current.includes('/') ? current.slice(0, current.indexOf('/')) : '.';
		topLevelCounts[topLevel] = (topLevelCounts[topLevel] ?? 0) + 1;
		const extension = path.posix.extname(current).toLowerCase() || '[none]';
		extensionCounts[extension] = (extensionCounts[extension] ?? 0) + 1;
		const basename = path.posix.basename(current);
		if (manifestNames.has(basename)) {
			manifests.push(current);
		}
		if (/^(index|main|app|server|extension)\.[^.]+$/i.test(basename) || /(^|\/)(cmd|bin)\//.test(current)) {
			entryPointCandidates.push(current);
		}
	}
	return {
		fileCount: paths.length,
		topLevelCounts: sortedRecord(topLevelCounts),
		extensionCounts: sortedRecord(extensionCounts),
		manifests,
		entryPointCandidates: entryPointCandidates.slice(0, 100),
		changedPaths: diff ? { added: diff.added, modified: diff.modified, deleted: diff.deleted } : undefined,
	};
}

function plannerSystemPrompt(operation: WikiPipelineOperation): string {
	return [
		`You are the Planner Agent for a Wiki ${operation} pipeline.`,
		'Inspect the repository with read-only tools and divide the work into coherent architectural or business modules, never one module per file.',
		'Use repository-relative files or directory prefixes in sourceScopes and sharedPaths. Do not use globs, absolute paths, dot paths, or parent traversal.',
		'Every module must include sharedPaths. Use an empty array when there are no shared paths.',
		'Every changed path in an update must be covered by at least one module sourceScopes or sharedPaths entry.',
		'Return {"type":"final","result":{"summary":"...","modules":[{"id":"stable-id","name":"Module","sourceScopes":["src/module"],"sharedPaths":["package.json"],"goals":["..."]}]}}.',
	].join('\n');
}

function plannerUserPrompt(operation: WikiPipelineOperation, inventory: RepositoryInventory, diff?: SourceFingerprintDiff): string {
	return [
		`Plan the repository Wiki ${operation}.`,
		`Repository inventory: ${JSON.stringify(inventory)}`,
		diff ? `Source changes: ${JSON.stringify({ added: diff.added, modified: diff.modified, deleted: diff.deleted })}` : '',
		'Read schema.md and inspect manifests, entry points, and module boundaries before returning the plan.',
	].filter(Boolean).join('\n');
}

function moduleAnalystSystemPrompt(): string {
	return [
		'You are a read-only Module Analyst Agent in a repository Wiki pipeline.',
		'Analyze only the assigned source scopes and shared paths. Wiki pages may be read for context but never modified.',
		'Ground every durable claim in repository-relative evidence paths and record uncertainty rather than guessing.',
		'Every list field must contain plain strings only. Do not return objects inside responsibilities, entryPoints, interfaces, workflows, dependencies, decisions, evidencePaths, or openQuestions.',
		'Return {"type":"final","result":{"moduleId":"...","summary":"...","responsibilities":[],"entryPoints":[],"interfaces":[],"workflows":[],"dependencies":[],"decisions":[],"evidencePaths":[],"openQuestions":[]}}.',
	].join('\n');
}

function moduleAnalystUserPrompt(
	operation: WikiPipelineOperation,
	module: WikiModulePlan,
	inventory: RepositoryInventory,
	diff?: SourceFingerprintDiff,
): string {
	return [
		`Analyze this module for Wiki ${operation}: ${JSON.stringify(module)}`,
		`Repository inventory: ${JSON.stringify(inventory)}`,
		diff ? `Source changes: ${JSON.stringify({ added: diff.added, modified: diff.modified, deleted: diff.deleted })}` : '',
		'Return a compact structured analysis; do not reproduce large source excerpts.',
	].filter(Boolean).join('\n');
}

function integrationSystemPrompt(operation: WikiPipelineOperation, repositorySpecification: string): string {
	return [
		`You are the Wiki Integration Agent for repository Wiki ${operation}.`,
		'You are the only Agent allowed to write Wiki files. Integrate the module analyses into a consistent, source-grounded repository Wiki.',
		'Read relevant existing Wiki pages before changing them. Preserve accurate source-grounded content and do not overwrite it without evidence.',
		'Create or refresh the managed root AGENTS.md guidance. Keep schema.md out of the normal index.md business-page catalog.',
		'Create every required initial page when initializing; during update, revise all pages affected by the source changes.',
		'Use source paths as evidence and record unresolved uncertainty in open-questions.md.',
		'Finish with {"type":"final","result":{"summary":"...","warnings":[]}}.',
		`Repository Wiki skill schema:\n${repositorySpecification}`,
	].join('\n');
}

function integrationUserPrompt(
	operation: WikiPipelineOperation,
	plan: WikiModulePlan[],
	analyses: WikiModuleAnalysis[],
	diff?: SourceFingerprintDiff,
): string {
	return [
		`Complete the repository Wiki ${operation}.`,
		`Module plan: ${JSON.stringify(plan)}`,
		`Validated module analyses: ${JSON.stringify(analyses)}`,
		diff ? `Source changes: ${JSON.stringify({ added: diff.added, modified: diff.modified, deleted: diff.deleted })}` : '',
		'Use tools to read existing Wiki content, write the required pages, and refresh root AGENTS.md guidance.',
	].filter(Boolean).join('\n');
}

function validateWikiModulePlan(value: Record<string, unknown>, diff?: SourceFingerprintDiff): WikiModulePlan[] {
	if (!Array.isArray(value.modules) || value.modules.length === 0) {
		throw new Error('Wiki Planner must return at least one module.');
	}
	const ids = new Set<string>();
	const modules = value.modules.map((candidate): WikiModulePlan => {
		if (!isJsonObject(candidate)
			|| typeof candidate.id !== 'string'
			|| !/^[a-z0-9][a-z0-9-]{0,63}$/.test(candidate.id)
			|| typeof candidate.name !== 'string'
			|| !candidate.name.trim()) {
			throw new Error('Each Wiki module requires a stable lowercase id and name.');
		}
		if (ids.has(candidate.id)) {
			throw new Error(`Duplicate Wiki module id: ${candidate.id}`);
		}
		ids.add(candidate.id);
		const sourceScopes = sourcePathArray(candidate.sourceScopes, 'sourceScopes');
		const sharedPaths = sourcePathArray(
			candidate.sharedPaths === undefined ? [] : candidate.sharedPaths,
			'sharedPaths',
			true,
		);
		const goals = stringArray(candidate.goals, 'goals');
		if (sourceScopes.length === 0) {
			throw new Error(`Wiki module ${candidate.id} has no source scope.`);
		}
		return {
			id: candidate.id,
			name: candidate.name.trim(),
			sourceScopes,
			sharedPaths,
			goals,
		};
	});
	if (diff) {
		const changed = [...diff.added, ...diff.modified, ...diff.deleted];
		for (const changedPath of changed) {
			if (!modules.some((module) => [...module.sourceScopes, ...module.sharedPaths].some((scope) => pathWithinScope(changedPath, scope)))) {
				throw new Error(`Wiki Planner did not assign changed path to a module: ${changedPath}`);
			}
		}
	}
	return modules;
}

function validateWikiModuleAnalysis(value: Record<string, unknown>, module: WikiModulePlan): WikiModuleAnalysis {
	if (value.moduleId !== module.id || typeof value.summary !== 'string' || !value.summary.trim()) {
		throw new Error(`Module Analyst result does not match module ${module.id}.`);
	}
	const evidencePaths = sourcePathArray(value.evidencePaths, 'evidencePaths', true);
	for (const evidencePath of evidencePaths) {
		if (![...module.sourceScopes, ...module.sharedPaths].some((scope) => pathWithinScope(evidencePath, scope))) {
			throw new Error(`Module Analyst cited evidence outside ${module.id}: ${evidencePath}`);
		}
	}
	return {
		moduleId: module.id,
		summary: value.summary.trim(),
		responsibilities: analysisTextArray(value.responsibilities, 'responsibilities'),
		entryPoints: analysisTextArray(value.entryPoints, 'entryPoints'),
		interfaces: analysisTextArray(value.interfaces, 'interfaces'),
		workflows: analysisTextArray(value.workflows, 'workflows'),
		dependencies: analysisTextArray(value.dependencies, 'dependencies'),
		decisions: analysisTextArray(value.decisions, 'decisions'),
		evidencePaths,
		openQuestions: analysisTextArray(value.openQuestions, 'openQuestions'),
	};
}

function analysisTextArray(value: unknown, label: string): string[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new Error(`${label} must be an array.`);
	}
	return value.map((item) => {
		if (typeof item === 'string') {
			return item.trim();
		}
		if (isJsonObject(item)) {
			return JSON.stringify(item);
		}
		throw new Error(`${label} items must be strings or JSON objects.`);
	}).filter(Boolean);
}

function sourcePathArray(value: unknown, label: string, allowEmpty = false): string[] {
	const values = stringArray(value, label).map(normalizeSourcePath);
	const unique = [...new Set(values)];
	if (!allowEmpty && unique.length === 0) {
		throw new Error(`${label} cannot be empty.`);
	}
	return unique;
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
		throw new Error(`${label} must be an array of strings.`);
	}
	return value.map((item) => item.trim()).filter(Boolean);
}

function normalizeSourcePath(candidate: string): string {
	const normalized = candidate.trim().replace(/\\/g, '/').replace(/\/+$/g, '') || '.';
	if (normalized.startsWith('/')
		|| normalized.includes('*')
		|| normalized.split('/').some((segment) => !segment || segment === '..')
		|| (normalized.length >= 3 && normalized[1] === ':' && normalized[2] === '/')
		|| (normalized !== '.' && normalized.split('/').some((segment) => segment.startsWith('.')))) {
		throw new Error(`Invalid repository-relative source path: ${candidate}`);
	}
	return normalized;
}

function pathWithinScope(candidate: string, scope: string): boolean {
	const normalized = candidate.replace(/\\/g, '/');
	return scope === '.' || normalized === scope || normalized.startsWith(`${scope}/`);
}

function normalizeConcurrency(value: unknown, count: number): number {
	if (count <= 1) {
		return Math.max(1, count);
	}
	if (value === 0) {
		return count;
	}
	const configured = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 3;
	return Math.max(1, Math.min(count, configured));
}

function findContinuation(
	checkpoint: WikiPipelineCheckpoint,
	stage: WikiPipelineStage,
	moduleId?: string,
): WikiAgentContinuation | undefined {
	return checkpoint.continuations.find((item) => item.stage === stage && item.moduleId === moduleId);
}

function upsertContinuation(
	checkpoint: WikiPipelineCheckpoint,
	stage: WikiPipelineStage,
	moduleId: string | undefined,
	agentCheckpoint: AgentRunCheckpoint,
): void {
	checkpoint.continuations = [
		...checkpoint.continuations.filter((item) => item.stage !== stage || item.moduleId !== moduleId),
		{ stage, moduleId, checkpoint: agentCheckpoint },
	];
}

function removeContinuation(checkpoint: WikiPipelineCheckpoint, stage: WikiPipelineStage, moduleId?: string): void {
	checkpoint.continuations = checkpoint.continuations.filter((item) => item.stage !== stage || item.moduleId !== moduleId);
}

function recordSignature(value: Record<string, string>): string {
	return createHash('sha256').update(JSON.stringify(sortedRecord(value))).digest('hex');
}

function wikiPipelineFingerprint(
	operation: WikiPipelineOperation,
	options: Pick<WikiInitializationOptions, 'root' | 'config'>,
	inventory: RepositoryInventory,
	diff: SourceFingerprintDiff | undefined,
	repositorySpecification: string,
	plan: WikiModulePlan[] | undefined,
	completedModules: WikiModuleAnalysis[],
): string {
	const plannerTools = createReadOnlyAgentTools({ root: options.root, includeWikiTools: true });
	const integrationTools = createWikiAgentTools({ root: options.root })
		.filter((tool) => tool.name !== 'append_wiki_log');
	return createHash('sha256').update(JSON.stringify({
		version: 1,
		operation,
		provider: options.config.provider,
		baseUrl: options.config.baseUrl,
		model: options.config.model,
		jsonOutputEnabled: options.config.jsonOutputEnabled,
		thinkingMode: options.config.thinkingMode,
		strictTools: options.config.strictTools,
		planner: {
			systemPrompt: plannerSystemPrompt(operation),
			userPrompt: plannerUserPrompt(operation, inventory, diff),
			tools: agentToolProtocol(plannerTools),
		},
		modules: (plan ?? []).map((module) => ({
			id: module.id,
			systemPrompt: moduleAnalystSystemPrompt(),
			userPrompt: moduleAnalystUserPrompt(operation, module, inventory, diff),
			allowedWorkspacePaths: [...module.sourceScopes, ...module.sharedPaths],
			tools: agentToolProtocol(plannerTools),
		})),
		integration: {
			systemPrompt: integrationSystemPrompt(operation, repositorySpecification),
			userPrompt: integrationUserPrompt(operation, plan ?? [], completedModules, diff),
			tools: agentToolProtocol(integrationTools),
		},
	})).digest('hex');
}

function agentToolProtocol(tools: ReturnType<typeof createReadOnlyAgentTools>): Array<{
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}> {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
}

function pipelineCompatible(
	checkpoint: WikiPipelineCheckpoint,
	operation: WikiPipelineOperation,
	sourceSignature: string,
	wikiSignature: string,
	runFingerprint: string,
): boolean {
	return checkpoint.operation === operation
		&& checkpoint.sourceSignature === sourceSignature
		&& checkpoint.wikiSignature === wikiSignature
		&& checkpoint.runFingerprint === runFingerprint;
}

function sortedRecord<T>(value: Record<string, T>): Record<string, T> {
	return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

async function collectTextFiles(parent: vscode.Uri, prefix: string, entries: Array<[string, string]>): Promise<void> {
	try {
		for (const [name, type] of await vscode.workspace.fs.readDirectory(parent)) {
			const relative = prefix ? `${prefix}/${name}` : name;
			const uri = vscode.Uri.joinPath(parent, name);
			if ((type & vscode.FileType.Directory) !== 0) {
				await collectTextFiles(uri, relative, entries);
			} else if ((type & vscode.FileType.File) !== 0 && name.endsWith('.md')) {
				entries.push([relative, decodeUtf8(await vscode.workspace.fs.readFile(uri))]);
			}
		}
	} catch {
		// A missing references directory has an empty signature.
	}
}

export { OperationCancelledError };
