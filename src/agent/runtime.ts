import { completeLlm, LlmClient, LlmCompletion, LlmMessage, LlmToolCall, LlmToolDefinition } from '../llm/client';
import { LlmRuntimeConfig } from '../llm/config';
import { isJsonObject, parseStrictJsonObject } from '../llm/json';
import { throwIfAborted } from '../wiki/cancellation';

export interface AgentTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	execute(argumentsValue: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export interface AgentProgress {
	message: string;
	round: number;
	toolCalls: number;
}

export interface AgentRunOptions {
	config: LlmRuntimeConfig;
	client: LlmClient;
	systemPrompt: string;
	userPrompt: string;
	tools: AgentTool[];
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	maxRounds?: number;
	maxToolCalls?: number;
	maxToolResultChars?: number;
	maxContextChars?: number;
	maxRunMs?: number;
}

export interface AgentRunResult {
	result: Record<string, unknown>;
	rounds: number;
	toolCalls: number;
}

interface AgentToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

type AgentResponse =
	| { type: 'tool_calls'; calls: AgentToolCall[] }
	| { type: 'final'; result: Record<string, unknown> };

const protocolPrompt = [
	'You are operating inside a controlled local code agent runtime.',
	'Return only one strict JSON object per response. Do not use markdown fences or prose outside JSON.',
	'To use tools return: {"type":"tool_calls","calls":[{"id":"call-1","name":"tool_name","arguments":{}}]}.',
	'When complete return: {"type":"final","result":{}}.',
	'Use only the listed tools. Never invent tool results.',
].join('\n');

const deepSeekProtocolPrompt = [
	'You are operating inside a controlled local code agent runtime.',
	'Use the provided native function tools when you need workspace or Wiki information. Never simulate a tool call in text JSON.',
	'When complete, return only this JSON shape: {"type":"final","result":{}}.',
	'The final content must be one strict JSON object with no markdown fences or prose outside JSON.',
].join('\n');

export class AgentRunner {
	public async run(options: AgentRunOptions): Promise<AgentRunResult> {
		const maxRounds = options.maxRounds ?? 12;
		const maxToolCalls = options.maxToolCalls ?? 40;
		const maxToolResultChars = options.maxToolResultChars ?? 300000;
		const maxContextChars = options.maxContextChars ?? 800000;
		const maxRunMs = options.maxRunMs ?? 5 * 60 * 1000;
		const startedAt = Date.now();
		const runAbortController = new AbortController();
		let timedOut = false;
		const abortFromCaller = () => runAbortController.abort();
		if (options.signal?.aborted) {
			runAbortController.abort();
		} else {
			options.signal?.addEventListener('abort', abortFromCaller, { once: true });
		}
		const timeout = setTimeout(() => {
			timedOut = true;
			runAbortController.abort();
		}, maxRunMs);
		timeout.unref();
		const signal = runAbortController.signal;
		const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
		const nativeTools = options.config.provider === 'deepseek';
		const messages: LlmMessage[] = [
			{ role: 'system', content: `${nativeTools ? deepSeekProtocolPrompt : protocolPrompt}\n\n${options.systemPrompt}\n\nAvailable tools:\n${toolDescriptions(options.tools)}` },
			{ role: 'user', content: options.userPrompt },
		];
		let toolCalls = 0;
		let toolResultChars = 0;

		try {
			for (let round = 1; round <= maxRounds; round += 1) {
				throwIfAborted(signal);
				if (Date.now() - startedAt > maxRunMs) {
					throw new Error('Agent exceeded its runtime limit.');
				}
				if (messages.reduce((total, message) => total + message.content.length, 0) > maxContextChars) {
					throw new Error('Agent exceeded its accumulated context limit.');
				}
				options.onProgress?.({ message: `Agent round ${round}`, round, toolCalls });
				const response = await requestAgentRound(options, messages, nativeTools, signal);
				throwIfAborted(signal);
				if (response.type === 'final') {
					messages.push({ role: 'assistant', content: response.content, reasoningContent: response.reasoningContent });
					return { result: response.result, rounds: round, toolCalls };
				}

				if (toolCalls + response.calls.length > maxToolCalls) {
					throw new Error('Agent exceeded its tool call limit.');
				}
				const results: Array<{ id: string; name: string; ok: boolean; result?: unknown; error?: string }> = [];
				for (const call of response.calls) {
					throwIfAborted(signal);
					const tool = tools.get(call.name);
					if (!tool) {
						throw new Error(`Agent requested an unavailable tool: ${call.name}`);
					}
					options.onProgress?.({ message: `Running ${call.name}`, round, toolCalls });
					try {
						results.push({ id: call.id, name: call.name, ok: true, result: await tool.execute(call.arguments, signal) });
					} catch (error) {
						results.push({ id: call.id, name: call.name, ok: false, error: error instanceof Error ? error.message : String(error) });
					}
					toolCalls += 1;
				}
				const content = JSON.stringify({ type: 'tool_results', results });
				toolResultChars += content.length;
				if (toolResultChars > maxToolResultChars) {
					throw new Error('Agent exceeded its tool result context limit.');
				}
				if (nativeTools) {
					messages.push({
						role: 'assistant',
						content: response.content,
						reasoningContent: response.reasoningContent,
						toolCalls: response.nativeToolCalls,
					});
					for (const result of results) {
						messages.push({ role: 'tool', toolCallId: result.id, content: JSON.stringify(result) });
					}
				} else {
					messages.push({ role: 'assistant', content: response.content });
					messages.push({ role: 'user', content });
				}
			}
			throw new Error('Agent exceeded its round limit.');
		} catch (error) {
			if (timedOut) {
				throw new Error('Agent exceeded its runtime limit.');
			}
			throw error;
		} finally {
			clearTimeout(timeout);
			options.signal?.removeEventListener('abort', abortFromCaller);
		}
	}
}

export function validateAgentResponse(value: unknown): AgentResponse {
	if (!isJsonObject(value) || (value.type !== 'tool_calls' && value.type !== 'final')) {
		throw new Error('Agent response must be a tool_calls or final JSON object.');
	}
	if (value.type === 'final') {
		if (!isJsonObject(value.result)) {
			throw new Error('Agent final result must be a JSON object.');
		}
		return { type: 'final', result: value.result };
	}
	if (!Array.isArray(value.calls) || value.calls.length === 0) {
		throw new Error('Agent tool_calls response must include calls.');
	}
	const ids = new Set<string>();
	const calls = value.calls.map((call): AgentToolCall => {
		if (!isJsonObject(call) || typeof call.id !== 'string' || !call.id || typeof call.name !== 'string' || !call.name || !isJsonObject(call.arguments)) {
			throw new Error('Agent tool call must include id, name, and arguments.');
		}
		if (ids.has(call.id)) {
			throw new Error(`Duplicate agent tool call id: ${call.id}`);
		}
		ids.add(call.id);
		return { id: call.id, name: call.name, arguments: call.arguments };
	});
	return { type: 'tool_calls', calls };
}

function toolDescriptions(tools: AgentTool[]): string {
	return tools.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n');
}

type ValidAgentRound =
	| { type: 'tool_calls'; calls: AgentToolCall[]; nativeToolCalls?: LlmToolCall[]; content: string; reasoningContent?: string }
	| { type: 'final'; result: Record<string, unknown>; content: string; reasoningContent?: string };

async function requestAgentRound(
	options: AgentRunOptions,
	messages: LlmMessage[],
	nativeTools: boolean,
	signal: AbortSignal,
): Promise<ValidAgentRound> {
	let failure: unknown;
	let preview = '';
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const correction = attempt === 0 ? [] : [{
			role: 'user' as const,
			content: nativeTools
				? 'Your previous response was invalid. Use a provided native function tool, or return only valid JSON exactly shaped as {"type":"final","result":{}}.'
				: 'Your previous response was invalid. Return only valid JSON matching either the tool_calls or final JSON example from the system prompt.',
		}];
		const completion = await completeLlm(options.client, {
			model: options.config.model,
			messages: [...messages, ...correction],
			temperature: 0,
			maxTokens: 12000,
			jsonOutput: options.config.provider === 'deepseek' ? true : options.config.jsonOutputEnabled,
			tools: nativeTools ? toolDefinitions(options.tools) : undefined,
		}, signal);
		preview = (completion.content || JSON.stringify(completion.toolCalls)).slice(0, 240);
		try {
			return nativeTools ? validateNativeRound(completion, options.tools) : validateTextRound(completion);
		} catch (error) {
			failure = error;
		}
	}
	const reason = failure instanceof Error ? failure.message : String(failure);
	throw new Error(`${providerName(options.config.provider)} model "${options.config.model}" did not return valid Agent JSON after one correction retry: ${reason}. Response preview: ${preview || '<empty>'}`);
}

