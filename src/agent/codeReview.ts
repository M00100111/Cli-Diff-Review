import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { LlmClient } from '../llm/client';
import { LlmRuntimeConfig } from '../llm/config';
import { isJsonObject } from '../llm/json';
import { ReviewFileState, ReviewHunk, ReviewSession } from '../types';
import { isAbortError } from '../wiki/cancellation';
import { isWikiPath } from '../wiki/paths';
import type { WikiFreshnessAssessment } from '../wiki/state';
import { createReadOnlyAgentTools } from './tools';
import { AgentRunCheckpoint, AgentRunner, AgentTraceDetail, AgentTraceEvent } from './runtime';

export type AiReviewSeverity = 'error' | 'warning' | 'suggestion' | 'info';

export type AiReviewLanguage = 'zh-CN' | 'en';
export type AiReviewStrategy = 'Auto' | 'Multi' | 'FileOnly';
export type AiReviewPipeline = 'fileOnly' | 'multi';
export type AiReviewTraceStage = 'knowledge' | 'plan' | 'file' | 'integration';

export type KnowledgeClaimStatus = 'confirmed' | 'conflicted' | 'unverified';

export interface AiReviewKnowledgeClaim {
	page: string;
	claim: string;
	status: KnowledgeClaimStatus;
	evidencePaths: string[];
	confidence?: number;
}

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
	source?: 'file' | 'integration';
	relatedHunkIds?: string[];
	relatedPaths?: string[];
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
	strategy?: AiReviewStrategy;
	pipeline?: AiReviewPipeline;
	completedIntegration?: boolean;
	knowledgeContextSummary?: string;
	knowledgeFreshness?: WikiFreshnessAssessment;
	knowledgeClaims?: AiReviewKnowledgeClaim[];
	knowledgeContext?: AiReviewKnowledgeContext;
	planSummary?: string;
	reviewPlan?: AiReviewPlan;
	failedFile?: string;
	error?: string;
	continuations?: AiReviewContinuation[];
}

export interface AiReviewContinuation {
	stage: AiReviewTraceStage;
	fileUri?: string;
	checkpoint: AgentRunCheckpoint;
}

export interface CodeReviewTraceContext {
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
	session: ReviewSession;
	root: vscode.WorkspaceFolder;
	config: LlmRuntimeConfig;
	client: LlmClient;
	language: AiReviewLanguage;
	existingReview?: StoredAiReview;
	includeWikiTools?: boolean;
	knowledgeFreshness?: WikiFreshnessAssessment;
	strategy?: AiReviewStrategy;
	fileConcurrency?: number;
	maxRounds?: number | 'unlimited';
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
	onTrace?: (event: AgentTraceEvent, context: CodeReviewTraceContext) => void;
	onFileComplete?: (review: StoredAiReview) => void | Promise<void>;
	onCheckpoint?: (review: StoredAiReview) => void | Promise<void>;
}

