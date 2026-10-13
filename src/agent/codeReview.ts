import { ReviewCheckpointStore } from './review/checkpoints';
import { ReviewHost, ReviewHostState } from './review/host';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { LlmClient } from '../llm/client';
import { LlmRuntimeConfig } from '../llm/config';
import { isJsonObject } from '../llm/json';
import { ReviewedHunk, ReviewFileState, ReviewHunk, ReviewSession } from '../types';
import { isWikiPath } from '../wiki/paths';
import type { WikiFreshnessAssessment } from '../wiki/state';
import { AgentTraceEvent } from './runtime';

export type AiReviewSeverity = 'error' | 'warning' | 'suggestion' | 'info';

export type AiReviewLanguage = 'zh-CN' | 'en';
export type AiReviewTraceStage = 'main' | 'explore' | 'review' | 'plan';

export type KnowledgeClaimStatus = 'confirmed' | 'conflicted' | 'unverified';

export interface AiReviewKnowledgeClaim {
	page: string;
	claim: string;
	status: KnowledgeClaimStatus;
	evidencePaths: string[];
	confidence?: number;
}

export interface AiReviewFinding {
	evidenceRefs?: Array<{ evidenceRef: string; side: 'old' | 'new'; startLine: number; endLine: number }>;
	chunkRef?: string;
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
	source?: 'file' | 'integration';
	relatedHunkIds?: string[];
	relatedPaths?: string[];
}

export interface AiReviewChunkSuggestion {
	chunkRef?: string;
	expectedFileHash?: string;
	id: string;
	uri: string;
	relativePath: string;
	hunkId: string;
	line: number;
	replacementText: string;
	rationale: string;
	generationOrder: number;
}

export interface AiReviewFileResult {
	uri: string;
	relativePath: string;
	status: 'success' | 'error';
	rawFindingCount: number;
	acceptedFindingCount: number;
	droppedFindingCount: number;
	rawSuggestionCount: number;
	acceptedSuggestionCount: number;
	droppedSuggestionCount: number;
	summary: string;
	error?: string;
}

export interface StoredAiReview {
	checkpointRef?: string;
	checkpointHydrated?: boolean;
	agentState?: ReviewHostState;
	summary?: string;
	unresolved?: Array<{ chunkRef: string | null; reason: string }>;
	signature: string;
	findings: AiReviewFinding[];
	suggestions: AiReviewChunkSuggestion[];
	fileResults: AiReviewFileResult[];
	generatedAt: string;
	status: 'partial' | 'complete';
	completedFiles: string[];
	knowledgeFreshness?: WikiFreshnessAssessment;
	knowledgeClaims?: AiReviewKnowledgeClaim[];
	failedFile?: string;
	error?: string;
}

export interface CodeReviewTraceContext {
	agentId?: string;
	parentAgentId?: string;
	role?: string;
	segment?: number;
	stage: AiReviewTraceStage;
	fileUri?: string;
	relativePath?: string;
	fileIndex?: number;
	fileCount?: number;
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

export interface AiReviewSuggestionDrop {
	index: number;
	reason: string;
	hunkId?: string;
	candidate: unknown;
}

export interface AiReviewSuggestionDiagnostics {
	rawCount: number;
	acceptedCount: number;
	dropped: AiReviewSuggestionDrop[];
}

export interface AiReviewResultValidation {
	findings: AiReviewFinding[];
	findingDiagnostics: AiReviewFindingDiagnostics;
	suggestions: AiReviewChunkSuggestion[];
	suggestionDiagnostics: AiReviewSuggestionDiagnostics;
	fileResult: AiReviewFileResult;
}

export interface CodeReviewAgentOptions {
	refreshSession?: () => Promise<ReviewSession>;
	totalBudgetTokens?: number;
	childConcurrency?: number;
	autoCompress?: boolean;
	changeNotificationLimit?: number;
	session: ReviewSession;
	root: vscode.WorkspaceFolder;
	config: LlmRuntimeConfig;
	client: LlmClient;
	language: AiReviewLanguage;
	existingReview?: StoredAiReview;
	includeWikiTools?: boolean;
	knowledgeFreshness?: WikiFreshnessAssessment;
	maxRounds?: number | 'unlimited';
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
	onTrace?: (event: AgentTraceEvent, context: CodeReviewTraceContext) => void;
	onFileComplete?: (review: StoredAiReview) => void | Promise<void>;
	onCheckpoint?: (review: StoredAiReview) => void | Promise<void>;
	/**
	 * Source is read live through the refreshSession callback.
	 */
}

const severities = new Set<AiReviewSeverity>(['error', 'warning', 'suggestion', 'info']);

export class AiReviewPartialError extends Error {
	public constructor(message: string, public readonly review: StoredAiReview, public readonly cause?: unknown) {
		super(message);
		this.name = 'AiReviewPartialError';
	}
}

export class CodeReviewAgentService {
 public async review(options: CodeReviewAgentOptions): Promise<StoredAiReview> {
  const review: StoredAiReview = options.existingReview?.agentState?.version === 2
   ? JSON.parse(JSON.stringify(options.existingReview)) as StoredAiReview
   : { signature: reviewChangeSignature(options.session), findings: [], suggestions: [], fileResults: [], generatedAt: new Date().toISOString(), status: 'partial', completedFiles: [] };
  try { return await new ReviewHost(options, review).run(); }
  catch (error) {
   review.status = 'partial'; review.error = error instanceof Error ? error.message : String(error);
   await options.onCheckpoint?.(review);
   throw new AiReviewPartialError(review.error, review, error);
  }
 }
}

export class AiReviewStore {
	private readonly saveQueues = new Map<string, Promise<void>>();

