import * as vscode from 'vscode';

export type LlmProvider = 'openai' | 'anthropic';

export interface LlmConfigInput {
	provider: LlmProvider;
	baseUrl: string;
	model: string;
	apiKey?: string;
}

export interface LlmSavedConfig {
	provider: LlmProvider;
	baseUrl: string;
	model: string;
	hasApiKey: boolean;
	configured: boolean;
}

export interface LlmRuntimeConfig {
	provider: LlmProvider;
	baseUrl: string;
	model: string;
	apiKey: string;
}

const providerKey = 'cliDiff.llm.provider';
const baseUrlKey = 'cliDiff.llm.baseUrl';
const modelKey = 'cliDiff.llm.model';
const apiKeySecretKey = 'cliDiff.llm.apiKey';

export class LlmConfigStore {
	public constructor(private readonly context: vscode.ExtensionContext) {}

	public async savedConfig(): Promise<LlmSavedConfig> {
		const provider = this.providerFromValue(this.context.globalState.get<string>(providerKey)) ?? 'openai';
		const baseUrl = this.context.globalState.get<string>(baseUrlKey, '').trim();
		const model = this.context.globalState.get<string>(modelKey, '').trim();
		const hasApiKey = Boolean((await this.context.secrets.get(apiKeySecretKey))?.trim());
		return {
			provider,
			baseUrl,
			model,
			hasApiKey,
			configured: Boolean(baseUrl && model && hasApiKey),
		};
	}

	public async runtimeConfig(): Promise<LlmRuntimeConfig | undefined> {
		const saved = await this.savedConfig();
		const apiKey = (await this.context.secrets.get(apiKeySecretKey))?.trim() ?? '';
		if (!saved.baseUrl || !saved.model || !apiKey) {
			return undefined;
		}
		return {
			provider: saved.provider,
			baseUrl: saved.baseUrl,
			model: saved.model,
			apiKey,
		};
	}

	public async save(input: LlmConfigInput): Promise<LlmSavedConfig> {
		const provider = this.providerFromValue(input.provider);
		if (!provider) {
			throw new Error('Select a supported LLM provider.');
		}
		const baseUrl = input.baseUrl.trim();
		const model = input.model.trim();
		const apiKey = input.apiKey?.trim() ?? '';
		if (!baseUrl || !model) {
			throw new Error('Base URL and model are required.');
		}

		await this.context.globalState.update(providerKey, provider);
		await this.context.globalState.update(baseUrlKey, baseUrl);
		await this.context.globalState.update(modelKey, model);
		if (apiKey) {
			await this.context.secrets.store(apiKeySecretKey, apiKey);
		}

		const hasApiKey = Boolean(apiKey || (await this.context.secrets.get(apiKeySecretKey))?.trim());
		if (!hasApiKey) {
			throw new Error('API key is required.');
		}

		return {
			provider,
			baseUrl,
			model,
			hasApiKey,
			configured: true,
		};
	}

	private providerFromValue(value: string | undefined): LlmProvider | undefined {
		if (value === 'openai' || value === 'anthropic') {
			return value;
		}
		return undefined;
	}
}