const severities = new Set<AiReviewSeverity>(['error', 'warning', 'suggestion', 'info']);

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
		const strategy = normalizeAiReviewStrategy(options.strategy);
		let pipeline = options.existingReview?.pipeline ?? selectAiReviewPipeline(strategy, files);
		const review = initialStoredReview(signature, files, options.existingReview);
		const limits = aiReviewRunLimits(options.maxRounds);
		review.strategy = strategy;
		review.pipeline = pipeline;
		if (pipeline === 'multi') {
			review.knowledgeFreshness = normalizeKnowledgeFreshness(options.knowledgeFreshness) ?? review.knowledgeFreshness;
		}
		if (pipeline === 'multi' && review.completedIntegration === undefined) {
			review.completedIntegration = false;
		}

		let knowledgeContext = storedKnowledgeContext(review, Boolean(options.includeWikiTools));
		let plan = storedReviewPlan(review);
		if (pipeline === 'multi' && !review.planSummary) {
			try {
				knowledgeContext = await this.runKnowledgeRetrieval(options, files, limits, review);
				review.knowledgeContext = knowledgeContext;
				review.knowledgeContextSummary = knowledgeContext.summary;
				review.knowledgeFreshness = knowledgeContext.freshness;
				review.knowledgeClaims = knowledgeContext.claims;
				await this.persistReviewProgress(options, review);
				plan = await this.runPlanning(options, files, knowledgeContext, limits, review);
				review.reviewPlan = plan;
				review.planSummary = plan.summary;
				review.completedIntegration = false;
				await this.persistReviewProgress(options, review);
			} catch (error) {
				if (strategy === 'Auto' && !isContinuationIncompatibleError(error)) {
					emitReviewTrace(options, stageTraceContext('plan', files), {
						kind: 'run_error',
						title: 'AI review strategy fallback',
						summary: `Multi-agent prelude failed; falling back to FileOnly: ${errorMessage(error)}`,
						status: 'info',
						details: [textTraceDetail('Error', errorMessage(error))],
					});
					pipeline = 'fileOnly';
					review.pipeline = pipeline;
					review.completedIntegration = undefined;
					review.knowledgeContextSummary = undefined;
					review.knowledgeFreshness = undefined;
					review.knowledgeClaims = undefined;
					review.knowledgeContext = undefined;
					review.planSummary = undefined;
					review.reviewPlan = undefined;
					review.continuations = [];
					knowledgeContext = storedKnowledgeContext(review, Boolean(options.includeWikiTools));
					plan = storedReviewPlan(review);
				} else {
					review.status = 'partial';
					review.error = errorMessage(error);
					review.generatedAt = new Date().toISOString();
					throw new AiReviewPartialError(review.error, cloneStoredReview(review), error);
				}
			}
		}

		await this.runFileReviews(options, files, review, limits, pipeline, knowledgeContext, plan);
		if (pipeline === 'multi' && review.completedIntegration !== true) {
			await this.runIntegrationReview(options, files, review, limits, knowledgeContext, plan);
		}
		if (reviewChangeSignature(options.session) !== signature) {
			throw new Error('Pending source chunks changed while the AI review was running. Generate the review again.');
		}
		review.status = 'complete';
		review.completedFiles = files.map((file) => file.uri.toString());
		review.failedFile = undefined;
		review.error = undefined;
		review.continuations = [];
		review.pipeline = pipeline;
		review.completedIntegration = pipeline === 'multi' ? true : undefined;
		review.generatedAt = new Date().toISOString();
		return review;
	}

	private async runFileReviews(
		options: CodeReviewAgentOptions,
		files: ReviewFileState[],
		review: StoredAiReview,
		limits: ReturnType<typeof aiReviewRunLimits>,
		pipeline: AiReviewPipeline,
		knowledgeContext: AiReviewKnowledgeContext,
		plan: AiReviewPlan,
	): Promise<void> {
		const completedFiles = new Set(review.completedFiles);
		const changeSummary = changeSetSummary(files);
		const pendingFiles = files
			.map((file, index) => ({ file, index }))
			.filter((entry) => !completedFiles.has(entry.file.uri.toString()))
			.map((entry, pendingIndex) => ({ ...entry, pendingIndex }));
		const concurrency = normalizedAiReviewFileConcurrency(options.fileConcurrency, pendingFiles.length);
		if (concurrency <= 1) {
			for (const entry of pendingFiles) {
				try {
					const validation = await this.runSingleFileReview(options, review, entry.file, entry.index, files.length, limits, pipeline, changeSummary, knowledgeContext, plan, review.findings.length, review.suggestions.length);
					await this.applyFileReviewValidation(options, files, review, completedFiles, pipeline, entry.file, validation);
				} catch (error) {
					this.throwFileReviewPartial(review, entry.file, error);
				}
			}
			return;
		}

		let nextIndex = 0;
		let flushIndex = 0;
		let firstFailure: { entry: typeof pendingFiles[number]; error: unknown } | undefined;
		let flushQueue = Promise.resolve();
		const results = new Map<number, AiReviewResultValidation>();
		const enqueueFlush = async (): Promise<void> => {
			flushQueue = flushQueue.then(async () => {
				while (results.has(flushIndex)) {
					const entry = pendingFiles[flushIndex];
					const validation = results.get(flushIndex);
					if (!entry || !validation) {
						return;
					}
					results.delete(flushIndex);
					await this.applyFileReviewValidation(options, files, review, completedFiles, pipeline, entry.file, validation);
					flushIndex += 1;
				}
			});
			await flushQueue;
		};
		const runWorker = async (): Promise<void> => {
			while (!firstFailure) {
				const entry = pendingFiles[nextIndex];
				nextIndex += 1;
				if (!entry) {
					return;
				}
				try {
					const validation = await this.runSingleFileReview(options, review, entry.file, entry.index, files.length, limits, pipeline, changeSummary, knowledgeContext, plan, 0, 0);
					results.set(entry.pendingIndex, validation);
					await enqueueFlush();
				} catch (error) {
					if (isAbortError(error)) {
						throw error;
					}
					firstFailure ??= { entry, error };
					return;
				}
			}
		};
		await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
		await enqueueFlush();
		if (firstFailure) {
			this.throwFileReviewPartial(review, firstFailure.entry.file, firstFailure.error);
		}
	}

	private async runSingleFileReview(
		options: CodeReviewAgentOptions,
		review: StoredAiReview,
		file: ReviewFileState,
		index: number,
		fileCount: number,
		limits: ReturnType<typeof aiReviewRunLimits>,
		pipeline: AiReviewPipeline,
		changeSummary: string,
		knowledgeContext: AiReviewKnowledgeContext,
		plan: AiReviewPlan,
		findingStartOrder: number,
		suggestionStartOrder: number,
	): Promise<AiReviewResultValidation> {
		const context = fileTraceContext(file, index, fileCount);
		options.onProgress?.('Reviewing ' + file.relativePath + ' (' + (index + 1) + '/' + fileCount + ')');
		const result = await this.runner.run({
			config: options.config,
			client: options.client,
			systemPrompt: reviewSystemPrompt(options.language, Boolean(options.includeWikiTools), pipeline),
			userPrompt: reviewUserPrompt(file, pipeline === 'multi'
				? reviewContextForFile(file, changeSummary, knowledgeContext, plan)
				: undefined),
			tools: createReadOnlyAgentTools({
				root: options.root,
				reviewSession: options.session,
				includeWikiTools: Boolean(options.includeWikiTools),
			}),
			signal: options.signal,
			onProgress: (progress) => options.onProgress?.(file.relativePath + ': ' + progress.message),
			onTrace: (event) => options.onTrace?.(event, context),
			maxRounds: limits.maxRounds,
			maxRunMs: limits.maxRunMs,
			resumeFrom: this.continuationFor(review, 'file', file.uri.toString())?.checkpoint,
			onCheckpoint: (checkpoint) => this.saveContinuation(options, review, 'file', file.uri.toString(), checkpoint),
		});
		try {
			const validation = validateAiReviewResult(result.result, file, findingStartOrder, suggestionStartOrder);
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
			this.clearContinuation(review, 'file', file.uri.toString());
			return validation;
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
	}

	private async applyFileReviewValidation(
		options: CodeReviewAgentOptions,
		files: ReviewFileState[],
		review: StoredAiReview,
		completedFiles: Set<string>,
		pipeline: AiReviewPipeline,
		file: ReviewFileState,
		validation: AiReviewResultValidation,
	): Promise<void> {
		const otherFindings = review.findings.filter((finding) => finding.uri !== file.uri.toString());
		const otherSuggestions = review.suggestions.filter((suggestion) => suggestion.uri !== file.uri.toString());
		const findings = rebaseFileFindings(file, validation.findings, otherFindings.length);
		const suggestions = rebaseFileSuggestions(file, validation.suggestions, otherSuggestions.length);
		review.findings = [...otherFindings, ...findings];
		review.suggestions = [...otherSuggestions, ...suggestions];
		review.fileResults = upsertFileResult(review.fileResults, validation.fileResult);
		completedFiles.add(file.uri.toString());
		review.completedFiles = files.filter((candidate) => completedFiles.has(candidate.uri.toString())).map((candidate) => candidate.uri.toString());
		review.failedFile = undefined;
		review.error = undefined;
		review.status = completedFiles.size >= files.length && pipeline === 'fileOnly' ? 'complete' : 'partial';
		if (pipeline === 'multi') {
			review.completedIntegration = false;
		}
		review.generatedAt = new Date().toISOString();
		await options.onFileComplete?.(cloneStoredReview(review));
	}

	private throwFileReviewPartial(review: StoredAiReview, file: ReviewFileState, error: unknown): never {
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

	private async runKnowledgeRetrieval(
		options: CodeReviewAgentOptions,
		files: ReviewFileState[],
		limits: ReturnType<typeof aiReviewRunLimits>,
		review: StoredAiReview,
	): Promise<AiReviewKnowledgeContext> {
		const context = stageTraceContext('knowledge', files);
		if (!options.includeWikiTools) {
			this.clearContinuation(review, 'knowledge');
			const skipped = defaultKnowledgeContext(false, options.knowledgeFreshness);
			emitReviewTrace(options, context, {
				kind: 'run_complete',
				title: 'KB Retrieval skipped',
				summary: skipped.summary,
				status: 'info',
				details: [jsonTraceDetail('Wiki freshness', skipped.freshness), jsonTraceDetail('Knowledge context', skipped)],
			});
			return skipped;
		}
		options.onProgress?.('Retrieving AI review knowledge context');
		const result = await this.runner.run({
			config: options.config,
			client: options.client,
			systemPrompt: knowledgeRetrievalSystemPrompt(),
			userPrompt: knowledgeRetrievalUserPrompt(files, options.knowledgeFreshness),
			tools: createReadOnlyAgentTools({ root: options.root, reviewSession: options.session, includeWikiTools: true })
				.filter((tool) => ['list_wiki_files', 'read_wiki_file', 'search_wiki_files', 'search_workspace', 'read_workspace_file', 'read_pending_change', 'list_pending_changes'].includes(tool.name)),
			signal: options.signal,
			onProgress: (progress) => options.onProgress?.(`Knowledge: ${progress.message}`),
			onTrace: (event) => options.onTrace?.(event, context),
			...stageRunLimits(limits),
			resumeFrom: this.continuationFor(review, 'knowledge')?.checkpoint,
			onCheckpoint: (checkpoint) => this.saveContinuation(options, review, 'knowledge', undefined, checkpoint),
		});
		this.clearContinuation(review, 'knowledge');
		const knowledgeContext = knowledgeContextFromResult(result.result, options.knowledgeFreshness);
		emitReviewTrace(options, context, {
			kind: 'parse_success',
			title: 'Knowledge context parsed',
			summary: 'Wiki freshness: ' + (knowledgeContext.freshness?.status ?? 'unknown') + '; ' + knowledgeContext.claims.length + ' claims accepted; ' + knowledgeContext.claimsDropped + ' dropped.',
			status: knowledgeContext.freshness?.status === 'stale' ? 'info' : 'success',
			details: [
				jsonTraceDetail('Wiki freshness', knowledgeContext.freshness),
				jsonTraceDetail('Knowledge claims', knowledgeContext.claims),
			],
		});
		return knowledgeContext;
	}

	private async runPlanning(
		options: CodeReviewAgentOptions,
		files: ReviewFileState[],
		knowledgeContext: AiReviewKnowledgeContext,
		limits: ReturnType<typeof aiReviewRunLimits>,
		review: StoredAiReview,
	): Promise<AiReviewPlan> {
		const context = stageTraceContext('plan', files);
		options.onProgress?.('Planning AI review');
		const result = await this.runner.run({
			config: options.config,
			client: options.client,
			systemPrompt: planningSystemPrompt(),
			userPrompt: planningUserPrompt(files, knowledgeContext),
			tools: createReadOnlyAgentTools({ root: options.root, reviewSession: options.session, includeWikiTools: Boolean(options.includeWikiTools) }),
			signal: options.signal,
			onProgress: (progress) => options.onProgress?.(`Plan: ${progress.message}`),
			onTrace: (event) => options.onTrace?.(event, context),
			...stageRunLimits(limits),
			resumeFrom: this.continuationFor(review, 'plan')?.checkpoint,
			onCheckpoint: (checkpoint) => this.saveContinuation(options, review, 'plan', undefined, checkpoint),
		});
		this.clearContinuation(review, 'plan');
		return reviewPlanFromResult(result.result, files);
	}

	private async runIntegrationReview(
		options: CodeReviewAgentOptions,
		files: ReviewFileState[],
		review: StoredAiReview,
		limits: ReturnType<typeof aiReviewRunLimits>,
		knowledgeContext: AiReviewKnowledgeContext,
		plan: AiReviewPlan,
	): Promise<void> {
		const context = stageTraceContext('integration', files);
		options.onProgress?.('Running integration AI review');
		try {
			const fileFindings = review.findings.filter((finding) => finding.source !== 'integration');
			const result = await this.runner.run({
				config: options.config,
				client: options.client,
				systemPrompt: integrationSystemPrompt(options.language),
				userPrompt: integrationUserPrompt(files, fileFindings, knowledgeContext, plan),
				tools: createReadOnlyAgentTools({ root: options.root, reviewSession: options.session, includeWikiTools: Boolean(options.includeWikiTools) }),
				signal: options.signal,
				onProgress: (progress) => options.onProgress?.(`Integration: ${progress.message}`),
				onTrace: (event) => options.onTrace?.(event, context),
				...stageRunLimits(limits),
				resumeFrom: this.continuationFor(review, 'integration')?.checkpoint,
				onCheckpoint: (checkpoint) => this.saveContinuation(options, review, 'integration', undefined, checkpoint),
			});
			const validation = validateIntegrationReviewFindingsWithDiagnostics(result.result, files, fileFindings.length);
			options.onTrace?.({
				kind: 'parse_success',
				title: 'Integration findings parsed',
				summary: findingDiagnosticsSummary(validation.diagnostics),
				round: result.rounds,
				status: 'success',
				details: [
					jsonTraceDetail('Finding diagnostics', validation.diagnostics),
					jsonTraceDetail('Accepted findings', validation.findings),
				],
			}, context);
			review.findings = mergeFileAndIntegrationFindings(fileFindings, validation.findings);
			review.completedIntegration = true;
			this.clearContinuation(review, 'integration');
			review.failedFile = undefined;
			review.error = undefined;
			review.generatedAt = new Date().toISOString();
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}
			review.status = 'partial';
			review.completedIntegration = false;
			review.error = errorMessage(error);
			review.generatedAt = new Date().toISOString();
			throw new AiReviewPartialError(review.error, cloneStoredReview(review), error);
		}
	}

	private continuationFor(review: StoredAiReview, stage: AiReviewTraceStage, fileUri?: string): AiReviewContinuation | undefined {
		return review.continuations?.find((continuation) => continuation.stage === stage && continuation.fileUri === fileUri);
	}

	private async saveContinuation(
		options: CodeReviewAgentOptions,
		review: StoredAiReview,
		stage: AiReviewTraceStage,
		fileUri: string | undefined,
		checkpoint: AgentRunCheckpoint,
	): Promise<void> {
		const continuation: AiReviewContinuation = { stage, fileUri, checkpoint };
		review.continuations = [
			...(review.continuations ?? []).filter((item) => item.stage !== stage || item.fileUri !== fileUri),
			continuation,
		];
		review.status = 'partial';
		review.generatedAt = new Date().toISOString();
		await this.persistReviewProgress(options, review);
	}

	private clearContinuation(review: StoredAiReview, stage: AiReviewTraceStage, fileUri?: string): void {
		review.continuations = (review.continuations ?? []).filter((item) => item.stage !== stage || item.fileUri !== fileUri);
	}

	private async persistReviewProgress(options: CodeReviewAgentOptions, review: StoredAiReview): Promise<void> {
		await options.onCheckpoint?.(cloneStoredReview(review));
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
		strategy: normalizeAiReviewStrategy(review.strategy),
		pipeline: review.pipeline === 'multi' ? 'multi' : review.pipeline === 'fileOnly' ? 'fileOnly' : undefined,
		completedIntegration: typeof review.completedIntegration === 'boolean' ? review.completedIntegration : undefined,
		knowledgeContextSummary: typeof review.knowledgeContextSummary === 'string' ? review.knowledgeContextSummary : undefined,
		knowledgeFreshness: normalizeKnowledgeFreshness(review.knowledgeFreshness),
		knowledgeClaims: normalizeKnowledgeClaims(review.knowledgeClaims),
		knowledgeContext: isJsonObject(review.knowledgeContext) ? review.knowledgeContext as unknown as AiReviewKnowledgeContext : undefined,
		planSummary: typeof review.planSummary === 'string' ? review.planSummary : undefined,
		reviewPlan: isJsonObject(review.reviewPlan) ? review.reviewPlan as unknown as AiReviewPlan : undefined,
		failedFile: typeof review.failedFile === 'string' ? review.failedFile : undefined,
		error: typeof review.error === 'string' ? review.error : undefined,
		continuations: normalizeContinuations(review.continuations),
	};
}

