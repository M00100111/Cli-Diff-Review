import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { LlmClient } from '../llm/client';
import { LlmRuntimeConfig } from '../llm/config';
import { isJsonObject } from '../llm/json';
import { ReviewFileState, ReviewHunk, ReviewSession } from '../types';
import { isAbortError } from '../wiki/cancellation';
import { isWikiPath } from '../wiki/paths';
import { createReadOnlyAgentTools } from './tools';
import { AgentRunner, AgentTraceDetail, AgentTraceEvent } from './runtime';

export type AiReviewSeverity = 'error' | 'warning' | 'suggestion' | 'info';

export type AiReviewLanguage = 'zh-CN' | 'en';

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

export interface AiReviewChunkSuggestion {
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
	signature: string;
	findings: AiReviewFinding[];
	suggestions: AiReviewChunkSuggestion[];
	fileResults: AiReviewFileResult[];
	generatedAt: string;
	status: 'partial' | 'complete';
	completedFiles: string[];
	failedFile?: string;
	error?: string;
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
	session: ReviewSession;
	root: vscode.WorkspaceFolder;
	config: LlmRuntimeConfig;
	client: LlmClient;
	language: AiReviewLanguage;
	existingReview?: StoredAiReview;
	includeWikiTools?: boolean;
	maxRounds?: number | 'unlimited';
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
	onTrace?: (event: AgentTraceEvent, context: CodeReviewTraceContext) => void;
	onFileComplete?: (review: StoredAiReview) => void | Promise<void>;
}

const severities = new Set<AiReviewSeverity>(['error', 'warning', 'suggestion', 'info']);
const severityOrder: Record<AiReviewSeverity, number> = { error: 0, warning: 1, suggestion: 2, info: 3 };

export class AiReviewPartialError extends Error {
	public constructor(message: string, public readonly review: StoredAiReview, public readonly cause?: unknown) {
		super(message);
		this.name = 'AiReviewPartialError';
	}
}

export class CodeReviewAgentService {
	private readonly runner = new AgentRunner();

	public async review(options: CodeReviewAgentOptions): Promise<StoredAiReview> {
		const files = sourcePendingFiles(options.session);
		const signature = reviewChangeSignature(options.session);
		const review = initialStoredReview(signature, files, options.existingReview);
		const completedFiles = new Set(review.completedFiles);
		const limits = aiReviewRunLimits(options.maxRounds);
		for (const [index, file] of files.entries()) {
			if (completedFiles.has(file.uri.toString())) {
				continue;
			}
			const context: CodeReviewTraceContext = {
				fileUri: file.uri.toString(),
				relativePath: file.relativePath,
				fileIndex: index + 1,
				fileCount: files.length,
			};
			options.onProgress?.(`Reviewing ${file.relativePath} (${index + 1}/${files.length})`);
			try {
				const result = await this.runner.run({
					config: options.config,
					client: options.client,
					systemPrompt: reviewSystemPrompt(options.language, Boolean(options.includeWikiTools)),
					userPrompt: reviewUserPrompt(file),
					tools: createReadOnlyAgentTools({
						root: options.root,
						reviewSession: options.session,
						includeWikiTools: Boolean(options.includeWikiTools),
					}),
					signal: options.signal,
					onProgress: (progress) => options.onProgress?.(`${file.relativePath}: ${progress.message}`),
					onTrace: (event) => options.onTrace?.(event, context),
					maxRounds: limits.maxRounds,
					maxToolCalls: limits.maxToolCalls,
					maxRunMs: limits.maxRunMs,
				});
				let validation: AiReviewResultValidation;
				try {
					validation = validateAiReviewResult(result.result, file, review.findings.length, review.suggestions.length);
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
					summary: validation.fileResult.summary,
					round: result.rounds,
					status: 'success',
					details: [
						jsonTraceDetail('Finding diagnostics', validation.findingDiagnostics),
						jsonTraceDetail('Suggestion diagnostics', validation.suggestionDiagnostics),
						jsonTraceDetail('Accepted findings', validation.findings),
						jsonTraceDetail('Accepted suggestions', validation.suggestions),
					],
				}, context);
				review.findings = [
					...review.findings.filter((finding) => finding.uri !== file.uri.toString()),
					...validation.findings,
				];
				review.suggestions = [
					...review.suggestions.filter((suggestion) => suggestion.uri !== file.uri.toString()),
					...validation.suggestions,
				];
				review.fileResults = upsertFileResult(review.fileResults, validation.fileResult);
				completedFiles.add(file.uri.toString());
				review.completedFiles = [...completedFiles];
				review.failedFile = undefined;
				review.error = undefined;
				review.status = completedFiles.size >= files.length ? 'complete' : 'partial';
				review.generatedAt = new Date().toISOString();
				await options.onFileComplete?.(cloneStoredReview(review));
			} catch (error) {
				if (isAbortError(error)) {
					throw error;
				}
				review.status = 'partial';
				review.failedFile = file.uri.toString();
				review.error = error instanceof Error ? error.message : String(error);
				review.fileResults = upsertFileResult(review.fileResults, errorFileResult(file, review.error));
				review.generatedAt = new Date().toISOString();
				throw new AiReviewPartialError(review.error, cloneStoredReview(review), error);
			}
		}
		if (reviewChangeSignature(options.session) !== signature) {
			throw new Error('Pending source chunks changed while the AI review was running. Generate the review again.');
		}
		review.status = 'complete';
		review.completedFiles = files.map((file) => file.uri.toString());
		review.failedFile = undefined;
		review.error = undefined;
		review.generatedAt = new Date().toISOString();
		return review;
	}
}

