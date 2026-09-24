import { observe, type FlueObservation, type LlmTurnPurpose } from '@flue/runtime';
import * as v from 'valibot';
import { jsonObjectSchema, jsonValueSchema, type JsonValue } from './json.ts';

const TEXT_LIMIT = 500;

const textBlockSchema = v.looseObject({
	type: v.literal('text'),
	text: v.string(),
});

export type EventLogContext = {
	instanceId: string;
	agentName: string | undefined;
};

export type EventLogUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
};

type CorrelationFields = {
	service: 'slack-agent';
	timestamp: string;
	submissionId?: string;
	instanceId?: string;
	conversationId?: string;
	agentName?: string;
};

export type ToolEventLog = CorrelationFields & {
	event: 'flue.tool';
	toolName: string;
	toolCallId: string;
	isError: boolean;
	durationMs: number;
	resultBytes?: number;
	error?: string;
};

export type ToolStartEventLog = CorrelationFields & {
	event: 'flue.tool_start';
	toolName: string;
	toolCallId: string;
	argsBytes?: number;
};

export type TurnEventLog = CorrelationFields & {
	event: 'flue.turn';
	turnId: string;
	purpose: LlmTurnPurpose;
	durationMs: number;
	isError: boolean;
	usage?: EventLogUsage;
};

export type EventLogRecord = ToolEventLog | ToolStartEventLog | TurnEventLog;

function correlationFields(
	event: FlueObservation,
	context: EventLogContext | undefined,
): CorrelationFields {
	const fields: CorrelationFields = {
		service: 'slack-agent',
		timestamp: event.timestamp,
	};

	if (event.submissionId !== undefined) fields.submissionId = event.submissionId;

	const instanceId = event.instanceId ?? context?.instanceId;

	if (instanceId !== undefined) fields.instanceId = instanceId;

	if (event.conversationId !== undefined) fields.conversationId = event.conversationId;

	const agentName = event.agentName ?? context?.agentName;

	if (agentName !== undefined) fields.agentName = agentName;

	return fields;
}

function truncate(text: string): string {
	if (text.length <= TEXT_LIMIT) return text;

	return text.slice(0, TEXT_LIMIT);
}

function errorText(result: JsonValue): string | undefined {
	if (v.is(v.string(), result)) return result.length > 0 ? result : undefined;

	if (!v.is(jsonObjectSchema, result)) return undefined;

	const content = result.content;

	if (v.is(v.array(jsonValueSchema), content)) {
		const parts: string[] = [];

		for (const item of content) {
			if (!v.is(textBlockSchema, item)) continue;
			parts.push(item.text);
		}

		if (parts.length > 0) {
			const text = parts.join('\n');

			if (text.length > 0) return text;
		}
	}

	const message = result.message;

	if (v.is(v.string(), message) && message.length > 0) return message;

	return undefined;
}

function jsonBytes(value: JsonValue): number | undefined {
	try {
		return JSON.stringify(value).length;
	} catch {
		return undefined;
	}
}

function formatTool(
	event: Extract<FlueObservation, { type: 'tool' }>,
	context: EventLogContext | undefined,
): ToolEventLog {
	const record: ToolEventLog = {
		event: 'flue.tool',
		...correlationFields(event, context),
		toolName: event.toolName,
		toolCallId: event.toolCallId,
		isError: event.isError,
		durationMs: event.durationMs,
	};

	if (v.is(jsonValueSchema, event.result)) {
		const resultBytes = jsonBytes(event.result);

		if (resultBytes !== undefined) record.resultBytes = resultBytes;
	}

	if (!event.isError) return record;

	const fromResult = v.is(jsonValueSchema, event.result) ? errorText(event.result) : undefined;
	const text = fromResult ?? event.errorInfo?.message;

	if (text !== undefined && text.length > 0) record.error = truncate(text);

	return record;
}

function formatToolStart(
	event: Extract<FlueObservation, { type: 'tool_start' }>,
	context: EventLogContext | undefined,
): ToolStartEventLog {
	const record: ToolStartEventLog = {
		event: 'flue.tool_start',
		...correlationFields(event, context),
		toolName: event.toolName,
		toolCallId: event.toolCallId,
	};

	if (v.is(jsonValueSchema, event.args)) {
		const argsBytes = jsonBytes(event.args);

		if (argsBytes !== undefined) record.argsBytes = argsBytes;
	}

	return record;
}

function formatTurn(
	event: Extract<FlueObservation, { type: 'turn' }>,
	context: EventLogContext | undefined,
): TurnEventLog {
	const record: TurnEventLog = {
		event: 'flue.turn',
		...correlationFields(event, context),
		turnId: event.turnId,
		purpose: event.purpose,
		durationMs: event.durationMs,
		isError: event.isError,
	};

	const usage = event.response.usage;

	if (usage) {
		record.usage = {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			totalTokens: usage.totalTokens,
		};
	}

	return record;
}

/** Project one runtime event into a compact log record. Streaming deltas and other events return null. */
export function formatEventLog(
	event: FlueObservation,
	context?: EventLogContext,
): EventLogRecord | null {
	switch (event.type) {
		case 'tool':
			return formatTool(event, context);
		case 'tool_start':
			return formatToolStart(event, context);
		case 'turn':
			return formatTurn(event, context);
		default:
			return null;
	}
}

function recordIsError(record: EventLogRecord): boolean {
	if (record.event === 'flue.tool_start') return false;

	return record.isError;
}

export function logRuntimeEvent(event: FlueObservation, context?: EventLogContext): void {
	try {
		const record = formatEventLog(event, context);

		if (!record) return;

		const line = JSON.stringify(record);

		if (recordIsError(record)) console.warn(line);
		else console.log(line);
	} catch {
		// Logging is best effort and must not affect agent execution.
	}
}

export function registerEventLog(): () => void {
	return observe((event, ctx) => {
		logRuntimeEvent(event, { instanceId: ctx.id, agentName: ctx.agentName });
	});
}
