import * as vscode from 'vscode';

export type LlmProvider = 'openai' | 'anthropic' | 'deepseek';
export type LlmThinkingMode = 'disabled' | 'high' | 'max';

export interface LlmConfigInput {
	profileId?: string;
	provider: LlmProvider;
	baseUrl: string;
	model: string;
	apiKey?: string;
	jsonOutputEnabled?: boolean;
	thinkingMode?: LlmThinkingMode;
	strictTools?: boolean;
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

interface LlmPersistedProfile {
	id: string;
	provider: LlmProvider;
	baseUrl: string;
	model: string;
	jsonOutputEnabled: boolean;
	thinkingMode: LlmThinkingMode;
	strictTools: boolean;
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
		};
	}

	public async save(input: LlmConfigInput): Promise<LlmSavedConfig> {
		const store = await this.profileStore();
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
		let provider = this.providerFromValue(this.context.globalState.get<string>(providerKey)) ?? 'openai';
		const baseUrl = this.context.globalState.get<string>(baseUrlKey, '').trim();
		const model = this.context.globalState.get<string>(modelKey, '').trim();
		const legacyApiKey = (await this.context.secrets.get(apiKeySecretKey))?.trim();
		if (!baseUrl && !model && !legacyApiKey) {
			return undefined;
		}
		if (provider === 'openai' && isOfficialDeepSeekBaseUrl(baseUrl)) {
			provider = 'deepseek';
			await this.context.globalState.update(providerKey, provider);
		}
		return this.normalizeProfile({
			id: 'default',
			provider,
			baseUrl,
			model,
			jsonOutputEnabled: this.context.globalState.get<boolean>(jsonOutputKey, provider === 'openai'),
			thinkingMode: this.thinkingModeFromValue(this.context.globalState.get<string>(thinkingModeKey)) ?? 'disabled',
			strictTools: this.context.globalState.get<boolean>(strictToolsKey, provider === 'deepseek'),
		});
	}

	private savedConfigFromProfile(active: LlmConfigProfile | undefined, profiles: LlmConfigProfile[], activeProfileId: string | undefined): LlmSavedConfig {
		const fallback = this.normalizeProfile({
			id: '',
			provider: 'openai',
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
			id: candidate.id,
			provider,
			baseUrl: typeof candidate.baseUrl === 'string' ? candidate.baseUrl : '',
			model: typeof candidate.model === 'string' ? candidate.model : '',
			jsonOutputEnabled: typeof candidate.jsonOutputEnabled === 'boolean' ? candidate.jsonOutputEnabled : provider === 'openai',
			thinkingMode: this.thinkingModeFromValue(typeof candidate.thinkingMode === 'string' ? candidate.thinkingMode : undefined) ?? 'disabled',
			strictTools: typeof candidate.strictTools === 'boolean' ? candidate.strictTools : provider === 'deepseek',
		});
	}

	private normalizeProfile(profile: LlmPersistedProfile): LlmPersistedProfile {
		const provider = this.providerFromValue(profile.provider) ?? 'openai';
		return {
			id: profile.id.trim(),
			provider,
			baseUrl: profile.baseUrl.trim() || (provider === 'deepseek' ? 'https://api.deepseek.com' : ''),
			model: profile.model.trim(),
			jsonOutputEnabled: provider === 'deepseek' ? true : profile.jsonOutputEnabled,
			thinkingMode: provider === 'deepseek' ? this.thinkingModeFromValue(profile.thinkingMode) ?? 'high' : 'disabled',
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

function isOfficialDeepSeekBaseUrl(value: string): boolean {
	try {
		return new URL(value).hostname === 'api.deepseek.com';
	} catch {
		return false;
	}
}

function slug(value: string): string {
	return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}
