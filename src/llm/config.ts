import * as vscode from 'vscode';

export type LlmProvider = 'deepseek' | 'glm';
export type LlmThinkingMode = 'disabled' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface LlmConfigInput {
	profileId?: string;
	provider: LlmProvider;
	baseUrl: string;
	model: string;
	apiKey?: string;
	jsonOutputEnabled?: boolean;
	thinkingMode?: LlmThinkingMode;
	strictTools?: boolean;
	contextWindowTokens?: number;
	compressionThresholdPercent?: number;
	maxOutputTokens?: number;
}

export interface LlmConfigProfile {
	id: string;
	provider: LlmProvider;
	baseUrl: string;
	model: string;
	hasApiKey: boolean;
	configured: boolean;
	jsonOutputEnabled: boolean;
	thinkingMode: LlmThinkingMode;
	strictTools: boolean;
	contextWindowTokens?: number;
	compressionThresholdPercent?: number;
	maxOutputTokens?: number;
}

export interface LlmSavedConfig extends Omit<LlmConfigProfile, 'id'> {
	activeProfileId?: string;
	profiles: LlmConfigProfile[];
}

export interface LlmRuntimeConfig {
	provider: LlmProvider;
	baseUrl: string;
	model: string;
	apiKey: string;
	jsonOutputEnabled?: boolean;
	thinkingMode?: LlmThinkingMode;
	strictTools?: boolean;
	contextWindowTokens?: number;
	compressionThresholdPercent?: number;
	maxOutputTokens?: number;
}

const providerKey = 'cliDiff.llm.provider';
const baseUrlKey = 'cliDiff.llm.baseUrl';
const modelKey = 'cliDiff.llm.model';
const jsonOutputKey = 'cliDiff.llm.jsonOutputEnabled';
const thinkingModeKey = 'cliDiff.llm.thinkingMode';
const strictToolsKey = 'cliDiff.llm.strictTools';
const apiKeySecretKey = 'cliDiff.llm.apiKey';
const profilesKey = 'cliDiff.llm.profiles';
const activeProfileKey = 'cliDiff.llm.activeProfileId';
const deepSeekBaseUrl = 'https://api.deepseek.com';
const glmBaseUrl = 'https://open.bigmodel.cn/api/coding/paas/v4';
const glmDefaultModel = 'glm-5.2';

interface LlmPersistedProfile {
	id: string;
	provider: LlmProvider;
	baseUrl: string;
	model: string;
	jsonOutputEnabled: boolean;
	thinkingMode: LlmThinkingMode;
	strictTools: boolean;
	contextWindowTokens?: number;
	compressionThresholdPercent?: number;
	maxOutputTokens?: number;
}

export class LlmConfigStore {
	public constructor(private readonly context: vscode.ExtensionContext) {}

	public async savedConfig(): Promise<LlmSavedConfig> {
		const store = await this.profileStore();
		const active = store.profiles.find((profile) => profile.id === store.activeProfileId);
		return this.savedConfigFromProfile(active, store.profiles, store.activeProfileId);
	}