interface AiReviewKnowledgeContext {
	enabled: boolean;
	summary: string;
	relevantPages: string[];
	perFileHints: Record<string, string>;
	interfaceContracts: string[];
	workflowRisks: string[];
	freshness?: WikiFreshnessAssessment;
	claims: AiReviewKnowledgeClaim[];
	claimsDropped: number;
}

interface AiReviewPlan {
	summary: string;
	changeIntent: string;
	riskAreas: string[];
	integrationChecks: string[];
	filePlans: Record<string, string>;
}

interface ReviewPromptContext {
	changeSetSummary: string;
	knowledgeContext: AiReviewKnowledgeContext;
	plan: AiReviewPlan;
	filePlan: string;
}

interface ReviewHunkReference {
	uri: string;
	relativePath: string;
	hunkId: string;
	line: number;
	hunk: ReviewHunk | Pick<ReviewHunk, 'id' | 'kind' | 'oldLines' | 'newLines'>;
}

function normalizedAiReviewFileConcurrency(value: unknown, pendingFileCount: number): number {
	if (pendingFileCount <= 1) {
		return 1;
	}
	if (value === 0) {
		return pendingFileCount;
	}
	const configured = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 1;
	return Math.max(1, Math.min(pendingFileCount, configured));
}

function normalizeKnowledgeFreshness(value: unknown): WikiFreshnessAssessment | undefined {
	if (!isJsonObject(value) || (value.status !== 'fresh' && value.status !== 'stale' && value.status !== 'unknown') || typeof value.checkedAt !== 'string') {
		return undefined;
	}
	const addedSourcePaths = stringArray(value.addedSourcePaths);
	const modifiedSourcePaths = stringArray(value.modifiedSourcePaths);
	const deletedSourcePaths = stringArray(value.deletedSourcePaths);
	const totalChangedSourceCount = typeof value.totalChangedSourceCount === 'number' && Number.isFinite(value.totalChangedSourceCount) && value.totalChangedSourceCount >= 0 ? Math.floor(value.totalChangedSourceCount) : addedSourcePaths.length + modifiedSourcePaths.length + deletedSourcePaths.length;
	return {
		status: value.status,
		checkedAt: value.checkedAt,
		lastSyncedAt: typeof value.lastSyncedAt === 'string' ? value.lastSyncedAt : undefined,
		addedSourcePaths,
		modifiedSourcePaths,
		deletedSourcePaths,
		totalChangedSourceCount,
		reason: typeof value.reason === 'string' ? value.reason : undefined,
	};
}

