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
	content: string;
	reasoningContent?: string;
	toolCalls: LlmToolCall[];
}

export interface LlmClient {
	completeJson(request: LlmJsonRequest, signal?: AbortSignal): Promise<string>;
	complete?(request: LlmJsonRequest, signal?: AbortSignal): Promise<LlmCompletion>;
}

const providerFactories: Record<LlmProvider, (config: LlmRuntimeConfig) => LlmClient> = {
	openai: (config) => new OpenAiCompatibleClient(config.baseUrl, config.apiKey, fetch, config.jsonOutputEnabled ?? true),
	anthropic: (config) => new AnthropicClient(config.baseUrl, config.apiKey),
	deepseek: (config) => new DeepSeekClient(config.baseUrl, config.apiKey, config.thinkingMode ?? 'high', config.strictTools ?? true),
};

export function createLlmClient(config: LlmRuntimeConfig): LlmClient {
	return providerFactories[config.provider](config);
}

export async function completeLlm(client: LlmClient, request: LlmJsonRequest, signal?: AbortSignal): Promise<LlmCompletion> {
	if (client.complete) {
		return client.complete(request, signal);
	}
	return { content: await client.completeJson(request, signal), toolCalls: [] };
}

export class OpenAiCompatibleClient implements LlmClient {
	public constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string,
		private readonly fetchImpl: typeof fetch = fetch,
		private readonly jsonOutputEnabled = true,
	) {}

	public async completeJson(request: LlmJsonRequest, signal?: AbortSignal): Promise<string> {
		const completion = await this.complete(request, signal);
		if (!completion.content) {
			throw new Error('OpenAI-compatible response did not include message content.');
		}
		return completion.content;
	}

	public async complete(request: LlmJsonRequest, signal?: AbortSignal): Promise<LlmCompletion> {
		const body: Record<string, unknown> = {
			model: request.model,
			messages: requestMessages(request).map(openAiMessage),
			temperature: request.temperature ?? 0,
			max_tokens: request.maxTokens ?? 8192,
		};
		if (request.jsonOutput ?? this.jsonOutputEnabled) {
			body.response_format = { type: 'json_object' };
		}
		const response = await this.fetchImpl(endpoint(this.baseUrl, 'chat/completions'), requestInit(this.apiKey, body, signal));
		await ensureOk(
			response,
			'OpenAI-compatible',
			body.response_format ? 'This endpoint may not support response_format; disable JSON Output in the LLM configuration.' : undefined,
		);
		return parseOpenAiCompletion(await response.json() as unknown, 'OpenAI-compatible');
	}
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

export class AnthropicClient implements LlmClient {
	public constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	public async completeJson(request: LlmJsonRequest, signal?: AbortSignal): Promise<string> {
		const completion = await this.complete(request, signal);
		if (!completion.content) {
			throw new Error('Anthropic response did not include text content.');
		}
		return completion.content;
	}

	public async complete(request: LlmJsonRequest, signal?: AbortSignal): Promise<LlmCompletion> {
		const messages = requestMessages(request);
		const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
		const conversation = messages
			.filter((message) => message.role !== 'system')
			.map((message) => ({ role: message.role, content: message.content }));
		const response = await this.fetchImpl(endpoint(this.baseUrl, 'v1/messages'), {
			method: 'POST',
			headers: {
				'anthropic-version': '2023-06-01',
				'content-type': 'application/json',
				'x-api-key': this.apiKey,
			},
			body: JSON.stringify({
				model: request.model,
				system,
				messages: conversation,
				temperature: request.temperature ?? 0,
				max_tokens: request.maxTokens ?? 8192,
			}),
			signal,
		});
		await ensureOk(response, 'Anthropic');
		const payload = await response.json() as unknown;
		const content = isJsonObject(payload) && Array.isArray(payload.content)
			? payload.content
				.map((item) => isJsonObject(item) && item.type === 'text' && typeof item.text === 'string' ? item.text : '')
				.join('')
			: '';
		return { content, toolCalls: [] };
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
	throw new Error(`LLM request failed (${response.status}): ${detail || response.statusText}.${hint}`);
}

export function providerLabel(provider: LlmProvider): string {
	if (provider === 'anthropic') {
		return 'Anthropic';
	}
	return provider === 'deepseek' ? 'DeepSeek' : 'OpenAI-compatible';
}