function validateTextRound(completion: LlmCompletion): ValidAgentRound {
	if (!completion.content) {
		throw new Error('Model returned empty content.');
	}
	const response = validateAgentResponse(parseStrictJsonObject(completion.content));
	return response.type === 'final'
		? { ...response, content: completion.content, reasoningContent: completion.reasoningContent }
		: { ...response, content: completion.content, reasoningContent: completion.reasoningContent };
}

function validateNativeRound(completion: LlmCompletion, tools: AgentTool[]): ValidAgentRound {
	if (completion.toolCalls.length > 0) {
		const available = new Map(tools.map((tool) => [tool.name, tool]));
		const calls = completion.toolCalls.map((call): AgentToolCall => {
			const argumentsValue = parseStrictJsonObject(call.arguments);
			const tool = available.get(call.name);
			if (!tool) {
				throw new Error(`DeepSeek requested an unavailable native tool: ${call.name}`);
			}
			validateToolArguments(tool, argumentsValue);
			return { id: call.id, name: call.name, arguments: argumentsValue };
		});
		return {
			type: 'tool_calls',
			calls,
			nativeToolCalls: completion.toolCalls,
			content: completion.content,
			reasoningContent: completion.reasoningContent,
		};
	}
	if (!completion.content) {
		throw new Error('Model returned neither native tool calls nor final content.');
	}
	const response = validateAgentResponse(parseStrictJsonObject(completion.content));
	if (response.type !== 'final') {
		throw new Error('DeepSeek must use native function tools instead of a textual tool_calls action.');
	}
	return { ...response, content: completion.content, reasoningContent: completion.reasoningContent };
}