function normalizeKnowledgeClaims(value: unknown): AiReviewKnowledgeClaim[] {
	return knowledgeClaimsFromResult(value).claims;
}
function normalizeAiReviewStrategy(value: unknown): AiReviewStrategy {
	return value === 'Multi' || value === 'FileOnly' ? value : 'Auto';
}

function selectAiReviewPipeline(strategy: AiReviewStrategy, files: ReviewFileState[]): AiReviewPipeline {
	if (strategy === 'FileOnly') {
		return 'fileOnly';
	}
	if (strategy === 'Multi') {
		return 'multi';
	}
	return shouldUseMultiAgentReview(files) ? 'multi' : 'fileOnly';
}

function shouldUseMultiAgentReview(files: ReviewFileState[]): boolean {
	const hunkCount = files.reduce((total, file) => total + file.hunks.length, 0);
	return files.length > 1
		|| hunkCount >= 4
		|| files.some((file) => isPublicReviewPath(file.relativePath) || file.hunks.some(hasPublicSurfaceText));
}

function isPublicReviewPath(relativePath: string): boolean {
	const normalized = relativePath.replace(/\\/g, '/');
	return /(^|\/)(package\.json|tsconfig\.json|webpack\.config\.js|eslint\.config\.[mc]?js)$/.test(normalized)
		|| /(^|\/)src\/extension\.ts$/.test(normalized)
		|| /(^|\/)(interfaces?|types?|api|routes?|commands?)\//i.test(normalized)
		|| /\.d\.ts$/.test(normalized);
}

