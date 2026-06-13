import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { LlmClient } from '../llm/client';
import { LlmRuntimeConfig } from '../llm/config';
import { isJsonObject } from '../llm/json';
import { ReviewFileState, ReviewHunk, ReviewSession } from '../types';
import { createReadOnlyAgentTools } from './tools';
import { AgentRunner, AgentTraceDetail, AgentTraceEvent } from './runtime';

export type AiReviewSeverity = 'critical' | 'warning' | 'suggestion' | 'info';

export interface AiReviewFinding {
	id: string;
	uri: string;
	relativePath: string;
	hunkId: string;
	line: number;
	severity: AiReviewSeverity;
	title: string;
	explanation: string;
	recommendation: string;
	evidence: string[];
	generationOrder: number;
}

export interface StoredAiReview {
	signature: string;
	findings: AiReviewFinding[];
	generatedAt: string;
}

export interface CodeReviewTraceContext {
	fileUri: string;
	relativePath: string;
	fileIndex: number;
	fileCount: number;
}

export interface AiReviewFindingDrop {
	index: number;
	reason: string;
	hunkId?: string;
	candidate: unknown;
}

export interface AiReviewFindingDiagnostics {
	rawCount: number;
	acceptedCount: number;
	dropped: AiReviewFindingDrop[];
}

export interface AiReviewFindingValidation {
	findings: AiReviewFinding[];
	diagnostics: AiReviewFindingDiagnostics;
}

export interface CodeReviewAgentOptions {
	session: ReviewSession;
	root: vscode.WorkspaceFolder;
	config: LlmRuntimeConfig;
	client: LlmClient;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
	onTrace?: (event: AgentTraceEvent, context: CodeReviewTraceContext) => void;
}

const severities = new Set<AiReviewSeverity>(['critical', 'warning', 'suggestion', 'info']);
const severityOrder: Record<AiReviewSeverity, number> = { critical: 0, warning: 1, suggestion: 2, info: 3 };

export class CodeReviewAgentService {
	private readonly runner = new AgentRunner();

	public async review(options: CodeReviewAgentOptions): Promise<StoredAiReview> {
		const files = sourcePendingFiles(options.session);
		const signature = reviewChangeSignature(options.session);
		const findings: AiReviewFinding[] = [];
		for (const [index, file] of files.entries()) {
			const context: CodeReviewTraceContext = {
				fileUri: file.uri.toString(),
				relativePath: file.relativePath,
				fileIndex: index + 1,
				fileCount: files.length,
			};
			options.onProgress?.(`Reviewing ${file.relativePath} (${index + 1}/${files.length})`);
			const result = await this.runner.run({
				config: options.config,
				client: options.client,
				systemPrompt: reviewSystemPrompt(),
				userPrompt: reviewUserPrompt(file),
				tools: createReadOnlyAgentTools({ root: options.root }),
				signal: options.signal,
				onProgress: (progress) => options.onProgress?.(`${file.relativePath}: ${progress.message}`),
				onTrace: (event) => options.onTrace?.(event, context),
				maxRounds: 8,
				maxToolCalls: 24,
			});
			let validation: AiReviewFindingValidation;
			try {
				validation = validateReviewFindingsWithDiagnostics(result.result, file, findings.length);
			} catch (error) {
				options.onTrace?.({
					kind: 'parse_error',
					title: 'Review findings parse error',
					summary: error instanceof Error ? error.message : String(error),
					round: result.rounds,
					status: 'error',
					details: [
						textTraceDetail('Error', error instanceof Error ? error.message : String(error)),
						jsonTraceDetail('Final result', result.result),
					],
				}, context);
				throw error;
			}
			options.onTrace?.({
				kind: 'parse_success',
				title: 'Review findings parsed',
				summary: findingDiagnosticsSummary(validation.diagnostics),
				round: result.rounds,
				status: 'success',
				details: [
					jsonTraceDetail('Finding diagnostics', validation.diagnostics),
					jsonTraceDetail('Accepted findings', validation.findings),
				],
			}, context);
			findings.push(...validation.findings);
		}
		if (reviewChangeSignature(options.session) !== signature) {
			throw new Error('Pending source chunks changed while the AI review was running. Generate the review again.');
		}
		return {
			signature,
			findings,
			generatedAt: new Date().toISOString(),
		};
	}
}