	public async runtimeConfig(): Promise<LlmRuntimeConfig | undefined> {
		const saved = await this.savedConfig();
		if (!saved.activeProfileId) {
			return undefined;
		}
		const apiKey = (await this.context.secrets.get(profileSecretKey(saved.activeProfileId)))?.trim() ?? '';
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
			contextWindowTokens: saved.contextWindowTokens,
			compressionThresholdPercent: saved.compressionThresholdPercent,
			maxOutputTokens: saved.maxOutputTokens,
		};
	}

	public async save(input: LlmConfigInput): Promise<LlmSavedConfig> {
		const store = await this.profileStore();
		const provider = this.providerFromValue(input.provider);
		if (!provider) {
			throw new Error('Select a supported LLM provider.');
		}
		if (provider !== 'deepseek' && provider !== 'glm') { throw new Error('Only DeepSeek and GLM are supported.'); }
		if (input.contextWindowTokens !== undefined && (!Number.isSafeInteger(input.contextWindowTokens) || input.contextWindowTokens < 4096)) { throw new Error('Context window must be at least 4096 tokens when specified.'); }
		const threshold = input.compressionThresholdPercent ?? 40;
		const output = input.maxOutputTokens ?? Math.min(12000, input.contextWindowTokens ? Math.floor(input.contextWindowTokens / 4) : 12000);
		if (!Number.isFinite(threshold) || threshold < 10 || threshold > 90 || !Number.isSafeInteger(output) || output < 256 || (input.contextWindowTokens !== undefined && output >= input.contextWindowTokens)) { throw new Error('Invalid compression threshold or output allowance.'); }
		const baseUrl = input.baseUrl.trim() || defaultBaseUrl(provider);
		const model = input.model.trim() || defaultModel(provider);
		const apiKey = input.apiKey?.trim() ?? '';
		const jsonOutputEnabled = providerForcesJsonOutput(provider) ? true : input.jsonOutputEnabled ?? true;
		const thinkingMode = normalizeThinkingMode(provider, this.thinkingModeFromValue(input.thinkingMode));
		const strictTools = provider === 'deepseek' ? input.strictTools ?? true : false;
		if (!baseUrl || !model) {
			throw new Error('Base URL and model are required.');
		}

		const existingIndex = input.profileId ? store.profiles.findIndex((profile) => profile.id === input.profileId) : -1;
		if (input.profileId && existingIndex < 0) {
			throw new Error('The selected model configuration no longer exists.');
		}
		const id = input.profileId ?? this.createProfileId(provider, model, store.profiles);
		if (apiKey) {
			await this.context.secrets.store(profileSecretKey(id), apiKey);
		}
		const hasApiKey = Boolean(apiKey || (await this.context.secrets.get(profileSecretKey(id)))?.trim());
		if (!hasApiKey) {
			throw new Error('API key is required.');
		}

		const profile: LlmPersistedProfile = {
			id,
			provider,
			baseUrl,
			model,
			jsonOutputEnabled,
			thinkingMode,
			strictTools,
			contextWindowTokens: input.contextWindowTokens,
			compressionThresholdPercent: threshold,
			maxOutputTokens: output,
		};
		const profiles = [...store.persistedProfiles];
		if (existingIndex >= 0) {
			profiles[existingIndex] = profile;
		} else {
			profiles.push(profile);
		}
		await this.persistProfiles(profiles, id);
		return this.savedConfig();
	}

	public async selectProfile(profileId: string): Promise<LlmSavedConfig> {
		const store = await this.profileStore();
		if (!store.profiles.some((profile) => profile.id === profileId)) {
			throw new Error('The selected model configuration no longer exists.');
		}
		await this.context.globalState.update(activeProfileKey, profileId);
		return this.savedConfig();
	}

	public async deleteProfile(profileId: string): Promise<LlmSavedConfig> {
		const store = await this.profileStore();
		if (!store.profiles.some((profile) => profile.id === profileId)) {
			throw new Error('The selected model configuration no longer exists.');
		}
		await this.context.secrets.delete(profileSecretKey(profileId));
		const profiles = store.persistedProfiles.filter((profile) => profile.id !== profileId);
		const nextActive = store.activeProfileId === profileId ? profiles[0]?.id : store.activeProfileId;
		await this.persistProfiles(profiles, nextActive);
		return this.savedConfig();
	}

	private providerFromValue(value: string | undefined): LlmProvider | undefined {
		if (value === 'deepseek' || value === 'glm') {
			return value;
		}
		return undefined;
	}

	private thinkingModeFromValue(value: string | undefined): LlmThinkingMode | undefined {
		if (value === 'disabled' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') {
			return value;
		}
		return undefined;
	}

	private async profileStore(): Promise<{
		profiles: LlmConfigProfile[];
		persistedProfiles: LlmPersistedProfile[];
		activeProfileId?: string;
	}> {
		const rawProfiles = this.context.globalState.get<unknown>(profilesKey);
		let persistedProfiles = Array.isArray(rawProfiles)
			? rawProfiles.map((item) => this.profileFromValue(item)).filter((item): item is LlmPersistedProfile => Boolean(item))
			: [];
		let activeProfileId = this.context.globalState.get<string>(activeProfileKey);
		if (!Array.isArray(rawProfiles)) {
			const legacy = await this.legacyProfile();
			if (legacy) {
				persistedProfiles = [legacy];
				activeProfileId = legacy.id;
				const legacyApiKey = (await this.context.secrets.get(apiKeySecretKey))?.trim();
				if (legacyApiKey) {
					await this.context.secrets.store(profileSecretKey(legacy.id), legacyApiKey);
				}
			}
			await this.persistProfiles(persistedProfiles, activeProfileId);
		} else if (activeProfileId && !persistedProfiles.some((profile) => profile.id === activeProfileId)) {
			activeProfileId = persistedProfiles[0]?.id;
			await this.context.globalState.update(activeProfileKey, activeProfileId);
		}

		const profiles: LlmConfigProfile[] = [];
		for (const profile of persistedProfiles) {
			const hasApiKey = Boolean((await this.context.secrets.get(profileSecretKey(profile.id)))?.trim());
			profiles.push({
				...profile,
				hasApiKey,
				configured: Boolean(profile.baseUrl && profile.model && hasApiKey),
			});
		}
		return { profiles, persistedProfiles, activeProfileId };
	}

	private async legacyProfile(): Promise<LlmPersistedProfile | undefined> {
		const provider = this.providerFromValue(this.context.globalState.get<string>(providerKey));
		if (!provider) { return undefined; }
		const baseUrl = this.context.globalState.get<string>(baseUrlKey, '').trim();
		const model = this.context.globalState.get<string>(modelKey, '').trim();
		const legacyApiKey = (await this.context.secrets.get(apiKeySecretKey))?.trim();
		if (!baseUrl && !model && !legacyApiKey) {
			return undefined;
		}
		const storedThinkingMode = this.thinkingModeFromValue(this.context.globalState.get<string>(thinkingModeKey));
		return this.normalizeProfile({
			id: 'default',
			provider,
			baseUrl,
			model,
			jsonOutputEnabled: providerForcesJsonOutput(provider) ? true : this.context.globalState.get<boolean>(jsonOutputKey, true),
			thinkingMode: normalizeThinkingMode(provider, storedThinkingMode),
			strictTools: provider === 'deepseek' ? this.context.globalState.get<boolean>(strictToolsKey, true) : false,
		});
	}

	private savedConfigFromProfile(active: LlmConfigProfile | undefined, profiles: LlmConfigProfile[], activeProfileId: string | undefined): LlmSavedConfig {
		const fallback = this.normalizeProfile({
			id: '',
			provider: 'deepseek',
			baseUrl: '',
			model: '',
			jsonOutputEnabled: true,
			thinkingMode: 'disabled',
			strictTools: false,
		});
		const profile = active ?? { ...fallback, hasApiKey: false, configured: false };
		return {
			provider: profile.provider,
			baseUrl: profile.baseUrl,
			model: profile.model,
			hasApiKey: profile.hasApiKey,
			configured: profile.configured,
			jsonOutputEnabled: profile.jsonOutputEnabled,
			thinkingMode: profile.thinkingMode,
			strictTools: profile.strictTools,
			contextWindowTokens: profile.contextWindowTokens,
			compressionThresholdPercent: profile.compressionThresholdPercent,
			maxOutputTokens: profile.maxOutputTokens,
			activeProfileId,
			profiles,
		};
	}

	private profileFromValue(value: unknown): LlmPersistedProfile | undefined {
		if (!value || typeof value !== 'object') {
			return undefined;
		}
		const candidate = value as Record<string, unknown>;
		const provider = this.providerFromValue(typeof candidate.provider === 'string' ? candidate.provider : undefined);
		if (!provider || typeof candidate.id !== 'string') {
			return undefined;
		}
		return this.normalizeProfile({
			contextWindowTokens: typeof candidate.contextWindowTokens === 'number' ? candidate.contextWindowTokens : undefined,
			compressionThresholdPercent: typeof candidate.compressionThresholdPercent === 'number' ? candidate.compressionThresholdPercent : 40,
			maxOutputTokens: typeof candidate.maxOutputTokens === 'number' ? candidate.maxOutputTokens : 12000,
			id: candidate.id,
			provider,
			baseUrl: typeof candidate.baseUrl === 'string' ? candidate.baseUrl : '',
			model: typeof candidate.model === 'string' ? candidate.model : '',
			jsonOutputEnabled: typeof candidate.jsonOutputEnabled === 'boolean' ? candidate.jsonOutputEnabled : true,
			thinkingMode: this.thinkingModeFromValue(typeof candidate.thinkingMode === 'string' ? candidate.thinkingMode : undefined) ?? 'disabled',
			strictTools: typeof candidate.strictTools === 'boolean' ? candidate.strictTools : provider === 'deepseek',
		});
	}

	private normalizeProfile(profile: LlmPersistedProfile): LlmPersistedProfile {
		const provider = this.providerFromValue(profile.provider) ?? 'deepseek';
		return {
			contextWindowTokens: profile.contextWindowTokens,
			compressionThresholdPercent: profile.compressionThresholdPercent ?? 40,
			maxOutputTokens: profile.maxOutputTokens ?? 12000,
			id: profile.id.trim(),
			provider,
			baseUrl: profile.baseUrl.trim() || defaultBaseUrl(provider),
			model: profile.model.trim() || defaultModel(provider),
			jsonOutputEnabled: providerForcesJsonOutput(provider) ? true : profile.jsonOutputEnabled,
			thinkingMode: normalizeThinkingMode(provider, this.thinkingModeFromValue(profile.thinkingMode)),
			strictTools: provider === 'deepseek' ? profile.strictTools : false,
		};
	}

	private async persistProfiles(profiles: LlmPersistedProfile[], activeProfileId: string | undefined): Promise<void> {
		await this.context.globalState.update(profilesKey, profiles);
		await this.context.globalState.update(activeProfileKey, activeProfileId);
	}

	private createProfileId(provider: LlmProvider, model: string, profiles: LlmPersistedProfile[]): string {
		const base = `${provider}-${slug(model) || 'model'}`;
		let id = base;
		let suffix = 2;
		while (profiles.some((profile) => profile.id === id)) {
			id = `${base}-${suffix++}`;
		}
		return id;
	}
}

function profileSecretKey(profileId: string): string {
	return `cliDiff.llm.profile.${profileId}.apiKey`;
}

function providerForcesJsonOutput(provider: LlmProvider): boolean {
	return provider === 'deepseek' || provider === 'glm';
}

function normalizeThinkingMode(provider: LlmProvider, value: LlmThinkingMode | undefined): LlmThinkingMode {
	if (provider === 'deepseek') {
		return value === 'disabled' || value === 'max' ? value : 'high';
	}
	if (provider === 'glm') {
		return value ?? 'high';
	}
	return 'disabled';
}

function defaultBaseUrl(provider: LlmProvider): string {
	if (provider === 'deepseek') {
		return deepSeekBaseUrl;
	}
	if (provider === 'glm') {
		return glmBaseUrl;
	}
	return '';
}

function defaultModel(provider: LlmProvider): string {
	return provider === 'glm' ? glmDefaultModel : '';
}

function slug(value: string): string {
	return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}
