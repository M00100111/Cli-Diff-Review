export type StrictJsonObject = Record<string, unknown>;

export function parseStrictJsonObject(text: string): StrictJsonObject {
	const value = JSON.parse(text) as unknown;
	if (!isJsonObject(value)) {
		throw new Error('LLM response must be a JSON object.');
	}
	return value;
}

export function isJsonObject(value: unknown): value is StrictJsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