function toolDefinitions(tools: AgentTool[]): LlmToolDefinition[] {
	return tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
}

function providerName(provider: LlmRuntimeConfig['provider']): string {
	return provider === 'deepseek' ? 'DeepSeek' : provider === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible';
}

function validateToolArguments(tool: AgentTool, argumentsValue: Record<string, unknown>): void {
	const properties = isJsonObject(tool.parameters.properties) ? tool.parameters.properties : {};
	const required = Array.isArray(tool.parameters.required)
		? tool.parameters.required.filter((name): name is string => typeof name === 'string')
		: [];
	for (const name of required) {
		if (!(name in argumentsValue)) {
			throw new Error(`Native tool ${tool.name} is missing required argument: ${name}`);
		}
	}
	if (tool.parameters.additionalProperties === false) {
		for (const name of Object.keys(argumentsValue)) {
			if (!(name in properties)) {
				throw new Error(`Native tool ${tool.name} received unexpected argument: ${name}`);
			}
		}
	}
	for (const [name, value] of Object.entries(argumentsValue)) {
		const schema = isJsonObject(properties[name]) ? properties[name] : undefined;
		if (!schema) {
			continue;
		}
		if (schema.type === 'string' && typeof value !== 'string') {
			throw new Error(`Native tool ${tool.name} argument ${name} must be a string.`);
		}
		if ((schema.type === 'integer' || schema.type === 'number') && (typeof value !== 'number' || !Number.isFinite(value))) {
			throw new Error(`Native tool ${tool.name} argument ${name} must be a number.`);
		}
		if (schema.type === 'integer' && typeof value === 'number' && !Number.isInteger(value)) {
			throw new Error(`Native tool ${tool.name} argument ${name} must be an integer.`);
		}
		if (typeof value === 'number' && typeof schema.minimum === 'number' && value < schema.minimum) {
			throw new Error(`Native tool ${tool.name} argument ${name} is below its minimum.`);
		}
		if (typeof value === 'number' && typeof schema.maximum === 'number' && value > schema.maximum) {
			throw new Error(`Native tool ${tool.name} argument ${name} exceeds its maximum.`);
		}
	}
}
