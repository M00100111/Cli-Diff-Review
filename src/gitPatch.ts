import { createHash } from 'crypto';
import { GitReviewHunk, ReviewDecisionStatus, ReviewedHunk, ReviewSource } from './types';

export interface ParsedGitFilePatch {
	relativePath: string;
	oldPath?: string;
	newPath?: string;
	oldOid?: string;
	newOid?: string;
	oldExists: boolean;
	newExists: boolean;
	header: string;
	hunks: GitReviewHunk[];
	unsupportedReason?: string;
	byteLength: number;
}

interface PatchLineRecord {
	kind: 'context' | 'add' | 'delete';
	text: string;
}

const hunkHeaderPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseGitPatch(
	patch: string,
	projectId: string,
	layer: 'pending' | 'accepted',
): ParsedGitFilePatch[] {
	const blocks = splitFileBlocks(patch);
	const occurrences = new Map<string, number>();
	return blocks.map((block) => parseFileBlock(block, projectId, layer, occurrences));
}

export function combineGitHunkPatches(hunks: Array<Pick<GitReviewHunk, 'patchHeader' | 'rawHunk' | 'patch'>>): string {
	const groups = new Map<string, string[]>();
	for (const hunk of hunks) {
		if (!hunk.patchHeader || !hunk.rawHunk) {
			groups.set(hunk.patch, []);
			continue;
		}
		const body = groups.get(hunk.patchHeader) ?? [];
		body.push(hunk.rawHunk);
		groups.set(hunk.patchHeader, body);
	}
	return [...groups].map(([header, bodies]) => bodies.length > 0 ? `${header}${bodies.join('')}` : header).join('');
}

export function reviewedHunkFromGit(hunk: GitReviewHunk, source: ReviewSource, reviewedAt = Date.now()): ReviewedHunk {
	const status: ReviewDecisionStatus = source === 'accept' ? 'accepted' : 'rejected';
	return {
		...hunk,
		layer: status === 'accepted' ? 'accepted' : 'rejected',
		status,
		reviewSource: source,
		displayStart: source === 'accept' ? hunk.newStart : hunk.oldStart,
		displayLines: source === 'accept' ? hunk.newLines : hunk.oldLines,
		baselineStart: hunk.oldStart,
		currentStart: source === 'accept' ? hunk.newStart : hunk.oldStart,
		baselineContextBefore: hunk.oldContextBefore,
		baselineContextAfter: hunk.oldContextAfter,
		currentContextBefore: source === 'accept' ? hunk.newContextBefore : hunk.oldContextBefore,
		currentContextAfter: source === 'accept' ? hunk.newContextAfter : hunk.oldContextAfter,
		reviewedAt,
	};
}

export function gitPatchFingerprint(
	projectId: string,
	relativePath: string,
	oldText: string,
	newText: string,
	contextBefore: string[],
	contextAfter: string[],
): string {
	return createHash('sha256')
		.update([projectId, relativePath, oldText, newText, contextBefore.join(''), contextAfter.join('')].join('\0'))
		.digest('hex')
		.slice(0, 24);
}

export function decodeGitPath(value: string): string {
	const trimmed = value.trim();
	if (!trimmed.startsWith('"')) {
		return stripPrefix(trimmed);
	}
	const bytes: number[] = [];
	for (let index = 1; index < trimmed.length - 1; index += 1) {
		const char = trimmed[index];
		if (char !== '\\') {
			bytes.push(...Buffer.from(char, 'utf8'));
			continue;
		}
		const escaped = trimmed[++index];
		if (escaped === undefined) {
			break;
		}
		const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
		if (simple[escaped] !== undefined) {
			bytes.push(simple[escaped]);
			continue;
		}
		if (/[0-7]/.test(escaped)) {
			let octal = escaped;
			while (octal.length < 3 && /[0-7]/.test(trimmed[index + 1] ?? '')) {
				octal += trimmed[++index];
			}
			bytes.push(Number.parseInt(octal, 8));
			continue;
		}
		bytes.push(...Buffer.from(escaped, 'utf8'));
	}
	return stripPrefix(Buffer.from(bytes).toString('utf8'));
}

