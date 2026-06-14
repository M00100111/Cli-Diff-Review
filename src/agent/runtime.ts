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

export type AgentTraceEventKind =
	| 'run_start'
	| 'llm_request'
	| 'llm_response'
	| 'parse_success'
	| 'parse_error'
	| 'tool_call'
	| 'tool_result'
	| 'tool_results_context'
	| 'run_complete'
	| 'run_error';

export type AgentTraceStatus = 'info' | 'running' | 'success' | 'error';

export type AgentTraceDetailFormat = 'text' | 'json' | 'markdown';

export interface AgentTraceDetail {
	label: string;
	format: AgentTraceDetailFormat;
	content: string;
}

export interface AgentTraceEvent {
	kind: AgentTraceEventKind;
	title: string;
	summary: string;
	round?: number;
	status: AgentTraceStatus;
	details: AgentTraceDetail[];
}

export interface AgentRunOptions {
	config: LlmRuntimeConfig;
	client: LlmClient;
	systemPrompt: string;
	userPrompt: string;
	tools: AgentTool[];
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	onTrace?: (event: AgentTraceEvent) => void;
	maxRounds?: number | 'unlimited';
	maxToolCalls?: number | 'unlimited';
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
		const unlimitedRounds = maxRounds === 'unlimited';
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
		emitTrace(options, {
			kind: 'run_start',
			title: 'Agent started',
			summary: `${providerName(options.config.provider)} model ${options.config.model}`,
			status: 'running',
			details: [
				jsonDetail('Initial messages', messages),
				jsonDetail('Tools', toolDefinitions(options.tools)),
			],
		});

