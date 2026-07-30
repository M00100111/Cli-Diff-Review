import { createHash, randomUUID } from 'crypto';
import * as vscode from 'vscode';
import type { AgentRunCheckpoint } from '../agent/runtime';

export type WikiPipelineOperation = 'initialize' | 'update';
export type WikiPipelineStage = 'plan' | 'module' | 'integration';

export interface WikiModulePlan {
	id: string;
	name: string;
	sourceScopes: string[];
	sharedPaths: string[];
	goals: string[];
}

export interface WikiModuleAnalysis {
	moduleId: string;
	summary: string;
	responsibilities: string[];
	entryPoints: string[];
	interfaces: string[];
	workflows: string[];
	dependencies: string[];
	decisions: string[];
	evidencePaths: string[];
	openQuestions: string[];
}

export interface WikiAgentContinuation {
	stage: WikiPipelineStage;
	moduleId?: string;
	checkpoint: AgentRunCheckpoint;
}

export interface WikiPipelineCheckpoint {
	version: 1;
	rootUri: string;
	operation: WikiPipelineOperation;
	stage: WikiPipelineStage;
	sourceSignature: string;
	wikiSignature: string;
	runFingerprint: string;
	plan?: WikiModulePlan[];
	completedModules: WikiModuleAnalysis[];
	continuations: WikiAgentContinuation[];
	generatedFiles: string[];
	updatedAt: string;
}

export class WikiPipelineStore {
	private readonly memory = new Map<string, WikiPipelineCheckpoint>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly directory: vscode.Uri | undefined;

	public constructor(storageUri?: vscode.Uri) {
		this.directory = storageUri ? vscode.Uri.joinPath(storageUri, 'wiki-pipelines') : undefined;
	}

	public async load(rootUri: vscode.Uri): Promise<WikiPipelineCheckpoint | undefined> {
		const key = rootUri.toString();
		const cached = this.memory.get(key);
		if (cached) {
			return cloneCheckpoint(cached);
		}
		if (!this.directory) {
			return undefined;
		}
		try {
			const value = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(this.checkpointUri(rootUri))).toString('utf8')) as unknown;
			const checkpoint = normalizeCheckpoint(value, rootUri);
			if (checkpoint) {
				this.memory.set(key, checkpoint);
				return cloneCheckpoint(checkpoint);
			}
		} catch {
			// Missing, corrupt, and incompatible checkpoints are treated as absent.
		}
		return undefined;
	}

	public save(checkpoint: WikiPipelineCheckpoint): Promise<void> {
		const key = checkpoint.rootUri;
		const snapshot = cloneCheckpoint(checkpoint);
		this.memory.set(key, snapshot);
		return this.enqueue(key, async () => {
			if (!this.directory) {
				return;
			}
			await vscode.workspace.fs.createDirectory(this.directory);
			const rootUri = vscode.Uri.parse(checkpoint.rootUri);
			const target = this.checkpointUri(rootUri);
			const temporary = vscode.Uri.joinPath(this.directory, `${rootHash(rootUri)}.${randomUUID()}.tmp`);
			await vscode.workspace.fs.writeFile(temporary, Buffer.from(JSON.stringify(snapshot), 'utf8'));
			try {
				await vscode.workspace.fs.rename(temporary, target, { overwrite: true });
			} catch (error) {
				try {
					await vscode.workspace.fs.delete(temporary);
				} catch {
					// Best-effort cleanup of a private temporary file.
				}
				throw error;
			}
		});
	}

	public clear(rootUri: vscode.Uri): Promise<void> {
		const key = rootUri.toString();
		this.memory.delete(key);
		return this.enqueue(key, async () => {
			if (!this.directory) {
				return;
			}
			try {
				await vscode.workspace.fs.delete(this.checkpointUri(rootUri));
			} catch {
				// Clearing an already absent checkpoint is idempotent.
			}
		});
	}

	private enqueue(key: string, operation: () => Promise<void>): Promise<void> {
		const previous = this.queues.get(key) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(operation);
		this.queues.set(key, next);
		return next.finally(() => {
			if (this.queues.get(key) === next) {
				this.queues.delete(key);
			}
		});
	}

	private checkpointUri(rootUri: vscode.Uri): vscode.Uri {
		return vscode.Uri.joinPath(this.directory!, `${rootHash(rootUri)}.json`);
	}
}

function rootHash(rootUri: vscode.Uri): string {
	return createHash('sha256').update(rootUri.toString()).digest('hex');
}