function splitFileBlocks(patch: string): string[] {
	const starts: number[] = [];
	const pattern = /^diff --git /gm;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(patch)) !== null) {
		starts.push(match.index);
	}
	return starts.map((start, index) => patch.slice(start, starts[index + 1] ?? patch.length));
}

function parseFileBlock(
	block: string,
	projectId: string,
	layer: 'pending' | 'accepted',
	occurrences: Map<string, number>,
): ParsedGitFilePatch {
	const lines = splitPreservingEndings(block);
	const firstHunk = lines.findIndex((line) => line.startsWith('@@ '));
	const header = lines.slice(0, firstHunk < 0 ? lines.length : firstHunk).join('');
	const oldHeader = lines.find((line) => line.startsWith('--- '));
	const newHeader = lines.find((line) => line.startsWith('+++ '));
	const oldPath = parseMarkerPath(oldHeader);
	const newPath = parseMarkerPath(newHeader);
	const fallbackPaths = parseDiffGitPaths(lines[0] ?? '');
	const indexLine = lines.find((line) => line.startsWith('index '));
	const indexMatch = indexLine?.match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)(?:\s|$)/i);
	const relativePath = newPath ?? oldPath ?? fallbackPaths.newPath ?? fallbackPaths.oldPath ?? 'unknown';
	const byteLength = Buffer.byteLength(block, 'utf8');
	let unsupportedReason: string | undefined;
	if (/^(?:GIT binary patch|Binary files .* differ)$/m.test(block)) {
		unsupportedReason = 'Unsupported Git change: binary file.';
	} else if (/^[+-]Subproject commit /m.test(block) || /(?:^|\s)160000(?:\s|$)/m.test(block)) {
		unsupportedReason = 'Unsupported Git change: submodule.';
	} else if (firstHunk < 0) {
		unsupportedReason = 'Unsupported Git change: file mode or metadata only.';
	}

	const hunks: GitReviewHunk[] = [];
	if (!unsupportedReason) {
		for (let index = firstHunk; index >= 0 && index < lines.length;) {
			const next = findNextHunk(lines, index + 1);
			const rawHunk = lines.slice(index, next).join('');
			const parsed = parseHunk(lines.slice(index, next), relativePath, projectId, layer, header, rawHunk, occurrences);
			if (parsed) {
				hunks.push(parsed);
			}
			index = next;
		}
	}
	return {
		relativePath,
		oldPath,
		newPath,
		oldOid: normalizeObjectId(indexMatch?.[1]),
		newOid: normalizeObjectId(indexMatch?.[2]),
		oldExists: Boolean(oldPath),
		newExists: Boolean(newPath),
		header,
		hunks,
		unsupportedReason,
		byteLength,
	};
}

function normalizeObjectId(value: string | undefined): string | undefined {
	return value && !/^0+$/.test(value) ? value : undefined;
}