export class AiReviewStore {
	public constructor(private readonly workspaceState: vscode.Memento) {}

	public load(session: ReviewSession | undefined): StoredAiReview | undefined {
		if (!session) {
			return undefined;
		}
		const stored = this.workspaceState.get<StoredAiReview>(storeKey(session.rootUri));
		return stored?.signature === reviewChangeSignature(session) ? stored : undefined;
	}

	public async save(session: ReviewSession, review: StoredAiReview): Promise<void> {
		await this.workspaceState.update(storeKey(session.rootUri), review);
	}

	public async clear(rootUri: vscode.Uri): Promise<void> {
		await this.workspaceState.update(storeKey(rootUri), undefined);
	}
}

export function sourcePendingFiles(session: ReviewSession | undefined): ReviewFileState[] {
	return session
		? [...session.files.values()]
			.filter((file) => file.hunks.length > 0 && !file.relativePath.replace(/\\/g, '/').startsWith('.wiki/'))
			.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
		: [];
}

export function reviewChangeSignature(session: ReviewSession): string {
	const payload = sourcePendingFiles(session).map((file) => ({
		path: file.relativePath,
		revision: file.revision,
		hunks: file.hunks.map((hunk) => ({
			id: hunk.id,
			oldStart: hunk.oldStart,
			newStart: hunk.newStart,
			oldText: hunk.oldText,
			newText: hunk.newText,
		})),
	}));
	return createHash('sha256').update(JSON.stringify({ sessionId: session.id, files: payload })).digest('hex');
}

export function validateReviewFindings(result: Record<string, unknown>, file: ReviewFileState, startOrder = 0): AiReviewFinding[] {
	return validateReviewFindingsWithDiagnostics(result, file, startOrder).findings;
}

export function validateReviewFindingsWithDiagnostics(result: Record<string, unknown>, file: ReviewFileState, startOrder = 0): AiReviewFindingValidation {
	if (!Array.isArray(result.findings)) {
		throw new Error('Code Review Agent final result must include findings.');
	}
	const hunks = new Map(file.hunks.map((hunk) => [hunk.id, hunk]));
	const findings: AiReviewFinding[] = [];
	const dropped: AiReviewFindingDrop[] = [];
	for (const [index, candidate] of result.findings.entries()) {
		if (!isJsonObject(candidate)) {
			dropped.push({ index, reason: 'Finding is not a JSON object.', candidate });
			continue;
		}
		if (typeof candidate.hunkId !== 'string') {
			dropped.push({ index, reason: 'Finding is missing a string hunkId.', candidate });
			continue;
		}
		const hunk = hunks.get(candidate.hunkId);
		if (!hunk) {
			dropped.push({ index, reason: 'Finding hunkId does not match a current pending chunk.', hunkId: candidate.hunkId, candidate });
			continue;
		}
		if (!isSeverity(candidate.severity)) {
			dropped.push({ index, reason: 'Finding severity is invalid.', hunkId: candidate.hunkId, candidate });
			continue;
		}
		if (!hasFindingStrings(candidate)) {
			dropped.push({ index, reason: 'Finding must include title, explanation, and recommendation strings.', hunkId: candidate.hunkId, candidate });
			continue;
		}
		const evidence = Array.isArray(candidate.evidence)
			? candidate.evidence.filter((item): item is string => typeof item === 'string')
			: [];
		const generationOrder = startOrder + findings.length;
		findings.push({
			id: `${file.uri.toString()}#${hunk.id}#${generationOrder}`,
			uri: file.uri.toString(),
			relativePath: file.relativePath,
			hunkId: hunk.id,
			line: hunk.newStart,
			severity: candidate.severity,
			title: candidate.title,
			explanation: candidate.explanation,
			recommendation: candidate.recommendation,
			evidence,
			generationOrder,
		});
	}
	return {
		findings,
		diagnostics: {
			rawCount: result.findings.length,
			acceptedCount: findings.length,
			dropped,
		},
	};
}

