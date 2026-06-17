import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { gitIgnoredReviewPaths, normalizeReviewPath, shouldSkipReviewPath } from '../reviewFileFilter';
import { decodeUtf8, encodeUtf8, isProbablyBinary, relativePath } from '../text';
import { throwIfAborted } from './cancellation';

export type WikiAgentState = 'initializing' | 'ready' | 'paused' | 'updating' | 'failed';

export interface WikiState {
	version: 2;
	status: WikiAgentState;
	skillHash: string;
	schemaHash: string;
	generatedFiles: string[];
	sourceFingerprints: Record<string, string>;
	lastSyncedAt?: string;
	lastRunSummary?: string;
}

export interface SourceFingerprintDiff {
	added: string[];
	modified: string[];
	deleted: string[];
	current: Record<string, string>;
}

const stateFileName = '.state.json';
const skillsDirectoryName = '.skills';
const skillDirectoryName = 'llm-code-wiki';
const referencesDirectoryName = 'references';
const skillFileName = 'SKILL.md';
const schemaFileName = 'schema.md';
const sourceMaxFiles = 5000;
const sourceMaxFileBytes = 2 * 1024 * 1024;

export class WikiStateService {
	public constructor(private readonly extensionUri: vscode.Uri) {}

	public wikiUri(rootUri: vscode.Uri): vscode.Uri {
		return vscode.Uri.joinPath(rootUri, skillsDirectoryName, skillDirectoryName);
	}

	public referencesUri(rootUri: vscode.Uri): vscode.Uri {
		return vscode.Uri.joinPath(this.wikiUri(rootUri), referencesDirectoryName);
	}

	public stateUri(rootUri: vscode.Uri): vscode.Uri {
		return vscode.Uri.joinPath(this.wikiUri(rootUri), stateFileName);
	}

	public skillUri(rootUri: vscode.Uri): vscode.Uri {
		return vscode.Uri.joinPath(this.wikiUri(rootUri), skillFileName);
	}

	public schemaUri(rootUri: vscode.Uri): vscode.Uri {
		return vscode.Uri.joinPath(this.referencesUri(rootUri), schemaFileName);
	}