function parseHunk(
	lines: string[],
	relativePath: string,
	projectId: string,
	layer: 'pending' | 'accepted',
	header: string,
	rawHunk: string,
	occurrences: Map<string, number>,
): GitReviewHunk | undefined {
	const headerMatch = lines[0]?.match(hunkHeaderPattern);
	if (!headerMatch) {
		return undefined;
	}
	const oldHeaderStart = Number(headerMatch[1]);
	const newHeaderStart = Number(headerMatch[3]);
	const records: PatchLineRecord[] = [];
	for (const line of lines.slice(1)) {
		if (line.startsWith('\\ No newline at end of file')) {
			const previous = records[records.length - 1];
			if (previous) {
				previous.text = previous.text.replace(/\r?\n$/, '');
			}
			continue;
		}
		const prefix = line[0];
		if (prefix === ' ' || prefix === '+' || prefix === '-') {
			records.push({ kind: prefix === ' ' ? 'context' : prefix === '+' ? 'add' : 'delete', text: line.slice(1) });
		}
	}
	const firstChange = records.findIndex((record) => record.kind !== 'context');
	let lastChange = -1;
	for (let index = records.length - 1; index >= 0; index -= 1) {
		if (records[index].kind !== 'context') {
			lastChange = index;
			break;
		}
	}
	if (firstChange < 0 || lastChange < 0) {
		return undefined;
	}
	const before = records.slice(0, firstChange).filter((record) => record.kind === 'context').map((record) => record.text);
	const after = records.slice(lastChange + 1).filter((record) => record.kind === 'context').map((record) => record.text);
	const core = records.slice(firstChange, lastChange + 1);
	const oldCore = core.filter((record) => record.kind !== 'add');
	const newCore = core.filter((record) => record.kind !== 'delete');
	const oldText = oldCore.map((record) => record.text).join('');
	const newText = newCore.map((record) => record.text).join('');
	const fingerprint = gitPatchFingerprint(projectId, relativePath, oldText, newText, before, after);
	const occurrence = occurrences.get(fingerprint) ?? 0;
	occurrences.set(fingerprint, occurrence + 1);
	const oldStart = Math.max(0, (oldHeaderStart === 0 ? 0 : oldHeaderStart - 1) + before.length);
	const newStart = Math.max(0, (newHeaderStart === 0 ? 0 : newHeaderStart - 1) + before.length);
	return {
		id: `${fingerprint}-${occurrence}`,
		fileUri: '',
		oldStart,
		oldLines: oldCore.length,
		newStart,
		newLines: newCore.length,
		oldText,
		newText,
		kind: oldCore.length === 0 ? 'add' : newCore.length === 0 ? 'delete' : 'modify',
		oldContextBefore: before,
		oldContextAfter: after,
		newContextBefore: before,
		newContextAfter: after,
		zoneAfterLineNumber: newStart,
		layer,
		patch: `${header}${rawHunk}`,
		patchHeader: header,
		rawHunk,
		fingerprint,
		projectId,
		occurrence,
		operable: true,
	};
}

function findNextHunk(lines: string[], start: number): number {
	for (let index = start; index < lines.length; index += 1) {
		if (lines[index].startsWith('@@ ')) {
			return index;
		}
	}
	return lines.length;
}

function splitPreservingEndings(value: string): string[] {
	return value.match(/.*(?:\r\n|\n|$)/g)?.filter((line) => line.length > 0) ?? [];
}

function parseMarkerPath(line: string | undefined): string | undefined {
	if (!line) {
		return undefined;
	}
	const raw = line.slice(4).replace(/\r?\n$/, '');
	if (raw === '/dev/null') {
		return undefined;
	}
	return decodeGitPath(raw);
}

function parseDiffGitPaths(line: string): { oldPath?: string; newPath?: string } {
	const raw = line.replace(/^diff --git /, '').replace(/\r?\n$/, '');
	if (!raw.startsWith('"')) {
		let separator = raw.indexOf(' b/');
		while (separator >= 0) {
			const oldPath = decodeGitPath(raw.slice(0, separator));
			const newPath = decodeGitPath(raw.slice(separator + 1));
			if (oldPath === newPath) {
				return { oldPath, newPath };
			}
			separator = raw.indexOf(' b/', separator + 1);
		}
	}
	const values = raw.match(/"(?:\\.|[^"])*"|\S+/g) ?? [];
	return { oldPath: values[0] ? decodeGitPath(values[0]) : undefined, newPath: values[1] ? decodeGitPath(values[1]) : undefined };
}

function stripPrefix(value: string): string {
	return value.startsWith('a/') || value.startsWith('b/') ? value.slice(2) : value;
}