function hasPublicSurfaceText(hunk: ReviewHunk): boolean {
	return /\bexport\s+(interface|type|class|function|const|enum)\b|commands\.registerCommand|\bcontributes\b|\bconfiguration\b/.test(`${hunk.oldText}\n${hunk.newText}`);
}

function stageRunLimits(limits: ReturnType<typeof aiReviewRunLimits>): Pick<Parameters<AgentRunner['run']>[0], 'maxRounds' | 'maxRunMs'> {
	return {
		maxRounds: limits.maxRounds,
		maxRunMs: limits.maxRunMs,
	};
}

function fileTraceContext(file: ReviewFileState, index: number, fileCount: number): CodeReviewTraceContext {
	return {
		stage: 'file',
		fileUri: file.uri.toString(),
		relativePath: file.relativePath,
		fileIndex: index + 1,
		fileCount,
	};
}

function stageTraceContext(stage: AiReviewTraceStage, files: ReviewFileState[]): CodeReviewTraceContext {
	return {
		stage,
		relativePath: stage,
		fileIndex: 0,
		fileCount: files.length,
	};
}

function emitReviewTrace(options: CodeReviewAgentOptions, context: CodeReviewTraceContext, event: AgentTraceEvent): void {
	options.onTrace?.(event, context);
}

function unknownKnowledgeFreshness(reason: string): WikiFreshnessAssessment {
	return {
		status: 'unknown',
		checkedAt: new Date().toISOString(),
		addedSourcePaths: [],
		modifiedSourcePaths: [],
		deletedSourcePaths: [],
		totalChangedSourceCount: 0,
		reason,
	};
}

function defaultKnowledgeContext(wikiAvailable: boolean, freshness?: WikiFreshnessAssessment): AiReviewKnowledgeContext {
	return {
		enabled: wikiAvailable,
		summary: wikiAvailable ? 'Knowledge base context was not retrieved.' : 'Knowledge base is not initialized; KB Retrieval skipped.',
		relevantPages: [],
		perFileHints: {},
		interfaceContracts: [],
		workflowRisks: [],
		freshness: freshness ?? unknownKnowledgeFreshness(wikiAvailable ? 'Freshness was not checked.' : 'Knowledge base is not initialized.'),
		claims: [],
		claimsDropped: 0,
	};
}

function storedKnowledgeContext(review: StoredAiReview, wikiAvailable: boolean): AiReviewKnowledgeContext {
	if (review.knowledgeContext) {
		return {
			...review.knowledgeContext,
			relevantPages: [...review.knowledgeContext.relevantPages],
			perFileHints: { ...review.knowledgeContext.perFileHints },
			interfaceContracts: [...review.knowledgeContext.interfaceContracts],
			workflowRisks: [...review.knowledgeContext.workflowRisks],
			claims: [...review.knowledgeContext.claims],
		};
	}
	const context = defaultKnowledgeContext(wikiAvailable, review.knowledgeFreshness);
	if (review.knowledgeContextSummary) {
		context.summary = review.knowledgeContextSummary;
		context.enabled = wikiAvailable;
	}
	context.claims = review.knowledgeClaims ?? [];
	context.claimsDropped = 0;
	return context;
}

function storedReviewPlan(review: StoredAiReview): AiReviewPlan {
	if (review.reviewPlan) {
		return {
			...review.reviewPlan,
			riskAreas: [...review.reviewPlan.riskAreas],
			integrationChecks: [...review.reviewPlan.integrationChecks],
			filePlans: { ...review.reviewPlan.filePlans },
		};
	}
	return {
		summary: review.planSummary ?? 'No multi-agent review plan is available.',
		changeIntent: review.planSummary ?? '',
		riskAreas: [],
		integrationChecks: [],
		filePlans: {},
	};
}

function knowledgeContextFromResult(result: Record<string, unknown>, freshness?: WikiFreshnessAssessment): AiReviewKnowledgeContext {
	const claims = knowledgeClaimsFromResult(result.knowledgeClaims);
	return {
		enabled: true,
		summary: stringValue(result.summary, 'Knowledge context retrieved.'),
		relevantPages: stringArray(result.relevantPages),
		perFileHints: stringRecord(result.perFileHints),
		interfaceContracts: stringArray(result.interfaceContracts),
		workflowRisks: stringArray(result.workflowRisks),
		freshness: freshness ?? unknownKnowledgeFreshness('Freshness was not provided.'),
		claims: claims.claims,
		claimsDropped: claims.dropped,
	};
}