	private readonly checkpoints?: ReviewCheckpointStore;
 public constructor(private readonly workspaceState: vscode.Memento, storage?: vscode.Uri) {
  this.checkpoints = storage ? new ReviewCheckpointStore(vscode.Uri.joinPath(storage, 'review-checkpoints-v2')) : undefined;
 }
 public async hydrate(review: StoredAiReview): Promise<StoredAiReview> {
  if (!review.checkpointRef || !this.checkpoints) { return review; }
  return { ...review, agentState: await this.checkpoints.load(review.checkpointRef), checkpointHydrated: true };
 }

	public load(session: ReviewSession | undefined): StoredAiReview | undefined {
		if (!session) {
			return undefined;
		}
		const stored = this.workspaceState.get<StoredAiReview>(storeKey(session.rootUri));
		if (!stored) {
			return undefined;
		}
        if (stored.agentState?.version !== 2) { return undefined; }
        const copy = JSON.parse(JSON.stringify(stored)) as StoredAiReview;
        if (copy.signature !== reviewChangeSignature(session)) {
         copy.status = 'partial';
         copy.error = 'Code changed since the last review. Continue to inspect current changes.';
        }
        return copy;
	}

	public async save(session: ReviewSession, review: StoredAiReview): Promise<void> {
		const key = storeKey(session.rootUri);
		const previous = this.saveQueues.get(key) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(async () => {
			const stored = JSON.parse(JSON.stringify(review)) as StoredAiReview;
   if (this.checkpoints && stored.agentState && stored.checkpointHydrated !== false) {
    stored.checkpointRef = await this.checkpoints.save(stored.agentState);
    stored.checkpointHydrated = false;
    stored.agentState = { ...stored.agentState, live: { ...stored.agentState.live, evidence: {} }, events: [], results: {}, mutations: {}, tasks: Object.fromEntries(Object.entries(stored.agentState.tasks).map(([id, task]) => [id, { ...task, checkpoint: undefined }])) };
   }
   await this.workspaceState.update(key, stored);
		});
		this.saveQueues.set(key, next);
		try {
			await next;
		} finally {
			if (this.saveQueues.get(key) === next) {
				this.saveQueues.delete(key);
			}
		}
	}

	public async clear(rootUri: vscode.Uri): Promise<void> {
		await this.workspaceState.update(storeKey(rootUri), undefined);
	}
}

function reviewHunkStableIdentity(hunk: ReviewHunk): string { return hunk.reviewItemId ?? hunk.sourceHunkId ?? hunk.id; }
function originalReviewedHunkId(hunkId: string): string { return hunkId.replace(/^(accept|reject)-/, ''); }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }

export function sourcePendingFiles(session: ReviewSession | undefined): ReviewFileState[] {
	return session
		? [...session.files.values()]
			.filter((file) => file.hunks.length > 0 && !isWikiPath(file.relativePath))
			.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
		: [];
}