	public async wikiExists(rootUri: vscode.Uri): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(this.wikiUri(rootUri));
			return true;
		} catch {
			return false;
		}
	}

	public async read(rootUri: vscode.Uri): Promise<WikiState | undefined> {
		try {
			const parsed = JSON.parse(decodeUtf8(await vscode.workspace.fs.readFile(this.stateUri(rootUri)))) as unknown;
			return isWikiState(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	public async write(rootUri: vscode.Uri, state: WikiState): Promise<void> {
		await vscode.workspace.fs.createDirectory(this.wikiUri(rootUri));
		await vscode.workspace.fs.writeFile(this.stateUri(rootUri), encodeUtf8(JSON.stringify(state, null, 2)));
	}

	public async ensureScaffold(root: vscode.WorkspaceFolder, status: WikiAgentState, signal?: AbortSignal): Promise<WikiState> {
		throwIfAborted(signal);
		await vscode.workspace.fs.createDirectory(this.wikiUri(root.uri));
		await vscode.workspace.fs.createDirectory(this.referencesUri(root.uri));
		const skill = await this.readBundledSkill();
		const schema = await this.readBundledSchema();
		try {
			await vscode.workspace.fs.stat(this.skillUri(root.uri));
		} catch {
			await vscode.workspace.fs.writeFile(this.skillUri(root.uri), encodeUtf8(skill));
		}
		try {
			await vscode.workspace.fs.stat(this.schemaUri(root.uri));
		} catch {
			await vscode.workspace.fs.writeFile(this.schemaUri(root.uri), encodeUtf8(schema));
		}
		const existing = await this.read(root.uri);
		const state: WikiState = existing ?? {
			version: 2,
			status,
			skillHash: hashText(skill),
			schemaHash: hashText(schema),
			generatedFiles: [],
			sourceFingerprints: {},
		};
		state.status = status;
		state.skillHash = hashText(skill);
		state.schemaHash = hashText(schema);
		await this.write(root.uri, state);
		return state;
	}

	public async completeRun(
		root: vscode.WorkspaceFolder,
		state: WikiState,
		summary: string,
		generatedFiles: string[],
		signal?: AbortSignal,
		expectedFingerprints?: Record<string, string>,
	): Promise<WikiState> {
		const sourceFingerprints = await this.computeSourceFingerprints(root, signal);
		if (expectedFingerprints && !sameFingerprints(sourceFingerprints, expectedFingerprints)) {
			throw new Error('Source files changed while the Wiki Agent was running. Run the update again.');
		}
		const completed: WikiState = {
			...state,
			status: 'ready',
			generatedFiles: [...new Set(generatedFiles)].sort(),
			sourceFingerprints,
			lastSyncedAt: new Date().toISOString(),
			lastRunSummary: summary,
		};
		await this.write(root.uri, completed);
		return completed;
	}

	public async sourceDiff(root: vscode.WorkspaceFolder, state: WikiState, signal?: AbortSignal): Promise<SourceFingerprintDiff> {
		const current = await this.computeSourceFingerprints(root, signal);
		const previous = state.sourceFingerprints;
		return {
			added: Object.keys(current).filter((file) => !(file in previous)).sort(),
			modified: Object.keys(current).filter((file) => file in previous && current[file] !== previous[file]).sort(),
			deleted: Object.keys(previous).filter((file) => !(file in current)).sort(),
			current,
		};
	}

	public async computeSourceFingerprints(root: vscode.WorkspaceFolder, signal?: AbortSignal): Promise<Record<string, string>> {
		throwIfAborted(signal);
		const uris = await vscode.workspace.findFiles(
			new vscode.RelativePattern(root, '**/*'),
			'**/{.git,.skills,node_modules,dist,out,.vscode-test}/**',
			sourceMaxFiles,
		);
		const paths = new Map(uris.map((uri) => [uri.toString(), normalizeReviewPath(relativePath(root.uri, uri))]));
		const ignored = await gitIgnoredReviewPaths(root, [...paths.values()]);
		const fingerprints: Record<string, string> = {};
		for (const uri of uris) {
			throwIfAborted(signal);
			const currentPath = paths.get(uri.toString()) ?? normalizeReviewPath(relativePath(root.uri, uri));
			if (shouldSkipReviewPath(currentPath, false) || ignored.has(currentPath)) {
				continue;
			}
			try {
				const data = await vscode.workspace.fs.readFile(uri);
				if (data.length > sourceMaxFileBytes || isProbablyBinary(data)) {
					continue;
				}
				fingerprints[currentPath] = createHash('sha256').update(data).digest('hex');
			} catch {
				// Files may disappear while fingerprints are being computed.
			}
		}
		return fingerprints;
	}

	public async readBundledSkill(): Promise<string> {
		return decodeUtf8(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.extensionUri, 'llm-code-wiki', skillFileName)));
	}

	public async readBundledSchema(): Promise<string> {
		return decodeUtf8(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.extensionUri, 'llm-code-wiki', schemaFileName)));
	}
}

function hashText(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

function isWikiState(value: unknown): value is WikiState {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const state = value as Partial<WikiState>;
	return state.version === 2
		&& typeof state.status === 'string'
		&& typeof state.skillHash === 'string'
		&& typeof state.schemaHash === 'string'
		&& Array.isArray(state.generatedFiles)
		&& typeof state.sourceFingerprints === 'object'
		&& state.sourceFingerprints !== null;
}

function sameFingerprints(left: Record<string, string>, right: Record<string, string>): boolean {
	const leftKeys = Object.keys(left).sort();
	const rightKeys = Object.keys(right).sort();
	return leftKeys.length === rightKeys.length
		&& leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}
