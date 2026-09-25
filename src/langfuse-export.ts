import { observe, type FlueObservation } from '@flue/runtime';
import { errorMessage } from './json.ts';

// Each finished agent operation, model turn, and tool call becomes one complete
// OTLP span with explicit start and end times. Nothing stays open across
// Durable Object invocations, which is where Cloudflare's native tracing loses
// the tail of long runs. IDs are hashes of Flue ids, so spans sent from
// different invocations still assemble into one trace.

const ENDPOINT = 'https://us.cloud.langfuse.com/api/public/otel/v1/traces';

const CONTENT_LIMIT = 16_000;

export type ExportContext = { instanceId: string; agentName: string | undefined };

type Pending = { toolArgs: Map<string, string>; turnInputs: Map<string, string> };

type SpanDraft = {
	name: string;
	spanKey: string;
	parentKey: string | undefined;
	type: 'agent' | 'generation' | 'tool';
	durationMs: number;
	isError: boolean;
	statusMessage: string | undefined;
	fields: Record<string, string | undefined>;
};

export type OtlpSpan = {
	traceId: string;
	spanId: string;
	parentSpanId: string | undefined;
	name: string;
	kind: 1;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: { key: string; value: { stringValue: string } }[];
	status: { code: 1 | 2; message: string | undefined };
};

type Send = (url: string, init: RequestInit) => Promise<Response>;

async function hexId(value: string, length: 16 | 32): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));

	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, length);
}

function clip(json: string | undefined): string | undefined {
	return json?.slice(0, CONTENT_LIMIT);
}

function operationKey(operationId: string | undefined): string | undefined {
	return operationId === undefined ? undefined : `operation:${operationId}`;
}

function draft(event: FlueObservation, pending: Pending): SpanDraft | null {
	switch (event.type) {
		case 'tool_start':
			pending.toolArgs.set(event.toolCallId, JSON.stringify(event.args));

			return null;

		case 'turn_request':
			pending.turnInputs.set(event.turnId, JSON.stringify(event.request.input.messages.at(-1)));

			return null;

		case 'tool': {
			const input = pending.toolArgs.get(event.toolCallId);
			pending.toolArgs.delete(event.toolCallId);

			return {
				name: `execute_tool ${event.toolName}`,
				spanKey: `tool:${event.toolCallId}`,
				parentKey: operationKey(event.operationId),
				type: 'tool',
				durationMs: event.durationMs,
				isError: event.isError,
				statusMessage: event.errorInfo?.message,
				fields: {
					'langfuse.observation.input': clip(input),
					'langfuse.observation.output': clip(JSON.stringify(event.result)),
				},
			};
		}

		case 'turn': {
			const input = pending.turnInputs.get(event.turnId);
			pending.turnInputs.delete(event.turnId);
			const { usage } = event.response;

			return {
				name: `chat ${event.request.requestedModel}`,
				spanKey: `turn:${event.turnId}`,
				parentKey: operationKey(event.operationId),
				type: 'generation',
				durationMs: event.durationMs,
				isError: event.isError,
				statusMessage: event.response.error?.message,
				fields: {
					'langfuse.observation.model.name':
						event.response.responseModel ?? event.request.requestedModel,
					'langfuse.observation.input': clip(input),
					'langfuse.observation.output': clip(JSON.stringify(event.response.output)),
					'langfuse.observation.usage_details':
						usage &&
						JSON.stringify({
							input: usage.input,
							output: usage.output,
							cache_read: usage.cacheRead,
							cache_write: usage.cacheWrite,
						}),
					'langfuse.observation.cost_details': usage && JSON.stringify({ total: usage.cost.total }),
				},
			};
		}

		case 'operation':
			if (event.operationKind !== 'prompt' && event.operationKind !== 'skill') return null;

			return {
				name: `invoke_agent ${event.agentName ?? 'agent'}`,
				spanKey: `operation:${event.operationId}`,
				parentKey: undefined,
				type: 'agent',
				durationMs: event.durationMs,
				isError: event.isError,
				statusMessage: undefined,
				fields: { 'langfuse.observation.output': clip(JSON.stringify(event.result)) },
			};

		default:
			return null;
	}
}

export async function toOtlpSpan(
	event: FlueObservation,
	context: ExportContext,
	pending: Pending,
): Promise<OtlpSpan | null> {
	const span = draft(event, pending);

	if (!span) return null;

	const endMs = Date.parse(event.timestamp);

	const fields = {
		'langfuse.observation.type': span.type,
		'langfuse.session.id': event.instanceId ?? context.instanceId,
		'langfuse.trace.name': event.agentName ?? context.agentName,
		'langfuse.trace.metadata.submission_id': event.submissionId,
		'langfuse.observation.level': span.isError ? 'ERROR' : undefined,
		'langfuse.observation.status_message': span.statusMessage,
		...span.fields,
	} satisfies Record<string, string | undefined>;

	let parentSpanId: string | undefined;

	if (span.parentKey !== undefined) parentSpanId = await hexId(span.parentKey, 16);

	return {
		traceId: await hexId(event.submissionId ?? context.instanceId, 32),
		spanId: await hexId(span.spanKey, 16),
		parentSpanId,
		name: span.name,
		kind: 1,
		startTimeUnixNano: String(Math.round((endMs - Math.max(0, span.durationMs)) * 1_000_000)),
		endTimeUnixNano: `${endMs}000000`,
		attributes: Object.entries(fields).flatMap(([key, value]) =>
			value === undefined ? [] : [{ key, value: { stringValue: value } }],
		),
		status: { code: span.isError ? 2 : 1, message: span.statusMessage },
	};
}

export function createLangfuseExporter(
	auth: string,
	send: Send = (url, init) => fetch(url, init),
): (event: FlueObservation, context: ExportContext) => Promise<void> {
	const pending: Pending = { toolArgs: new Map(), turnInputs: new Map() };

	return async (event, context) => {
		try {
			const span = await toOtlpSpan(event, context, pending);

			if (!span) return;

			const response = await send(ENDPOINT, {
				method: 'POST',
				headers: {
					authorization: `Basic ${auth}`,
					'content-type': 'application/json',
					'x-langfuse-ingestion-version': '4',
				},
				body: JSON.stringify({
					resourceSpans: [
						{
							resource: {
								attributes: [{ key: 'service.name', value: { stringValue: 'slack-agent' } }],
							},
							scopeSpans: [{ scope: { name: 'slack-agent' }, spans: [span] }],
						},
					],
				}),
			});

			if (!response.ok) console.warn(`[langfuse] span export failed with HTTP ${response.status}`);
		} catch (cause) {
			console.warn(`[langfuse] span export failed: ${errorMessage(cause)}`);
		}
	};
}

export function registerLangfuseExport(auth: string | undefined): void {
	if (!auth) return;

	const exportSpan = createLangfuseExporter(auth);

	observe((event, ctx) => exportSpan(event, { instanceId: ctx.id, agentName: ctx.agentName }));
}