function knowledgeClaimsFromResult(value: unknown): { claims: AiReviewKnowledgeClaim[]; dropped: number } {
	if (!Array.isArray(value)) {
		return { claims: [], dropped: 0 };
	}
	const claims: AiReviewKnowledgeClaim[] = [];
	let dropped = 0;
	for (const candidate of value) {
		if (!isJsonObject(candidate) || typeof candidate.page !== 'string' || !candidate.page.trim() || typeof candidate.claim !== 'string' || !candidate.claim.trim() || (candidate.status !== 'confirmed' && candidate.status !== 'conflicted' && candidate.status !== 'unverified') || !Array.isArray(candidate.evidencePaths) || candidate.evidencePaths.some((item) => typeof item !== 'string' || !item.trim()) || (candidate.confidence !== undefined && (typeof candidate.confidence !== 'number' || !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1))) {
			dropped += 1;
			continue;
		}
		claims.push({
			page: candidate.page.trim(),
			claim: candidate.claim.trim(),
			status: candidate.status,
			evidencePaths: uniqueStrings(candidate.evidencePaths),
			confidence: typeof candidate.confidence === 'number' ? candidate.confidence : undefined,
		});
	}
	return { claims, dropped };
}

function reviewPlanFromResult(result: Record<string, unknown>, files: ReviewFileState[]): AiReviewPlan {
	const filePlans = stringRecord(result.filePlans);
	if (Array.isArray(result.filePlans)) {
		for (const item of result.filePlans) {
			if (isJsonObject(item) && typeof item.relativePath === 'string') {
				const value = typeof item.instructions === 'string' ? item.instructions : typeof item.summary === 'string' ? item.summary : '';
				if (value) {
					filePlans[item.relativePath] = value;
				}
			}
		}
	}
	for (const file of files) {
		filePlans[file.relativePath] ??= '';
	}
	return {
		summary: stringValue(result.summary, stringValue(result.changeIntent, 'AI review plan generated.')),
		changeIntent: stringValue(result.changeIntent, ''),
		riskAreas: stringArray(result.riskAreas),
		integrationChecks: stringArray(result.integrationChecks),
		filePlans,
	};
}

function changeSetSummary(files: ReviewFileState[]): string {
	return JSON.stringify({
		fileCount: files.length,
		hunkCount: files.reduce((total, file) => total + file.hunks.length, 0),
		files: files.map((file) => ({
			relativePath: file.relativePath,
			uri: file.uri.toString(),
			hunks: file.hunks.map(hunkSummary),
		})),
	});
}

function hunkSummary(hunk: ReviewHunk): Record<string, unknown> {
	return {
		hunkId: hunk.id,
		kind: hunk.kind,
		oldStart: hunk.oldStart,
		newStart: hunk.newStart,
		oldLines: hunk.oldLines,
		newLines: hunk.newLines,
		oldTextPreview: previewText(hunk.oldText, 700),
		newTextPreview: previewText(hunk.newText, 700),
	};
}

function reviewContextForFile(file: ReviewFileState, changeSetSummaryText: string, knowledgeContext: AiReviewKnowledgeContext, plan: AiReviewPlan): ReviewPromptContext {
	return {
		changeSetSummary: changeSetSummaryText,
		knowledgeContext,
		plan,
		filePlan: plan.filePlans[file.relativePath] || knowledgeContext.perFileHints[file.relativePath] || '',
	};
}

function validateIntegrationReviewFindingsWithDiagnostics(result: Record<string, unknown>, files: ReviewFileState[], startOrder = 0): AiReviewFindingValidation {
	if (!Array.isArray(result.findings)) {
		throw new Error('Integration Review Agent final result must include findings.');
	}
	const hunkIndex = buildHunkReferenceIndex(files);
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
		const primary = uniqueHunkReference(hunkIndex, candidate.hunkId);
		if (!primary) {
			dropped.push({ index, reason: 'Finding hunkId does not match a unique current review chunk.', hunkId: candidate.hunkId, candidate });
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
		const evidence = stringArray(candidate.evidence);
		if (evidence.length === 0) {
			dropped.push({ index, reason: 'Integration finding must include current source evidence.', hunkId: candidate.hunkId, candidate });
			continue;
		}
		const relatedHunkIds = uniqueStrings(candidate.relatedHunkIds).filter((hunkId) => hunkId !== primary.hunkId && Boolean(uniqueHunkReference(hunkIndex, hunkId)));
		const generationOrder = startOrder + findings.length;
		findings.push({
			id: `${primary.uri}#${primary.hunkId}#integration#${generationOrder}`,
			uri: primary.uri,
			relativePath: primary.relativePath,
			hunkId: primary.hunkId,
			line: primary.line,
			severity: candidate.severity,
			title: candidate.title,
			explanation: candidate.explanation,
			recommendation: candidate.recommendation,
			evidence,
			generationOrder,
			source: 'integration',
			relatedHunkIds,
			relatedPaths: uniqueStrings(candidate.relatedPaths),
		});
	}
	return {
		findings,
		diagnostics: { rawCount: result.findings.length, acceptedCount: findings.length, dropped },
	};
}

function buildHunkReferenceIndex(files: ReviewFileState[]): Map<string, ReviewHunkReference[]> {
	const index = new Map<string, ReviewHunkReference[]>();
	for (const file of files) {
		for (const hunk of file.hunks) {
			addHunkReference(index, hunk.id, { uri: file.uri.toString(), relativePath: file.relativePath, hunkId: hunk.id, line: hunk.newStart, hunk });
		}
		for (const hunk of [...file.acceptedHunks, ...file.rejectedHunks]) {
			const reference = { uri: file.uri.toString(), relativePath: file.relativePath, hunkId: hunk.id, line: hunk.displayStart, hunk };
			addHunkReference(index, hunk.id, reference);
			const original = originalReviewedHunkId(hunk.id);
			if (original !== hunk.id) {
				addHunkReference(index, original, { ...reference, hunkId: original });
			}
		}
	}
	return index;
}

