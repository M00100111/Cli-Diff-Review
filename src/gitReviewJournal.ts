import { createHash, randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { reviewedHunkFromGit } from './gitPatch';
import { GitReviewHunk, ReviewedHunk, ReviewProject } from './types';

export type RejectJournalState = 'prepared' | 'applied' | 'undoing' | 'stale';

export interface RejectJournalRecord {
	id: string;
	projectId: string;
	headOid: string;
	relativePath: string;
	fileUri: string;
	patch: string;
	hunk: GitReviewHunk;
	state: RejectJournalState;
	beforeHash: string;
	afterHash: string;
	createdAt: number;
}

interface RejectJournalFile {
	version: 1;
	projectId: string;
	headOid: string;
	records: RejectJournalRecord[];
}

export interface LoadedRejectJournal {
	records: RejectJournalRecord[];
	headChanged: boolean;
}

export class GitReviewJournalStore {
	private readonly directory: vscode.Uri;
	private readonly cache = new Map<string, RejectJournalFile>();

	public constructor(context: vscode.ExtensionContext) {
		this.directory = vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'git-review');
	}

	public async load(project: ReviewProject, headOid: string): Promise<LoadedRejectJournal> {
		const cached = this.cache.get(project.id);
		if (cached?.headOid === headOid) {
			return { records: [...cached.records], headChanged: false };
		}
		const journal = await this.read(project);
		if (journal && journal.headOid !== headOid) {
			await this.delete(project);
			return { records: [], headChanged: true };
		}
		if (!journal) {
			return { records: [], headChanged: false };
		}
		let changed = false;
		const records: RejectJournalRecord[] = [];
		for (const record of journal.records) {
			const currentHash = await fileStateHash(vscode.Uri.parse(record.fileUri));
			if (record.state === 'prepared') {
				if (currentHash === record.beforeHash) {
					changed = true;
					continue;
				}
				if (currentHash === record.afterHash) {
					record.state = 'applied';
					changed = true;
				} else {
					record.state = 'stale';
					changed = true;
				}
			} else if (record.state === 'undoing') {
				if (currentHash === record.beforeHash) {
					changed = true;
					continue;
				}
				if (currentHash === record.afterHash) {
					record.state = 'applied';
					changed = true;
				} else {
					record.state = 'stale';
					changed = true;
				}
			}
			records.push(record);
		}
		if (changed) {
			await this.write(project, headOid, records);
		} else {
			this.cache.set(project.id, { ...journal, records: [...records] });
		}
		return { records, headChanged: false };
	}

	public async prepare(
		project: ReviewProject,
		headOid: string,
		relativePath: string,
		fileUri: vscode.Uri,
		hunk: GitReviewHunk,
		beforeHash: string,
		afterHash: string,
	): Promise<RejectJournalRecord> {
		const loaded = await this.load(project, headOid);
		const record: RejectJournalRecord = {
			id: randomUUID(),
			projectId: project.id,
			headOid,
			relativePath,
			fileUri: fileUri.toString(),
			patch: hunk.patch,
			hunk,
			state: 'prepared',
			beforeHash,
			afterHash,
			createdAt: Date.now(),
		};
		await this.write(project, headOid, [...loaded.records, record]);
		return record;
	}

	public async setState(project: ReviewProject, headOid: string, id: string, state: RejectJournalState): Promise<void> {
		const loaded = await this.load(project, headOid);
		await this.write(project, headOid, loaded.records.map((record) => record.id === id ? { ...record, state } : record));
	}

	public async remove(project: ReviewProject, headOid: string, id: string): Promise<void> {
		const loaded = await this.load(project, headOid);
		await this.write(project, headOid, loaded.records.filter((record) => record.id !== id));
	}

	public toReviewedHunk(record: RejectJournalRecord): ReviewedHunk {
		return {
			...reviewedHunkFromGit({ ...record.hunk, layer: 'rejected', patch: record.patch }, 'reject', record.createdAt),
			id: record.id,
			operable: record.state === 'applied',
		};
	}

	private async read(project: ReviewProject): Promise<RejectJournalFile | undefined> {
		try {
			const data = await vscode.workspace.fs.readFile(this.fileUri(project));
			const value = JSON.parse(Buffer.from(data).toString('utf8')) as RejectJournalFile;
			return value.version === 1 ? value : undefined;
		} catch {
			return undefined;
		}
	}

	private async write(project: ReviewProject, headOid: string, records: RejectJournalRecord[]): Promise<void> {
		await vscode.workspace.fs.createDirectory(this.directory);
		const target = this.fileUri(project);
		const temporary = vscode.Uri.joinPath(this.directory, `${target.path.split('/').pop()}.${randomUUID()}.tmp`);
		const payload: RejectJournalFile = { version: 1, projectId: project.id, headOid, records };
		await vscode.workspace.fs.writeFile(temporary, Buffer.from(JSON.stringify(payload), 'utf8'));
		try {
			await vscode.workspace.fs.rename(temporary, target, { overwrite: true });
			this.cache.set(project.id, { ...payload, records: [...records] });
		} catch (error) {
			try {
				await vscode.workspace.fs.delete(temporary);
			} catch {
				// Best effort cleanup.
			}
			throw error;
		}
	}

	private async delete(project: ReviewProject): Promise<void> {
		this.cache.delete(project.id);
		try {
			await vscode.workspace.fs.delete(this.fileUri(project));
		} catch {
			// Missing journals are expected.
		}
	}

	private fileUri(project: ReviewProject): vscode.Uri {
		const name = createHash('sha256').update(project.id).digest('hex').slice(0, 32);
		return vscode.Uri.joinPath(this.directory, `${name}.json`);
	}
}

export async function fileStateHash(uri: vscode.Uri): Promise<string> {
	try {
		const data = await vscode.workspace.fs.readFile(uri);
		return createHash('sha256').update('exists\0').update(data).digest('hex');
	} catch {
		return createHash('sha256').update('missing\0').digest('hex');
	}
}

export function contentStateHash(text: string, exists: boolean): string {
	return createHash('sha256').update(exists ? 'exists\0' : 'missing\0').update(exists ? text : '').digest('hex');
}

export function expectedRejectedFileHash(fileText: string, hunk: GitReviewHunk, baselineExists: boolean): string {
	const lines = splitLines(fileText);
	lines.splice(hunk.newStart, hunk.newLines, ...splitLines(hunk.oldText));
	return contentStateHash(lines.join(''), baselineExists);
}

function splitLines(text: string): string[] {
	return text.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g) ?? [];
}