		try {
			for (let round = 1; unlimitedRounds || round <= maxRounds; round += 1) {
				throwIfAborted(signal);
				if (Date.now() - startedAt > maxRunMs) {
					throw new Error('Agent exceeded its runtime limit.');
				}
				if (messages.reduce((total, message) => total + message.content.length, 0) > maxContextChars) {
					throw new Error('Agent exceeded its accumulated context limit.');
				}
				options.onProgress?.({ message: `Agent round ${round}`, round, toolCalls });
				const response = await requestAgentRound(options, messages, nativeTools, signal, round);
				throwIfAborted(signal);
				if (response.type === 'final') {
					messages.push({ role: 'assistant', content: response.content, reasoningContent: response.reasoningContent });
					const result = { result: response.result, rounds: round, toolCalls };
					emitTrace(options, {
						kind: 'run_complete',
						title: 'Agent completed',
						summary: `Completed in ${round} rounds with ${toolCalls} tool calls`,
						round,
						status: 'success',
						details: [jsonDetail('Final result', response.result)],
					});
					return result;
				}

				if (maxToolCalls !== 'unlimited' && toolCalls + response.calls.length > maxToolCalls) {
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
					emitTrace(options, {
						kind: 'tool_call',
						title: 'Tool call',
						summary: call.name,
						round,
						status: 'running',
						details: [
							textDetail('Call ID', call.id),
							jsonDetail('Arguments', call.arguments),
						],
					});
					const result: { id: string; name: string; ok: boolean; result?: unknown; error?: string } = {
						id: call.id,
						name: call.name,
						ok: true,
					};
					try {
						result.result = await tool.execute(call.arguments, signal);
					} catch (error) {
						result.ok = false;
						result.error = error instanceof Error ? error.message : String(error);
					}
					results.push(result);
					emitTrace(options, {
						kind: 'tool_result',
						title: result.ok ? 'Tool result' : 'Tool error',
						summary: result.ok ? `${call.name} completed` : `${call.name} failed`,
						round,
						status: result.ok ? 'success' : 'error',
						details: [jsonDetail('Result', result)],
					});
					toolCalls += 1;
				}
				const content = JSON.stringify({ type: 'tool_results', results });
				toolResultChars += content.length;
				if (toolResultChars > maxToolResultChars) {
					throw new Error('Agent exceeded its tool result context limit.');
				}
				emitTrace(options, {
					kind: 'tool_results_context',
					title: 'Tool results context',
					summary: `${results.length} tool result${results.length === 1 ? '' : 's'} returned to model`,
					round,
					status: 'info',
					details: [jsonTextDetail('Tool results JSON', content)],
				});
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
			throw new Error(`Agent exceeded its round limit (${maxRounds}).`);
		} catch (error) {
			const reportedError = timedOut ? new Error('Agent exceeded its runtime limit.') : error;
			emitTrace(options, {
				kind: 'run_error',
				title: 'Agent error',
				summary: errorMessage(reportedError),
				status: 'error',
				details: [textDetail('Error', errorMessage(reportedError))],
			});
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
	round: number,
): Promise<ValidAgentRound> {
	let failure: unknown;
	let preview = '';
	let previousRawResponse = '';
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const correction = attempt === 0 ? [] : [jsonCorrectionMessage(nativeTools, failure, previousRawResponse)];
		const request = {
			model: options.config.model,
			messages: [...messages, ...correction],
			temperature: 0,
			maxTokens: 12000,
			jsonOutput: options.config.provider === 'deepseek' ? true : options.config.jsonOutputEnabled,
			tools: nativeTools ? toolDefinitions(options.tools) : undefined,
		};
		emitTrace(options, {
			kind: 'llm_request',
			title: attempt === 0 ? 'LLM request' : 'LLM correction request',
			summary: attempt === 0 ? `Round ${round} request` : `Round ${round} correction request`,
			round,
			status: 'running',
			details: [jsonDetail('Request', request)],
		});
		const completion = await completeLlm(options.client, request, signal);
		emitTrace(options, {
			kind: 'llm_response',
			title: 'LLM response',
			summary: completionSummary(completion),
			round,
			status: 'success',
			details: completionDetails(completion),
		});
		previousRawResponse = completion.content || JSON.stringify(completion.toolCalls);
		preview = previousRawResponse.slice(0, 240);
		try {
			const response = nativeTools ? validateNativeRound(completion, options.tools) : validateTextRound(completion);
			emitTrace(options, {
				kind: 'parse_success',
				title: 'Parsed response',
				summary: validRoundSummary(response),
				round,
				status: 'success',
				details: [jsonDetail('Parsed action', parsedRoundForTrace(response))],
			});
			return response;
		} catch (error) {
			failure = error;
			emitTrace(options, {
				kind: 'parse_error',
				title: 'Parse error',
				summary: errorMessage(error),
				round,
				status: 'error',
				details: [
					textDetail('Error', errorMessage(error)),
					textDetail('Response preview', preview || '<empty>'),
				],
			});
		}
	}
	const reason = failure instanceof Error ? failure.message : String(failure);
	throw new Error(`${providerName(options.config.provider)} model "${options.config.model}" did not return valid Agent JSON after two correction retries: ${reason}. Response preview: ${preview || '<empty>'}`);
}

function jsonCorrectionMessage(nativeTools: boolean, failure: unknown, previousRawResponse: string): LlmMessage {
	const shape = nativeTools
		? 'Use a provided native function tool, or return only valid JSON exactly shaped as {"type":"final","result":{}}.'
		: 'Return only valid JSON matching either the tool_calls or final JSON example from the system prompt.';
	return {
		role: 'user',
		content: [
			'Your previous response was invalid JSON.',
			`Parser error: ${errorMessage(failure)}`,
			shape,
			'Repair the same semantic result as one strict JSON object.',
			'Escape all quotes, newlines, carriage returns, tabs, and backslashes inside JSON strings.',
			'Do not use markdown fences, prose, comments, or trailing commas.',
			'Previous raw response:',
			'<response>',
			previousRawResponse || '<empty>',
			'</response>',
		].join('\n'),
	};
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

function emitTrace(options: AgentRunOptions, event: AgentTraceEvent): void {
	options.onTrace?.(event);
}

function textDetail(label: string, content: string): AgentTraceDetail {
	return { label, format: 'text', content };
}

function jsonTextDetail(label: string, content: string): AgentTraceDetail {
	return { label, format: 'json', content };
}

function jsonDetail(label: string, value: unknown): AgentTraceDetail {
	return jsonTextDetail(label, stringifyTraceJson(value));
}

function stringifyTraceJson(value: unknown): string {
	try {
		return JSON.stringify(value, undefined, 2);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function completionSummary(completion: LlmCompletion): string {
	if (completion.toolCalls.length > 0) {
		return `Received ${completion.toolCalls.length} native tool call${completion.toolCalls.length === 1 ? '' : 's'}`;
	}
	if (completion.content) {
		return `Received ${completion.content.length} content chars`;
	}
	return 'Received empty response';
}

function completionDetails(completion: LlmCompletion): AgentTraceDetail[] {
	const details: AgentTraceDetail[] = [];
	if (completion.content) {
		details.push(textDetail('Content', completion.content));
	}
	if (completion.reasoningContent) {
		details.push(textDetail('Reasoning content', completion.reasoningContent));
	}
	if (completion.toolCalls.length > 0) {
		details.push(jsonDetail('Native tool calls', completion.toolCalls));
	}
	if (details.length === 0) {
		details.push(textDetail('Content', '<empty>'));
	}
	return details;
}

function validRoundSummary(response: ValidAgentRound): string {
	if (response.type === 'final') {
		return 'Parsed final result';
	}
	const names = response.calls.map((call) => call.name).join(', ');
	return `Parsed ${response.calls.length} tool call${response.calls.length === 1 ? '' : 's'}${names ? `: ${names}` : ''}`;
}

function parsedRoundForTrace(response: ValidAgentRound): Record<string, unknown> {
	return response.type === 'final'
		? { type: response.type, result: response.result }
		: { type: response.type, calls: response.calls };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
