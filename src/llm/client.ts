import { LlmProvider, LlmRuntimeConfig, LlmThinkingMode } from './config';
import { isJsonObject } from './json';

export interface LlmJsonRequest {
	systemPrompt?: string;
	userPrompt?: string;
	messages?: LlmMessage[];
	model: string;
	maxTokens?: number;
	temperature?: number;
	jsonOutput?: boolean;
	tools?: LlmToolDefinition[];
}

export interface LlmMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	reasoningContent?: string;
	toolCalls?: LlmToolCall[];
	toolCallId?: string;
}

export interface LlmToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface LlmToolCall {
	id: string;
	name: string;
	arguments: string;
}

export interface LlmCompletion {
	usage?: { inputTokens: number; outputTokens: number };
	content: string;
	reasoningContent?: string;
	toolCalls: LlmToolCall[];
}

export interface LlmClient {
	completeJson(request: LlmJsonRequest, signal?: AbortSignal): Promise<string>;
	complete?(request: LlmJsonRequest, signal?: AbortSignal): Promise<LlmCompletion>;
}

const providerFactories: Record<LlmProvider, (config: LlmRuntimeConfig) => LlmClient> = {
	deepseek: (config) => new DeepSeekClient(config.baseUrl, config.apiKey, config.thinkingMode ?? 'high', config.strictTools ?? true),
	glm: (config) => new GlmClient(config.baseUrl, config.apiKey, config.thinkingMode ?? 'high'),
};

export function createLlmClient(config: LlmRuntimeConfig): LlmClient {
	const factory = providerFactories[config.provider];
	if (!factory) { throw new Error('Only DeepSeek and GLM are supported.'); }
	return factory(config);
}

export async function completeLlm(client: LlmClient, request: LlmJsonRequest, signal?: AbortSignal): Promise<LlmCompletion> {
	if (client.complete) {
		return client.complete(request, signal);
	}
	return { content: await client.completeJson(request, signal), toolCalls: [] };
}

export class DeepSeekClient implements LlmClient {
	public constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string,
		private readonly thinkingMode: LlmThinkingMode = 'high',
		private readonly strictTools = true,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	public async completeJson(request: LlmJsonRequest, signal?: AbortSignal): Promise<string> {
		const completion = await this.complete(request, signal);
		if (!completion.content) {
			throw new Error('DeepSeek response did not include final JSON content.');
		}
		return completion.content;
	}

	public async complete(request: LlmJsonRequest, signal?: AbortSignal): Promise<LlmCompletion> {
		const body: Record<string, unknown> = {
			model: request.model,
			messages: requestMessages(request).map(openAiMessage),
			max_tokens: request.maxTokens ?? 8192,
			response_format: { type: 'json_object' },
			thinking: { type: this.thinkingMode === 'disabled' ? 'disabled' : 'enabled' },
		};
		if (this.thinkingMode === 'disabled') {
			body.temperature = request.temperature ?? 0;
		} else {
			body.reasoning_effort = this.thinkingMode;
		}
		if (request.tools?.length) {
			body.tools = request.tools.map((tool) => ({
				type: 'function',
				function: {
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
					...(this.strictTools ? { strict: true } : {}),
				},
			}));
		}
		const response = await this.fetchImpl(deepSeekEndpoint(this.baseUrl, this.strictTools), requestInit(this.apiKey, body, signal));
		await ensureOk(
			response,
			'DeepSeek',
			this.strictTools ? 'This endpoint may not support DeepSeek Strict Tools Beta; disable Strict Tools or use the official DeepSeek Base URL.' : undefined,
		);
		return parseOpenAiCompletion(await response.json() as unknown, 'DeepSeek');
	}
}

export class GlmClient implements LlmClient {
	public constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string,
		private readonly thinkingMode: LlmThinkingMode = 'high',
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	public async completeJson(request: LlmJsonRequest, signal?: AbortSignal): Promise<string> {
		const completion = await this.complete(request, signal);
		if (!completion.content) {
			throw new Error('GLM response did not include final JSON content.');
		}
		return completion.content;
	}

	public async complete(request: LlmJsonRequest, signal?: AbortSignal): Promise<LlmCompletion> {
		const body: Record<string, unknown> = {
			model: request.model,
			messages: requestMessages(request).map(openAiMessage),
			max_tokens: request.maxTokens ?? 8192,
			response_format: { type: 'json_object' },
			thinking: { type: this.thinkingMode === 'disabled' ? 'disabled' : 'enabled' },
		};
		if (this.thinkingMode === 'disabled') {
			body.temperature = request.temperature ?? 0;
		} else {
			body.reasoning_effort = this.thinkingMode;
		}
		if (request.tools?.length) {
			body.tools = request.tools.map((tool) => ({
				type: 'function',
				function: {
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				},
			}));
			body.tool_choice = 'auto';
		}
		const response = await this.fetchImpl(endpoint(this.baseUrl, 'chat/completions'), requestInit(this.apiKey, body, signal));
		await ensureOk(response, 'GLM');
		return parseOpenAiCompletion(await response.json() as unknown, 'GLM');
	}
}

