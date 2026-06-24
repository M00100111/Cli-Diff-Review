export const agentsDirectoryName = '.agents';
export const skillsDirectoryName = 'skills';
export const wikiSkillDirectoryName = 'llm-code-wiki';
export const referencesDirectoryName = 'references';
export const wikiStateFileName = '.state.json';
export const wikiSkillFileName = 'SKILL.md';
export const wikiSchemaFileName = 'schema.md';
export const agentsGuidanceFileName = 'AGENTS.md';

export const wikiDirectoryPath = `${agentsDirectoryName}/${skillsDirectoryName}/${wikiSkillDirectoryName}`;
export const wikiReferencesPath = `${wikiDirectoryPath}/${referencesDirectoryName}`;
export const wikiStatePath = `${wikiDirectoryPath}/${wikiStateFileName}`;

export function isWikiPath(relativePath: string): boolean {
	return normalizeRepositoryPath(relativePath).startsWith(`${wikiDirectoryPath}/`);
}

export function isWikiStatePath(relativePath: string): boolean {
	return normalizeRepositoryPath(relativePath) === wikiStatePath;
}

export function isGeneratedAgentsGuidancePath(relativePath: string): boolean {
	return normalizeRepositoryPath(relativePath) === agentsGuidanceFileName;
}

export function normalizeRepositoryPath(relativePath: string): string {
	return relativePath.replace(/\\/g, '/');
}