export class AiReviewStore {
	public constructor(private readonly workspaceState: vscode.Memento) {}

	public load(session: ReviewSession | undefined): StoredAiReview | undefined {
		if (!session) {
			return undefined;
		}
		const stored = this.workspaceState.get<StoredAiReview>(storeKey(session.rootUri));
		const signature = reviewChangeSignature(session);
		return stored?.signature === signature ? normalizeStoredReview(stored, signature, sourcePendingFiles(session)) : undefined;
	}

	public async save(session: ReviewSession, review: StoredAiReview): Promise<void> {
		await this.workspaceState.update(storeKey(session.rootUri), review);
	}

	public async clear(rootUri: vscode.Uri): Promise<void> {
		await this.workspaceState.update(storeKey(rootUri), undefined);
	}
}

function initialStoredReview(signature: string, files: ReviewFileState[], existingReview?: StoredAiReview): StoredAiReview {
	if (existingReview?.signature === signature && existingReview.status === 'partial') {
		return normalizeStoredReview(existingReview, signature, files);
	}
	return {
		signature,
		findings: [],
		suggestions: [],
		fileResults: [],
		generatedAt: new Date().toISOString(),
		status: 'partial',
		completedFiles: [],
	};
}

function normalizeStoredReview(review: StoredAiReview, signature: string, files: ReviewFileState[]): StoredAiReview {
	const status = review.status ?? 'complete';
	const allFileUris = files.map((file) => file.uri.toString());
	const completedFiles = Array.isArray(review.completedFiles)
		? review.completedFiles.filter((uri): uri is string => typeof uri === 'string' && allFileUris.includes(uri))
		: status === 'complete' ? allFileUris : [];
	return {
		signature,
		findings: Array.isArray(review.findings) ? review.findings : [],
		suggestions: Array.isArray(review.suggestions) ? review.suggestions : [],
		fileResults: Array.isArray(review.fileResults) ? review.fileResults : [],
		generatedAt: typeof review.generatedAt === 'string' ? review.generatedAt : new Date().toISOString(),
		status,
		completedFiles,
		failedFile: typeof review.failedFile === 'string' ? review.failedFile : undefined,
		error: typeof review.error === 'string' ? review.error : undefined,
	};
}