export function reviewChangeSignature(session: ReviewSession): string {
	const payload = sourceReviewFiles(session).map((file) => ({
		path: file.relativePath,
		indexBlobOid: file.gitSnapshot?.indexBlobOid,
		hunks: [...file.hunks, ...file.acceptedHunks, ...file.rejectedHunks]
			.map(stableReviewHunkSignature)
			.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
		resolvedSuggestions: file.appliedAiSuggestions
			.filter((suggestion) => suggestion.resolvedToIndex)
			.map((suggestion) => ({
				suggestionId: suggestion.suggestionId,
				sourceHunkId: suggestion.sourceHunkId,
				original: stableReviewHunkSignature(suggestion.originalHunk),
			}))
			.sort((left, right) => left.suggestionId.localeCompare(right.suggestionId)),
	}));
	return createHash('sha256').update(JSON.stringify({
		rootUri: session.rootUri.toString(),
		projects: (session.projects ?? []).map((project) => ({
			id: project.id,
			rootUri: project.rootUri.toString(),
			headOid: project.headOid,
		})).sort((left, right) => left.id.localeCompare(right.id)),
		files: payload,
	})).digest('hex');
}

function sourceReviewFiles(session: ReviewSession): ReviewFileState[] {
	return [...session.files.values()]
		.filter((file) => (
			file.hunks.length > 0
			|| file.acceptedHunks.length > 0
			|| file.rejectedHunks.length > 0
			|| file.appliedAiSuggestions.some((suggestion) => suggestion.resolvedToIndex)
		) && !isWikiPath(file.relativePath))
		.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function stableReviewHunkSignature(hunk: ReviewHunk): Record<string, unknown> {
	return {
		kind: hunk.kind,
		oldText: hunk.oldText,
		newText: hunk.newText,
	};
}

export function validateReviewFindings(result: Record<string, unknown>, file: ReviewFileState, startOrder = 0): AiReviewFinding[] {
	return validateReviewFindingsWithDiagnostics(result, file, startOrder).findings;
}

export function validateAiReviewResult(
	result: Record<string, unknown>,
	file: ReviewFileState,
	findingStartOrder = 0,
	suggestionStartOrder = 0,
): AiReviewResultValidation {
	const findingValidation = validateReviewFindingsWithDiagnostics(result, file, findingStartOrder);
	const suggestionValidation = validateReviewSuggestionsWithDiagnostics(result, file, suggestionStartOrder);
	return {
		findings: findingValidation.findings,
		findingDiagnostics: findingValidation.diagnostics,
		suggestions: suggestionValidation.suggestions,
		suggestionDiagnostics: suggestionValidation.diagnostics,
		fileResult: successFileResult(file, findingValidation.diagnostics, suggestionValidation.diagnostics),
	};
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
		const hunkId = reviewHunkStableIdentity(hunk);
		findings.push({
			id: `${file.uri.toString()}#${hunkId}#${generationOrder}`,
			uri: file.uri.toString(),
			relativePath: file.relativePath,
			hunkId,
			line: hunk.newStart,
			severity: candidate.severity,
			title: candidate.title,
			explanation: candidate.explanation,
			recommendation: candidate.recommendation,
			evidence,
			generationOrder,
			source: 'file',
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

export function validateReviewSuggestionsWithDiagnostics(result: Record<string, unknown>, file: ReviewFileState, startOrder = 0): {
	suggestions: AiReviewChunkSuggestion[];
	diagnostics: AiReviewSuggestionDiagnostics;
} {
	if (result.suggestions === undefined) {
		return {
			suggestions: [],
			diagnostics: { rawCount: 0, acceptedCount: 0, dropped: [] },
		};
	}
	if (!Array.isArray(result.suggestions)) {
		throw new Error('Code Review Agent suggestions must be an array when provided.');
	}
	const hunks = new Map(file.hunks.map((hunk) => [hunk.id, hunk]));
	const seenHunks = new Set<string>();
	const suggestions: AiReviewChunkSuggestion[] = [];
	const dropped: AiReviewSuggestionDrop[] = [];
	for (const [index, candidate] of result.suggestions.entries()) {
		if (!isJsonObject(candidate)) {
			dropped.push({ index, reason: 'Suggestion is not a JSON object.', candidate });
			continue;
		}
		if (typeof candidate.hunkId !== 'string') {
			dropped.push({ index, reason: 'Suggestion is missing a string hunkId.', candidate });
			continue;
		}
		const hunk = hunks.get(candidate.hunkId);
		if (!hunk) {
			dropped.push({ index, reason: 'Suggestion hunkId does not match a current pending chunk.', hunkId: candidate.hunkId, candidate });
			continue;
		}
		if (hunk.kind === 'delete') {
			dropped.push({ index, reason: 'Delete chunks do not support AI code suggestions.', hunkId: candidate.hunkId, candidate });
			continue;
		}
		if (seenHunks.has(hunk.id)) {
			dropped.push({ index, reason: 'Only one suggestion is allowed per chunk.', hunkId: candidate.hunkId, candidate });
			continue;
		}
		if (typeof candidate.replacementText !== 'string') {
			dropped.push({ index, reason: 'Suggestion must include replacementText as a string.', hunkId: candidate.hunkId, candidate });
			continue;
		}
		seenHunks.add(hunk.id);
		const generationOrder = startOrder + suggestions.length;
		const hunkId = reviewHunkStableIdentity(hunk);
		suggestions.push({
			id: `${file.uri.toString()}#${hunkId}#suggestion#${generationOrder}`,
			uri: file.uri.toString(),
			relativePath: file.relativePath,
			hunkId,
			line: hunk.newStart,
			replacementText: normalizeAiSuggestionReplacementText(candidate.replacementText, hunk),
			rationale: typeof candidate.rationale === 'string' ? candidate.rationale : '',
			generationOrder,
		});
	}
	return {
		suggestions,
		diagnostics: {
			rawCount: result.suggestions.length,
			acceptedCount: suggestions.length,
			dropped,
		},
	};
}

export function normalizeAiSuggestionReplacementText(replacementText: string, hunk: Pick<ReviewHunk, 'newText'>): string {
	if (replacementText.length === 0 || replacementText.endsWith('\n') || replacementText.endsWith('\r')) {
		return replacementText;
	}
	const lineTerminator = hunk.newText.match(/(\r\n|\n|\r)$/)?.[1];
	return lineTerminator ? `${replacementText}${lineTerminator}` : replacementText;
}

export function sortFindings(
	findings: AiReviewFinding[],
	files: Iterable<ReviewFileState>,
): AiReviewFinding[] {
	const hunkPositions = new Map<string, number>();
	for (const file of files) {
		for (const hunk of file.hunks) {
			hunkPositions.set(`${file.uri.toString()}#${hunk.id}`, hunk.newStart);
		}
	}
	return [...findings].sort((left, right) => (
		(hunkPositions.get(`${left.uri}#${left.hunkId}`) ?? left.line) - (hunkPositions.get(`${right.uri}#${right.hunkId}`) ?? right.line)
		|| left.generationOrder - right.generationOrder));
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

function suggestionDiagnosticsSummary(diagnostics: AiReviewSuggestionDiagnostics): string {
	if (diagnostics.rawCount === 0) {
		return 'Model returned 0 suggestions.';
	}
	if (diagnostics.dropped.length === 0) {
		return `Accepted ${diagnostics.acceptedCount} of ${diagnostics.rawCount} suggestions.`;
	}
	return `Accepted ${diagnostics.acceptedCount} of ${diagnostics.rawCount} suggestions; dropped ${diagnostics.dropped.length}.`;
}

function successFileResult(
	file: ReviewFileState,
	findings: AiReviewFindingDiagnostics,
	suggestions: AiReviewSuggestionDiagnostics,
): AiReviewFileResult {
	const findingSummary = findingDiagnosticsSummary(findings);
	const suggestionSummary = suggestionDiagnosticsSummary(suggestions);
	return {
		uri: file.uri.toString(),
		relativePath: file.relativePath,
		status: 'success',
		rawFindingCount: findings.rawCount,
		acceptedFindingCount: findings.acceptedCount,
		droppedFindingCount: findings.dropped.length,
		rawSuggestionCount: suggestions.rawCount,
		acceptedSuggestionCount: suggestions.acceptedCount,
		droppedSuggestionCount: suggestions.dropped.length,
		summary: `${findingSummary} ${suggestionSummary}`,
	};
}

function storeKey(rootUri: vscode.Uri): string {
	return `cliDiff.aiReview.${rootUri.toString()}`;
}
