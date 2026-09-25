import type { FlueObservation } from '@flue/runtime';
import * as v from 'valibot';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createLangfuseExporter, type OtlpSpan } from './langfuse-export.ts';

const context = { instanceId: 'thread-1', agentName: 'coworker' };

const envelope = {
	v: 3,
	eventIndex: 1,
	submissionId: 'sub-1',
	instanceId: 'thread-1',
	agentName: 'coworker',
	operationId: 'op-1',
} as const;

const request = {
	providerId: 'opencode-go',
	providerName: 'opencode-go',
	requestedModel: 'deepseek-v4-flash',
	api: 'openai-completions',
} as const;

const exportBodySchema = v.object({
	resourceSpans: v.tuple([
		v.object({
			scopeSpans: v.tuple([v.object({ spans: v.tuple([v.custom<OtlpSpan>(() => true)]) })]),
		}),
	]),
});

afterEach(() => {
	vi.restoreAllMocks();
});

function observed(event: FlueObservation): FlueObservation {
	return event;
}

function recorder() {
	const spans: OtlpSpan[] = [];
	const headers: Headers[] = [];

	const send = async (_url: string, init: RequestInit) => {
		const body = v.parse(exportBodySchema, JSON.parse(v.parse(v.string(), init.body)));
		spans.push(body.resourceSpans[0].scopeSpans[0].spans[0]);
		headers.push(new Headers(init.headers));

		return new Response(null, { status: 200 });
	};

	return { spans, headers, send };
}

function attributes(span: OtlpSpan | undefined): Map<string, string> {
	return new Map(span?.attributes.map((entry) => [entry.key, entry.value.stringValue]));
}

describe('createLangfuseExporter', () => {
	test('exports a failed tool call as one complete span under its operation', async () => {
		const { spans, headers, send } = recorder();
		const exportSpan = createLangfuseExporter('encoded-auth', send);
		const args = { text: 'hi', blocks: [{ type: 'data_table' }] };

		await exportSpan(
			observed({
				...envelope,
				timestamp: '2026-09-23T19:22:00.000Z',
				type: 'tool_start',
				toolName: 'reply_in_slack_thread',
				toolCallId: 'call-1',
				args,
			}),
			context,
		);
		await exportSpan(
			observed({
				...envelope,
				timestamp: '2026-09-23T19:22:00.004Z',
				type: 'tool',
				toolName: 'reply_in_slack_thread',
				toolCallId: 'call-1',
				isError: true,
				durationMs: 4,
				result: { content: [{ type: 'text', text: 'rejected' }] },
				errorInfo: { type: 'tool_input_validation', message: 'rows[0][0]: expected object' },
			}),
			context,
		);
		await exportSpan(
			observed({
				...envelope,
				timestamp: '2026-09-23T19:26:42.000Z',
				type: 'operation',
				operationKind: 'prompt',
				durationMs: 313_000,
				isError: false,
			}),
			context,
		);

		const [tool, operation] = spans;
		const toolAttributes = attributes(tool);

		expect(spans).toHaveLength(2);
		expect(headers[0]?.get('authorization')).toBe('Basic encoded-auth');
		expect(headers[0]?.get('x-langfuse-ingestion-version')).toBe('4');
		expect(tool).toMatchObject({
			traceId: operation?.traceId,
			parentSpanId: operation?.spanId,
			name: 'execute_tool reply_in_slack_thread',
			startTimeUnixNano: `${Date.parse('2026-09-23T19:22:00.000Z')}000000`,
			endTimeUnixNano: `${Date.parse('2026-09-23T19:22:00.004Z')}000000`,
			status: { code: 2, message: 'rows[0][0]: expected object' },
		});
		expect(tool?.traceId).toMatch(/^[0-9a-f]{32}$/);
		expect(tool?.spanId).toMatch(/^[0-9a-f]{16}$/);
		expect(toolAttributes.get('langfuse.observation.type')).toBe('tool');
		expect(toolAttributes.get('langfuse.observation.level')).toBe('ERROR');
		expect(toolAttributes.get('langfuse.session.id')).toBe('thread-1');
		expect(toolAttributes.get('langfuse.observation.input')).toBe(JSON.stringify(args));
		expect(operation?.parentSpanId).toBeUndefined();
		expect(attributes(operation).get('langfuse.observation.type')).toBe('agent');
	});

	test('exports a model turn as a generation with its last input message and usage', async () => {
		const { spans, send } = recorder();
		const exportSpan = createLangfuseExporter('encoded-auth', send);
		const lastMessage = { role: 'user', content: 'how long did lint take?' } as const;

		await exportSpan(
			observed({
				...envelope,
				timestamp: '2026-09-23T19:21:40.000Z',
				type: 'turn_request',
				turnId: 'turn-1',
				purpose: 'agent',
				request: { ...request, input: { systemPrompt: 'secret', messages: [lastMessage] } },
			}),
			context,
		);
		await exportSpan(
			observed({
				...envelope,
				timestamp: '2026-09-23T19:21:47.000Z',
				type: 'turn',
				turnId: 'turn-1',
				purpose: 'agent',
				durationMs: 7000,
				isError: false,
				request,
				response: {
					usage: {
						input: 1000,
						output: 20,
						cacheRead: 800,
						cacheWrite: 0,
						totalTokens: 1820,
						cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
					},
				},
			}),
			context,
		);

		const generation = attributes(spans[0]);

		expect(spans).toHaveLength(1);
		expect(generation.get('langfuse.observation.type')).toBe('generation');
		expect(generation.get('langfuse.observation.model.name')).toBe('deepseek-v4-flash');
		expect(generation.get('langfuse.observation.input')).toBe(JSON.stringify(lastMessage));
		expect(JSON.parse(generation.get('langfuse.observation.usage_details') ?? '')).toEqual({
			input: 1000,
			output: 20,
			cache_read: 800,
			cache_write: 0,
		});
	});

	test('contains export failures', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const exportSpan = createLangfuseExporter('encoded-auth', async () => {
			throw new Error('network down');
		});

		await expect(
			exportSpan(
				observed({
					...envelope,
					timestamp: '2026-09-23T19:26:42.000Z',
					type: 'operation',
					operationKind: 'prompt',
					durationMs: 1,
					isError: false,
				}),
				context,
			),
		).resolves.toBeUndefined();

		expect(warn).toHaveBeenCalledWith('[langfuse] span export failed: network down');
	});
});