export function sortFindings(
	findings: AiReviewFinding[],
	files: Iterable<ReviewFileState>,
	order: 'chunk' | 'severity',
): AiReviewFinding[] {
	const hunkPositions = new Map<string, number>();
	for (const file of files) {
		for (const hunk of file.hunks) {
			hunkPositions.set(`${file.uri.toString()}#${hunk.id}`, hunk.newStart);
		}
	}
	return [...findings].sort((left, right) => (
		order === 'severity' ? severityOrder[left.severity] - severityOrder[right.severity] : 0
	) || (hunkPositions.get(`${left.uri}#${left.hunkId}`) ?? left.line) - (hunkPositions.get(`${right.uri}#${right.hunkId}`) ?? right.line)
		|| left.generationOrder - right.generationOrder);
}

function reviewSystemPrompt(): string {
	return [
		'You are a source-grounded Code Review Agent.',
		'Review only the supplied pending hunks. Source and Wiki files are read-only.',
		'Use tools when needed to inspect callers, tests, configuration, and optional Wiki context.',
		'Report concrete correctness, reliability, security, or maintainability risks; avoid generic praise.',
		'Every finding must bind to one supplied hunkId.',
		'Finish with {"type":"final","result":{"findings":[{"hunkId":"...","severity":"warning","title":"...","explanation":"...","recommendation":"...","evidence":["path:line"]}]}}.',
	].join('\n');
}

function reviewUserPrompt(file: ReviewFileState): string {
	return [
		`Review all pending chunks in ${file.relativePath}.`,
		'Pending chunks:',
		JSON.stringify(file.hunks.map(hunkForPrompt)),
		'Return an empty findings array when no actionable issue is supported by evidence.',
	].join('\n');
}

function hunkForPrompt(hunk: ReviewHunk): Record<string, unknown> {
	return {
		hunkId: hunk.id,
		kind: hunk.kind,
		oldStart: hunk.oldStart,
		newStart: hunk.newStart,
		oldText: hunk.oldText,
		newText: hunk.newText,
		contextBefore: hunk.newContextBefore,
		contextAfter: hunk.newContextAfter,
	};
}

function isSeverity(value: unknown): value is AiReviewSeverity {
	return typeof value === 'string' && severities.has(value as AiReviewSeverity);
}

function hasFindingStrings(value: Record<string, unknown>): value is Record<string, unknown> & {
	title: string;
	explanation: string;
	recommendation: string;
} {
	return typeof value.title === 'string'
		&& typeof value.explanation === 'string'
		&& typeof value.recommendation === 'string';
}

function findingDiagnosticsSummary(diagnostics: AiReviewFindingDiagnostics): string {
	if (diagnostics.rawCount === 0) {
		return 'Model returned 0 findings.';
	}
	if (diagnostics.dropped.length === 0) {
		return `Accepted ${diagnostics.acceptedCount} of ${diagnostics.rawCount} findings.`;
	}
	return `Accepted ${diagnostics.acceptedCount} of ${diagnostics.rawCount} findings; dropped ${diagnostics.dropped.length}.`;
}

function textTraceDetail(label: string, content: string): AgentTraceDetail {
	return { label, format: 'text', content };
}

function jsonTraceDetail(label: string, value: unknown): AgentTraceDetail {
	try {
		return { label, format: 'json', content: JSON.stringify(value, undefined, 2) };
	} catch (error) {
		return textTraceDetail(label, error instanceof Error ? error.message : String(error));
	}
}

function storeKey(rootUri: vscode.Uri): string {
	return `cliDiff.aiReview.${rootUri.toString()}`;
}
