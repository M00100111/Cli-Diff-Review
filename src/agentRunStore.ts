import { createHash, randomUUID } from 'crypto';
import * as vscode from 'vscode';
import type { LlmWikiRunLogEntry } from './reviewDashboard';

export type ProjectAgentTaskKind = 'initialize' | 'update' | 'review';
export type ProjectAgentLifecycle =
	| 'running'
	| 'completed'
	| 'failed'
	| 'cancelled'
	| 'paused'
	| 'interrupted';

export interface StoredProjectAgentRun {
	version: 1;
	runId: string;
	projectId?: string;
	rootUri: string;
	kind: ProjectAgentTaskKind;
	source: 'wiki' | 'review';
	lifecycle: ProjectAgentLifecycle;
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	progress?: string;
	error?: string;
	sequence: number;
	entries: LlmWikiRunLogEntry[];
}

interface PendingWrite {
	pending?: StoredProjectAgentRun;
	active?: Promise<void>;
	waiters: Array<{
		resolve: () => void;
		reject: (error: unknown) => void;
	}>;
}

export class AgentRunStore {
	private readonly directory: vscode.Uri;
	private readonly writes = new Map<string, PendingWrite>();

	public constructor(context: vscode.ExtensionContext) {
		this.directory = vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'agent-runs');
	}

	public async load(rootUri: vscode.Uri): Promise<StoredProjectAgentRun | undefined> {
		try {
			const parsed = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(this.runUri(rootUri))).toString('utf8')) as unknown;
			return normalizeStoredProjectAgentRun(parsed, rootUri);
		} catch {
			return undefined;
		}
	}

	public save(run: StoredProjectAgentRun): Promise<void> {
		const key = run.rootUri;
		const state = this.writes.get(key) ?? { waiters: [] };
		this.writes.set(key, state);
		state.pending = cloneRun(run);
		const completion = new Promise<void>((resolve, reject) => state.waiters.push({ resolve, reject }));
		if (!state.active) {
			state.active = this.drain(vscode.Uri.parse(run.rootUri), key, state);
		}
		return completion;
	}

	public async flushAll(): Promise<void> {
		await Promise.all([...this.writes.values()].map((state) => state.active).filter((value): value is Promise<void> => Boolean(value)));
	}

	private async drain(rootUri: vscode.Uri, key: string, state: PendingWrite): Promise<void> {
		try {
			while (state.pending) {
				const snapshot = state.pending;
				state.pending = undefined;
				await this.write(rootUri, snapshot);
			}
			for (const waiter of state.waiters.splice(0)) {
				waiter.resolve();
			}
		} catch (error) {
			for (const waiter of state.waiters.splice(0)) {
				waiter.reject(error);
			}
		} finally {
			state.active = undefined;
			if (state.pending) {
				state.active = this.drain(rootUri, key, state);
			} else if (state.waiters.length === 0) {
				this.writes.delete(key);
			}
		}
	}

	private async write(rootUri: vscode.Uri, run: StoredProjectAgentRun): Promise<void> {
		await vscode.workspace.fs.createDirectory(this.directory);
		const target = this.runUri(rootUri);
		const temporary = vscode.Uri.joinPath(this.directory, `${pathHash(rootUri)}.${randomUUID()}.tmp`);
		await vscode.workspace.fs.writeFile(temporary, Buffer.from(JSON.stringify(run), 'utf8'));
		try {
			await vscode.workspace.fs.rename(temporary, target, { overwrite: true });
		} catch (error) {
			try {
				await vscode.workspace.fs.delete(temporary);
			} catch {
				// Best-effort cleanup for an optional temporary file.
			}
			throw error;
		}
	}

	private runUri(rootUri: vscode.Uri): vscode.Uri {
		return vscode.Uri.joinPath(this.directory, `${pathHash(rootUri)}.json`);
	}
}

function pathHash(rootUri: vscode.Uri): string {
	return createHash('sha256').update(rootUri.toString()).digest('hex');
}

function cloneRun(run: StoredProjectAgentRun): StoredProjectAgentRun {
	return {
		...run,
		entries: run.entries.map((entry) => ({
			...entry,
			details: entry.details.map((detail) => ({ ...detail })),
		})),
	};
}

function normalizeStoredProjectAgentRun(value: unknown, rootUri: vscode.Uri): StoredProjectAgentRun | undefined {
	if (!isRecord(value)
		|| value.version !== 1
		|| typeof value.runId !== 'string'
		|| value.rootUri !== rootUri.toString()
		|| !isTaskKind(value.kind)
		|| (value.source !== 'wiki' && value.source !== 'review')
		|| !isLifecycle(value.lifecycle)
		|| typeof value.startedAt !== 'string'
		|| typeof value.updatedAt !== 'string'
		|| typeof value.sequence !== 'number'
		|| !Array.isArray(value.entries)) {
		return undefined;
	}
	const entries = value.entries.filter(isRunLogEntry);
	if (entries.length !== value.entries.length) {
		return undefined;
	}
	return {
		version: 1,
		runId: value.runId,
		projectId: typeof value.projectId === 'string' ? value.projectId : undefined,
		rootUri: value.rootUri,
		kind: value.kind,
		source: value.source,
		lifecycle: value.lifecycle,
		startedAt: value.startedAt,
		updatedAt: value.updatedAt,
		completedAt: typeof value.completedAt === 'string' ? value.completedAt : undefined,
		progress: typeof value.progress === 'string' ? value.progress : undefined,
		error: typeof value.error === 'string' ? value.error : undefined,
		sequence: Math.max(0, Math.floor(value.sequence)),
		entries,
	};
}

function isRunLogEntry(value: unknown): value is LlmWikiRunLogEntry {
	return isRecord(value)
		&& typeof value.id === 'string'
		&& typeof value.sequence === 'number'
		&& typeof value.timestamp === 'string'
		&& typeof value.kind === 'string'
		&& typeof value.title === 'string'
		&& typeof value.summary === 'string'
		&& typeof value.status === 'string'
		&& Array.isArray(value.details);
}

function isTaskKind(value: unknown): value is ProjectAgentTaskKind {
	return value === 'initialize' || value === 'update' || value === 'review';
}

function isLifecycle(value: unknown): value is ProjectAgentLifecycle {
	return value === 'running'
		|| value === 'completed'
		|| value === 'failed'
		|| value === 'cancelled'
		|| value === 'paused'
		|| value === 'interrupted';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
