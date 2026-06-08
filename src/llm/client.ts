import { LlmProvider, LlmRuntimeConfig } from './config';
import { isJsonObject } from './json';

export interface LlmJsonRequest {
	systemPrompt: string;
	userPrompt: string;
	model: string;
	maxTokens?: number;
	temperature?: number;
}

export interface LlmClient {
	completeJson(request: LlmJsonRequest, signal?: AbortSignal): Promise<string>;
}

export function createLlmClient(config: LlmRuntimeConfig): LlmClient {
	if (config.provider === 'anthropic') {
		return new AnthropicClient(config.baseUrl, config.apiKey);
	}
	return new OpenAiCompatibleClient(config.baseUrl, config.apiKey);
}

export class OpenAiCompatibleClient implements LlmClient {
	public constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	public async completeJson(request: LlmJsonRequest, signal?: AbortSignal): Promise<string> {
		const response = await this.fetchImpl(endpoint(this.baseUrl, 'chat/completions'), {
			method: 'POST',
			headers: {
				authorization: `Bearer ${this.apiKey}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				model: request.model,
				messages: [
					{ role: 'system', content: request.systemPrompt },
					{ role: 'user', content: request.userPrompt },
				],
				temperature: request.temperature ?? 0,
				max_tokens: request.maxTokens ?? 8192,
			}),
			signal,
		});
		await ensureOk(response);
		const payload = await response.json() as unknown;
		const content = isJsonObject(payload)
			&& Array.isArray(payload.choices)
			&& isJsonObject(payload.choices[0])
			&& isJsonObject(payload.choices[0].message)
			&& typeof payload.choices[0].message.content === 'string'
			? payload.choices[0].message.content
			: undefined;
		if (!content) {
			throw new Error('OpenAI-compatible response did not include message content.');
		}
		return content;
	}
}

export class AnthropicClient implements LlmClient {
	public constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	public async completeJson(request: LlmJsonRequest, signal?: AbortSignal): Promise<string> {
		const response = await this.fetchImpl(endpoint(this.baseUrl, 'v1/messages'), {
			method: 'POST',
			headers: {
				'anthropic-version': '2023-06-01',
				'content-type': 'application/json',
				'x-api-key': this.apiKey,
			},
			body: JSON.stringify({
				model: request.model,
				system: request.systemPrompt,
				messages: [{ role: 'user', content: request.userPrompt }],
				temperature: request.temperature ?? 0,
				max_tokens: request.maxTokens ?? 8192,
			}),
			signal,
		});
		await ensureOk(response);
		const payload = await response.json() as unknown;
		const content = isJsonObject(payload) && Array.isArray(payload.content)
			? payload.content
				.map((item) => isJsonObject(item) && item.type === 'text' && typeof item.text === 'string' ? item.text : '')
				.join('')
			: '';
		if (!content) {
			throw new Error('Anthropic response did not include text content.');
		}
		return content;
	}
}

function endpoint(baseUrl: string, suffix: string): string {
	const trimmedBase = baseUrl.trim().replace(/\/+$/, '');
	const trimmedSuffix = suffix.replace(/^\/+/, '');
	return `${trimmedBase}/${trimmedSuffix}`;
}

async function ensureOk(response: Response): Promise<void> {
	if (response.ok) {
		return;
	}
	let detail = '';
	try {
		detail = await response.text();
	} catch {
		detail = response.statusText;
	}
	throw new Error(`LLM request failed (${response.status}): ${detail || response.statusText}`);
}

export function providerLabel(provider: LlmProvider): string {
	return provider === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible';
}