function addHunkReference(index: Map<string, ReviewHunkReference[]>, hunkId: string, reference: ReviewHunkReference): void {
	const list = index.get(hunkId) ?? [];
	if (!list.some((item) => item.uri === reference.uri && item.hunkId === reference.hunkId)) {
		list.push(reference);
	}
	index.set(hunkId, list);
}

function uniqueHunkReference(index: Map<string, ReviewHunkReference[]>, hunkId: string): ReviewHunkReference | undefined {
	const matches = index.get(hunkId) ?? [];
	return matches.length === 1 ? matches[0] : undefined;
}

function rebaseFileFindings(file: ReviewFileState, findings: AiReviewFinding[], startOrder: number): AiReviewFinding[] {
	return findings.map((finding, index) => {
		const generationOrder = startOrder + index;
		return {
			...finding,
			id: file.uri.toString() + '#' + finding.hunkId + '#' + generationOrder,
			generationOrder,
		};
	});
}

function rebaseFileSuggestions(file: ReviewFileState, suggestions: AiReviewChunkSuggestion[], startOrder: number): AiReviewChunkSuggestion[] {
	return suggestions.map((suggestion, index) => {
		const generationOrder = startOrder + index;
		return {
			...suggestion,
			id: file.uri.toString() + '#' + suggestion.hunkId + '#suggestion#' + generationOrder,
			generationOrder,
		};
	});
}

function mergeFileAndIntegrationFindings(fileFindings: AiReviewFinding[], integrationFindings: AiReviewFinding[]): AiReviewFinding[] {
	const seen = new Set(fileFindings.map((finding) => findingDedupKey(finding)));
	const merged = [...fileFindings];
	for (const finding of integrationFindings) {
		const key = findingDedupKey(finding);
		if (!seen.has(key)) {
			seen.add(key);
			merged.push(finding);
		}
	}
	return merged;
}

function findingDedupKey(finding: Pick<AiReviewFinding, 'hunkId' | 'title'>): string {
	return `${finding.hunkId}#${finding.title.trim().toLocaleLowerCase()}`;
}

function stringValue(value: unknown, fallback: string): string {
	return typeof value === 'string' && value.trim() ? value : fallback;
}

function stringArray(value: unknown): string[] {
	return uniqueStrings(value);
}

function uniqueStrings(value: unknown): string[] {
	return Array.isArray(value)
		? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))]
		: [];
}

function stringRecord(value: unknown): Record<string, string> {
	const record: Record<string, string> = {};
	if (!isJsonObject(value)) {
		return record;
	}
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === 'string') {
			record[key] = item;
		}
	}
	return record;
}