function cloneCheckpoint(checkpoint: WikiPipelineCheckpoint): WikiPipelineCheckpoint {
	return JSON.parse(JSON.stringify(checkpoint)) as WikiPipelineCheckpoint;
}

function normalizeCheckpoint(value: unknown, rootUri: vscode.Uri): WikiPipelineCheckpoint | undefined {
	if (!isRecord(value)
		|| value.version !== 1
		|| value.rootUri !== rootUri.toString()
		|| (value.operation !== 'initialize' && value.operation !== 'update')
		|| (value.stage !== 'plan' && value.stage !== 'module' && value.stage !== 'integration')
		|| typeof value.sourceSignature !== 'string'
		|| typeof value.wikiSignature !== 'string'
		|| typeof value.runFingerprint !== 'string'
		|| typeof value.updatedAt !== 'string'
		|| !Array.isArray(value.completedModules)
		|| !Array.isArray(value.continuations)
		|| (value.generatedFiles !== undefined && !isStringArray(value.generatedFiles))) {
		return undefined;
	}
	const plan = value.plan === undefined ? undefined : normalizePlan(value.plan);
	if (value.plan !== undefined && !plan) {
		return undefined;
	}
	const completedModules = value.completedModules.map(normalizeAnalysis);
	const continuations = value.continuations.map(normalizeContinuation);
	if (completedModules.some((item) => !item) || continuations.some((item) => !item)) {
		return undefined;
	}
	return {
		version: 1,
		rootUri: value.rootUri,
		operation: value.operation,
		stage: value.stage,
		sourceSignature: value.sourceSignature,
		wikiSignature: value.wikiSignature,
		runFingerprint: value.runFingerprint,
		plan,
		completedModules: completedModules as WikiModuleAnalysis[],
		continuations: continuations as WikiAgentContinuation[],
		generatedFiles: value.generatedFiles ?? [],
		updatedAt: value.updatedAt,
	};
}

function normalizePlan(value: unknown): WikiModulePlan[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const modules = value.map((item) => {
		if (!isRecord(item)
			|| typeof item.id !== 'string'
			|| typeof item.name !== 'string'
			|| !isStringArray(item.sourceScopes)
			|| !isStringArray(item.sharedPaths)
			|| !isStringArray(item.goals)) {
			return undefined;
		}
		return {
			id: item.id,
			name: item.name,
			sourceScopes: item.sourceScopes,
			sharedPaths: item.sharedPaths,
			goals: item.goals,
		};
	});
	return modules.some((item) => !item) ? undefined : modules as WikiModulePlan[];
}

function normalizeAnalysis(value: unknown): WikiModuleAnalysis | undefined {
	if (!isRecord(value)
		|| typeof value.moduleId !== 'string'
		|| typeof value.summary !== 'string'
		|| !isStringArray(value.responsibilities)
		|| !isStringArray(value.entryPoints)
		|| !isStringArray(value.interfaces)
		|| !isStringArray(value.workflows)
		|| !isStringArray(value.dependencies)
		|| !isStringArray(value.decisions)
		|| !isStringArray(value.evidencePaths)
		|| !isStringArray(value.openQuestions)) {
		return undefined;
	}
	return {
		moduleId: value.moduleId,
		summary: value.summary,
		responsibilities: value.responsibilities,
		entryPoints: value.entryPoints,
		interfaces: value.interfaces,
		workflows: value.workflows,
		dependencies: value.dependencies,
		decisions: value.decisions,
		evidencePaths: value.evidencePaths,
		openQuestions: value.openQuestions,
	};
}

function normalizeContinuation(value: unknown): WikiAgentContinuation | undefined {
	if (!isRecord(value)
		|| (value.stage !== 'plan' && value.stage !== 'module' && value.stage !== 'integration')
		|| (value.moduleId !== undefined && typeof value.moduleId !== 'string')
		|| !isAgentCheckpoint(value.checkpoint)) {
		return undefined;
	}
	return {
		stage: value.stage,
		moduleId: value.moduleId,
		checkpoint: value.checkpoint,
	};
}

function isAgentCheckpoint(value: unknown): value is AgentRunCheckpoint {
	return isRecord(value)
		&& value.version === 1
		&& typeof value.nextRound === 'number'
		&& Array.isArray(value.messages)
		&& typeof value.toolCalls === 'number'
		&& typeof value.toolResultChars === 'number'
		&& typeof value.runFingerprint === 'string';
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === 'object' && value !== null;
}