function aiReviewRunLimits(maxRounds: number | 'unlimited' | undefined): {
	maxRounds: number | 'unlimited';
	maxToolCalls: number | 'unlimited';
	maxRunMs: number;
} {
	if (maxRounds === 'unlimited') {
		return {
			maxRounds: 'unlimited',
			maxToolCalls: 'unlimited',
			maxRunMs: 60 * 60 * 1000,
		};
	}
	const rounds = Math.max(1, Math.floor(maxRounds ?? 64));
	return {
		maxRounds: rounds,
		maxToolCalls: Math.max(48, rounds * 4),
		maxRunMs: Math.max(10 * 60 * 1000, rounds * 60 * 1000),
	};
}

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
		hunks: [...file.hunks, ...file.acceptedHunks, ...file.rejectedHunks]
			.map(stableReviewHunkSignature)
			.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
	}));
	return createHash('sha256').update(JSON.stringify({ sessionId: session.id, files: payload })).digest('hex');
}

function sourceReviewFiles(session: ReviewSession): ReviewFileState[] {
	return [...session.files.values()]
		.filter((file) => (
			file.hunks.length > 0
			|| file.acceptedHunks.length > 0
			|| file.rejectedHunks.length > 0
		) && !isWikiPath(file.relativePath))
		.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function stableReviewHunkSignature(hunk: ReviewHunk): Record<string, unknown> {
	return {
		kind: hunk.kind,
		oldStart: hunk.oldStart,
		oldLines: hunk.oldLines,
		newStart: hunk.newStart,
		newLines: hunk.newLines,
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
		suggestions.push({
			id: `${file.uri.toString()}#${hunk.id}#suggestion#${generationOrder}`,
			uri: file.uri.toString(),
			relativePath: file.relativePath,
			hunkId: hunk.id,
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

function reviewSystemPrompt(language: AiReviewLanguage, includeWikiTools: boolean): string {
	return [
		'You are a source-grounded Code Review Agent.',
		includeWikiTools
			? 'Review only the supplied pending hunks. Source and Wiki files are read-only.'
			: 'Review only the supplied pending hunks. Source files are read-only.',
		includeWikiTools
			? 'Use tools when needed to inspect callers, tests, configuration, and optional Wiki context.'
			: 'Use tools when needed to inspect callers, tests, and configuration.',
		'Report concrete correctness, reliability, security, or maintainability risks; avoid generic praise.',
		'Every finding must bind to one supplied hunkId.',
		'Allowed finding severities are error, warning, suggestion, and info. Use error for correctness bugs that can break expected behavior.',
		'When a concise code change would help, include at most one suggestion per non-delete hunk. A suggestion replacementText replaces the entire current newText for that hunk; preserve the hunk line terminator when the original newText ends with one. Do not create suggestions for delete hunks.',
		languageInstruction(language),
		'Keep finding title, explanation, and recommendation concise. When mentioning code symbols or operators, avoid decorative markdown and make sure any required quotes, backslashes, or newlines are valid JSON string content.',
		'Finish with {"type":"final","result":{"findings":[{"hunkId":"...","severity":"warning","title":"...","explanation":"...","recommendation":"...","evidence":["path:line"]}],"suggestions":[{"hunkId":"...","replacementText":"complete replacement text for the hunk newText","rationale":"why this replacement helps"}]}}.',
	].join('\n');
}

function languageInstruction(language: AiReviewLanguage): string {
	const target = language === 'en'
		? 'Write every finding title, explanation, and recommendation in English.'
		: 'Write every finding title, explanation, and recommendation in Simplified Chinese.';
	return `${target} Do not translate hunkId values, file paths, code symbols, identifiers, commands, or evidence locations.`;
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

function errorFileResult(file: ReviewFileState, error: string): AiReviewFileResult {
	return {
		uri: file.uri.toString(),
		relativePath: file.relativePath,
		status: 'error',
		rawFindingCount: 0,
		acceptedFindingCount: 0,
		droppedFindingCount: 0,
		rawSuggestionCount: 0,
		acceptedSuggestionCount: 0,
		droppedSuggestionCount: 0,
		summary: error,
		error,
	};
}

function upsertFileResult(results: AiReviewFileResult[], result: AiReviewFileResult): AiReviewFileResult[] {
	return [
		...results.filter((item) => item.uri !== result.uri),
		result,
	].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function cloneStoredReview(review: StoredAiReview): StoredAiReview {
	return {
		...review,
		findings: [...review.findings],
		suggestions: [...review.suggestions],
		fileResults: [...review.fileResults],
		completedFiles: [...review.completedFiles],
	};
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