function previewText(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function originalReviewedHunkId(hunkId: string): string {
	const match = /^(?:accept|reject)-\d+-(.+)$/.exec(hunkId);
	return match ? match[1] : hunkId;
}
function aiReviewRunLimits(maxRounds: number | 'unlimited' | undefined): {
	maxRounds: number | 'unlimited';
	maxRunMs: number;
} {
	if (maxRounds === 'unlimited') {
		return {
			maxRounds: 'unlimited',
			maxRunMs: 60 * 60 * 1000,
		};
	}
	const rounds = Math.max(1, Math.floor(maxRounds ?? 64));
	return {
		maxRounds: rounds,
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

function knowledgeRetrievalSystemPrompt(): string {
	return [
		'You are a source-grounded Knowledge Retrieval Agent for code review.',
		'Read relevant Wiki pages and use read-only source tools to verify a small number of claims against current code.',
		'Use search_wiki_files to locate relevant Wiki pages before reading only the pages needed for review.',
		'Current source code is authoritative; Wiki content is advisory context and may be stale.',
		'Never create review findings. Return claims as confirmed, conflicted, or unverified with current code evidence paths.',
		'When Wiki freshness is stale, keep using it only as low-confidence context and do not treat staleness alone as a finding.',
		'Finish with {"type":"final","result":{"summary":"...","relevantPages":["architecture.md"],"perFileHints":{"src/app.ts":"..."},"interfaceContracts":["..."],"workflowRisks":["..."],"knowledgeClaims":[{"page":"interfaces.md","claim":"...","status":"confirmed","evidencePaths":["src/api.ts"],"confidence":0.9}]}}.',
	].join('\n');
}

function knowledgeRetrievalUserPrompt(files: ReviewFileState[], freshness?: WikiFreshnessAssessment): string {
	return [
		'Retrieve Wiki context relevant to this pending change set.',
		'Pending changes:',
		changeSetSummary(files),
		'Controller freshness assessment:',
		JSON.stringify(freshness ?? unknownKnowledgeFreshness('Freshness was not provided.')),
		'Prefer index.md first, then read only pages relevant to review risks. Verify only a small number of key contracts in current source.',
	].join('\n');
}
function planningSystemPrompt(): string {
	return [
		'You are a source-grounded AI Review Planning Agent.',
		'Plan the review of the supplied pending changes. Use tools only when needed.',
		'Identify cross-file risks and per-file instructions. Keep the plan concise.',
		'Finish with {"type":"final","result":{"summary":"...","changeIntent":"...","riskAreas":["..."],"integrationChecks":["..."],"filePlans":{"src/app.ts":"..."}}}.',
	].join('\n');
}

function planningUserPrompt(files: ReviewFileState[], knowledgeContext: AiReviewKnowledgeContext): string {
	return [
		'Create an AI review plan for this pending change set.',
		'Pending changes:',
		changeSetSummary(files),
		'Knowledge context:',
		JSON.stringify(knowledgeContext),
		'Wiki freshness:',
		JSON.stringify(knowledgeContext.freshness),
		'Knowledge claims to verify:',
		JSON.stringify(knowledgeContext.claims),
	].join('\n');
}

function integrationSystemPrompt(language: AiReviewLanguage): string {
	return [
		'You are a source-grounded Integration Review Agent.',
		'Review the whole pending change set after file-level review. Look only for cross-file, cross-module, workflow, configuration, or contract risks missed by file review.',
		'Every finding must bind to one primary current hunkId. Put other affected hunk IDs in relatedHunkIds.',
		'Use current source evidence to confirm any Wiki conflict. Wiki staleness alone is not a finding.',
		'Do not return code suggestions. Do not duplicate existing file-level findings.',
		languageInstruction(language),
		'Finish with {"type":"final","result":{"findings":[{"hunkId":"primary-hunk","relatedHunkIds":["other-hunk"],"relatedPaths":["src/other.ts"],"severity":"warning","title":"...","explanation":"...","recommendation":"...","evidence":["path:line"]}]}}.',
	].join('\n');
}

function integrationUserPrompt(files: ReviewFileState[], fileFindings: AiReviewFinding[], knowledgeContext: AiReviewKnowledgeContext, plan: AiReviewPlan): string {
	return [
		'Run integration review for this pending change set.',
		'Pending changes:',
		changeSetSummary(files),
		'Existing file-level findings:',
		JSON.stringify(fileFindings.map((finding) => ({ hunkId: finding.hunkId, relativePath: finding.relativePath, severity: finding.severity, title: finding.title, explanation: finding.explanation }))),
		'Knowledge context:',
		JSON.stringify(knowledgeContext),
		'Wiki freshness:',
		JSON.stringify(knowledgeContext.freshness),
		'Knowledge claims to verify:',
		JSON.stringify(knowledgeContext.claims),
		'Review plan:',
		JSON.stringify(plan),
		'Return an empty findings array when no additional integration issue is supported by evidence.',
	].join('\n');
}

function reviewSystemPrompt(language: AiReviewLanguage, includeWikiTools: boolean, pipeline: AiReviewPipeline = 'fileOnly'): string {
	return [
		'You are a source-grounded Code Review Agent.',
		includeWikiTools
			? 'Review only the supplied pending hunks. Source and Wiki files are read-only.'
			: 'Review only the supplied pending hunks. Source files are read-only.',
		includeWikiTools
			? 'Use tools when needed to inspect callers, tests, configuration, and optional Wiki context.'
			: 'Use tools when needed to inspect callers, tests, and configuration.',
		'Report concrete correctness, reliability, security, or maintainability risks; avoid generic praise.',
		pipeline === 'multi' ? 'Use the supplied change-set plan and knowledge context as review guidance, but verify issues against source evidence.' : 'Focus on the supplied file while using tools for necessary context.',
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

function reviewUserPrompt(file: ReviewFileState, context?: ReviewPromptContext): string {
	const lines = [
		`Review all pending chunks in ${file.relativePath}.`,
		'Pending chunks:',
		JSON.stringify(file.hunks.map(hunkForPrompt)),
		'Return an empty findings array when no actionable issue is supported by evidence.',
	];
	if (context) {
		lines.push('Change-set summary:', context.changeSetSummary);
		lines.push('Knowledge context:', JSON.stringify(context.knowledgeContext));
		lines.push('Review plan:', JSON.stringify(context.plan));
		if (context.filePlan) {
			lines.push('Instructions for this file:', context.filePlan);
		}
	}
	return lines.join('\n');
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
		strategy: review.strategy,
		pipeline: review.pipeline,
		completedIntegration: review.completedIntegration,
		knowledgeContextSummary: review.knowledgeContextSummary,
		knowledgeFreshness: review.knowledgeFreshness,
		knowledgeClaims: review.knowledgeClaims ? [...review.knowledgeClaims] : undefined,
		knowledgeContext: review.knowledgeContext ? {
			...review.knowledgeContext,
			relevantPages: [...review.knowledgeContext.relevantPages],
			perFileHints: { ...review.knowledgeContext.perFileHints },
			interfaceContracts: [...review.knowledgeContext.interfaceContracts],
			workflowRisks: [...review.knowledgeContext.workflowRisks],
			claims: [...review.knowledgeContext.claims],
		} : undefined,
		planSummary: review.planSummary,
		reviewPlan: review.reviewPlan ? {
			...review.reviewPlan,
			riskAreas: [...review.reviewPlan.riskAreas],
			integrationChecks: [...review.reviewPlan.integrationChecks],
			filePlans: { ...review.reviewPlan.filePlans },
		} : undefined,
		continuations: review.continuations?.map((continuation) => ({
			...continuation,
			checkpoint: {
				...continuation.checkpoint,
				messages: continuation.checkpoint.messages.map((message) => ({
					...message,
					toolCalls: message.toolCalls?.map((call) => ({ ...call })),
				})),
			},
		})),
	};
}

function normalizeContinuations(value: unknown): AiReviewContinuation[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is AiReviewContinuation => {
		if (!isJsonObject(item) || !['knowledge', 'plan', 'file', 'integration'].includes(String(item.stage))) {
			return false;
		}
		const checkpoint = item.checkpoint;
		return isJsonObject(checkpoint)
			&& checkpoint.version === 1
			&& typeof checkpoint.nextRound === 'number'
			&& checkpoint.nextRound >= 1
			&& Array.isArray(checkpoint.messages)
			&& typeof checkpoint.toolCalls === 'number'
			&& typeof checkpoint.toolResultChars === 'number'
			&& typeof checkpoint.runFingerprint === 'string';
	}).map((item) => ({
		...item,
		fileUri: typeof item.fileUri === 'string' ? item.fileUri : undefined,
		checkpoint: {
			...item.checkpoint,
			nextRound: Math.floor(item.checkpoint.nextRound),
			toolCalls: Math.max(0, Math.floor(item.checkpoint.toolCalls)),
			toolResultChars: Math.max(0, Math.floor(item.checkpoint.toolResultChars)),
			messages: item.checkpoint.messages.map((message) => ({ ...message })),
		},
	}));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isContinuationIncompatibleError(error: unknown): boolean {
	return errorMessage(error).includes('AI review continuation is incompatible');
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
