import * as vscode from 'vscode';

export type LlmProvider = 'openai' | 'anthropic' | 'deepseek';
export type LlmThinkingMode = 'disabled' | 'high' | 'max';

export interface LlmConfigInput {
	provider: LlmProvider;
	baseUrl: string;
	model: string;
	apiKey?: string;
	jsonOutputEnabled?: boolean;
	thinkingMode?: LlmThinkingMode;
	strictTools?: boolean;
}

export interface LlmSavedConfig {
	provider: LlmProvider;
	baseUrl: string;
	model: string;
	hasApiKey: boolean;
	configured: boolean;
	jsonOutputEnabled: boolean;
	thinkingMode: LlmThinkingMode;
	strictTools: boolean;
}

export interface LlmRuntimeConfig {
	provider: LlmProvider;
	baseUrl: string;
	model: string;
	apiKey: string;
	jsonOutputEnabled?: boolean;
	thinkingMode?: LlmThinkingMode;
	strictTools?: boolean;
}

const providerKey = 'cliDiff.llm.provider';
const baseUrlKey = 'cliDiff.llm.baseUrl';
const modelKey = 'cliDiff.llm.model';
const jsonOutputKey = 'cliDiff.llm.jsonOutputEnabled';
const thinkingModeKey = 'cliDiff.llm.thinkingMode';
const strictToolsKey = 'cliDiff.llm.strictTools';
const apiKeySecretKey = 'cliDiff.llm.apiKey';

export class LlmConfigStore {
	public constructor(private readonly context: vscode.ExtensionContext) {}

	public async savedConfig(): Promise<LlmSavedConfig> {
		let provider = this.providerFromValue(this.context.globalState.get<string>(providerKey)) ?? 'openai';
		const baseUrl = this.context.globalState.get<string>(baseUrlKey, '').trim();
		if (provider === 'openai' && isOfficialDeepSeekBaseUrl(baseUrl)) {
			provider = 'deepseek';
			await this.context.globalState.update(providerKey, provider);
		}
		const model = this.context.globalState.get<string>(modelKey, '').trim();
		const jsonOutputEnabled = provider === 'deepseek'
			? true
			: this.context.globalState.get<boolean>(jsonOutputKey, provider === 'openai');
		const thinkingMode = provider === 'deepseek'
			? this.thinkingModeFromValue(this.context.globalState.get<string>(thinkingModeKey)) ?? 'high'
			: 'disabled';
		const strictTools = provider === 'deepseek'
			? this.context.globalState.get<boolean>(strictToolsKey, true)
			: false;
		const hasApiKey = Boolean((await this.context.secrets.get(apiKeySecretKey))?.trim());
		return {
			provider,
			baseUrl,
			model,
			hasApiKey,
			configured: Boolean(baseUrl && model && hasApiKey),
			jsonOutputEnabled,
			thinkingMode,
			strictTools,
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
			jsonOutputEnabled: saved.jsonOutputEnabled,
			thinkingMode: saved.thinkingMode,
			strictTools: saved.strictTools,
		};
	}

	public async save(input: LlmConfigInput): Promise<LlmSavedConfig> {
		const provider = this.providerFromValue(input.provider);
		if (!provider) {
			throw new Error('Select a supported LLM provider.');
		}
		const baseUrl = input.baseUrl.trim() || (provider === 'deepseek' ? 'https://api.deepseek.com' : '');
		const model = input.model.trim();
		const apiKey = input.apiKey?.trim() ?? '';
		const jsonOutputEnabled = provider === 'deepseek' ? true : input.jsonOutputEnabled ?? provider === 'openai';
		const thinkingMode = provider === 'deepseek'
			? this.thinkingModeFromValue(input.thinkingMode) ?? 'high'
			: 'disabled';
		const strictTools = provider === 'deepseek' ? input.strictTools ?? true : false;
		if (!baseUrl || !model) {
			throw new Error('Base URL and model are required.');
		}

		await this.context.globalState.update(providerKey, provider);
		await this.context.globalState.update(baseUrlKey, baseUrl);
		await this.context.globalState.update(modelKey, model);
		await this.context.globalState.update(jsonOutputKey, jsonOutputEnabled);
		await this.context.globalState.update(thinkingModeKey, thinkingMode);
		await this.context.globalState.update(strictToolsKey, strictTools);
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
			jsonOutputEnabled,
			thinkingMode,
			strictTools,
		};
	}

	private providerFromValue(value: string | undefined): LlmProvider | undefined {
		if (value === 'openai' || value === 'anthropic' || value === 'deepseek') {
			return value;
		}
		return undefined;
	}

	private thinkingModeFromValue(value: string | undefined): LlmThinkingMode | undefined {
		if (value === 'disabled' || value === 'high' || value === 'max') {
			return value;
		}
		return undefined;
	}
}

function isOfficialDeepSeekBaseUrl(value: string): boolean {
	try {
		return new URL(value).hostname === 'api.deepseek.com';
	} catch {
		return false;
	}
}