function requestMessages(request: LlmJsonRequest): LlmMessage[] {
	if (request.messages?.length) {
		return request.messages;
	}
	if (typeof request.systemPrompt !== 'string' || typeof request.userPrompt !== 'string') {
		throw new Error('LLM request must include messages or systemPrompt and userPrompt.');
	}
	return [
		{ role: 'system', content: request.systemPrompt },
		{ role: 'user', content: request.userPrompt },
	];
}

function openAiMessage(message: LlmMessage): Record<string, unknown> {
	return {
		role: message.role,
		content: message.content,
		...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
		...(message.toolCalls?.length ? {
			tool_calls: message.toolCalls.map((call) => ({
				id: call.id,
				type: 'function',
				function: { name: call.name, arguments: call.arguments },
			})),
		} : {}),
		...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
	};
}

function parseOpenAiCompletion(payload: unknown, provider: string): LlmCompletion {
	const message = isJsonObject(payload)
		&& Array.isArray(payload.choices)
		&& isJsonObject(payload.choices[0])
		&& isJsonObject(payload.choices[0].message)
		? payload.choices[0].message
		: undefined;
	if (!message) {
		throw new Error(`${provider} response did not include a message.`);
	}
	const toolCalls = Array.isArray(message.tool_calls)
		? message.tool_calls.map((call): LlmToolCall | undefined => {
			if (!isJsonObject(call) || typeof call.id !== 'string' || !isJsonObject(call.function)
				|| typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string') {
				return undefined;
			}
			return { id: call.id, name: call.function.name, arguments: call.function.arguments };
		}).filter((call): call is LlmToolCall => Boolean(call))
		: [];
	return {
		usage: isJsonObject(payload) && isJsonObject(payload.usage) && typeof payload.usage.prompt_tokens === 'number' && typeof payload.usage.completion_tokens === 'number' ? { inputTokens: payload.usage.prompt_tokens, outputTokens: payload.usage.completion_tokens } : undefined,
		content: typeof message.content === 'string' ? message.content : '',
		reasoningContent: typeof message.reasoning_content === 'string' ? message.reasoning_content : undefined,
		toolCalls,
	};
}

function requestInit(apiKey: string, body: Record<string, unknown>, signal?: AbortSignal): RequestInit {
	return {
		method: 'POST',
		headers: {
			authorization: `Bearer ${apiKey}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify(body),
		signal,
	};
}

function endpoint(baseUrl: string, suffix: string): string {
	const trimmedBase = baseUrl.trim().replace(/\/+$/, '');
	const trimmedSuffix = suffix.replace(/^\/+/, '');
	return `${trimmedBase}/${trimmedSuffix}`;
}

function deepSeekEndpoint(baseUrl: string, strictTools: boolean): string {
	const trimmedBase = baseUrl.trim().replace(/\/+$/, '');
	if (!strictTools || trimmedBase.endsWith('/beta')) {
		return endpoint(trimmedBase, 'chat/completions');
	}
	return endpoint(trimmedBase, 'beta/chat/completions');
}

async function ensureOk(response: Response, provider: string, capabilityHint?: string): Promise<void> {
	if (response.ok) {
		return;
	}
	let detail = '';
	try {
		detail = await response.text();
	} catch {
		detail = response.statusText;
	}
	const hint = response.status >= 400 && response.status < 500
		? ` ${capabilityHint ?? `Check whether ${provider} supports the configured JSON output, thinking, and tool-call options.`}`
		: '';
	throw new LlmApiError(response.status, detail || response.statusText, hint, response.headers.get('retry-after'));
}

export function providerLabel(provider: LlmProvider): string { return provider === 'deepseek' ? 'DeepSeek' : 'GLM'; }

export class LlmApiError extends Error {
 public readonly code?: string;
 public readonly errorType?: string;
 public readonly contextExceeded: boolean;
 public readonly retryable: boolean;
 public constructor(public readonly status: number, public readonly detail: string, hint = '', public readonly retryAfter: string | null = null) {
  super(`LLM request failed (${status}): ${detail}.${hint}`);
  this.name = 'LlmApiError';
  try { const data = JSON.parse(detail); this.code = data.error?.code; this.errorType = data.error?.type; } catch { /* preserve unknown error verbatim */ }
  this.contextExceeded = this.code === 'context_length_exceeded' || this.errorType === 'context_length_exceeded';
  this.retryable = status === 408 || status === 429 || status >= 500;
 }
}
