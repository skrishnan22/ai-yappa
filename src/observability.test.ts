import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FlueObservation } from '@flue/runtime';
import { readFile } from 'node:fs/promises';
import {
	classifyTelemetryError,
	emitTelemetry,
	observeFlueTelemetry,
	resetTelemetryForTests,
} from './observability.ts';

afterEach(() => {
	resetTelemetryForTests();
	vi.restoreAllMocks();
});

function outputRecords(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
	const records: Array<Record<string, unknown>> = [];
	for (const call of spy.mock.calls) {
		const record: unknown = call[0];
		if (isRecord(record)) records.push(record);
	}
	return records;
}

describe('emitTelemetry', () => {
	test('wires Slack dispatch receipts and refusal delivery into the correlation chain', async () => {
		const source = await readFile(new URL('./channels/slack.ts', import.meta.url), 'utf8');
		expect(source).toContain('const receipt = await dispatch');
		expect(source).toContain('submission_id: receipt.submissionId');
		expect(source).toContain('agent_uid: receipt.uid');
		expect(source).toContain("deliveryKind: 'refusal'");
		expect(source).toContain("deliveryKind: 'missing_repo'");
		expect(source).not.toContain("'[slack-agent] thread context fetch failed'");
	});

	test('emits one structured, versioned terminal event', () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});

		emitTelemetry({
			event_name: 'proxy.operation',
			outcome: 'ok',
			conversation_id: 'conversation-1',
			submission_id: 'submission-1',
			repo: 'org/repo',
			proxy_operation: 'readIssue',
			params_digest: 'a'.repeat(64),
			duration_ms: 12,
		});

		expect(outputRecords(info)).toEqual([
			expect.objectContaining({
				schema_version: 1,
				event_name: 'proxy.operation',
				service: 'slack-agent',
				outcome: 'ok',
				conversation_id: 'conversation-1',
				submission_id: 'submission-1',
				duration_ms: 12,
				timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
			}),
		]);
	});

	test('rejects unknown fields without leaking their contents', () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const unsafe = {
			event_name: 'slack.invocation',
			outcome: 'ok',
			decision: 'dispatch',
			signal_type: 'slack.app_mention',
			slack_event_id: 'Ev1',
			conversation_id: 'conversation-1',
			message_text: 'never emit this secret body',
		};

		Reflect.apply(emitTelemetry, undefined, [unsafe]);

		expect(info).not.toHaveBeenCalled();
		const serialized = JSON.stringify(outputRecords(error));
		expect(serialized).toContain('telemetry.emit_failure');
		expect(serialized).not.toContain('never emit this secret body');
	});

	test('redacts high-confidence secret patterns in allowlisted strings', () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});

		emitTelemetry({
			event_name: 'agent.tool',
			outcome: 'failed',
			conversation_id: 'conversation-1',
			tool_call_id: 'call-1',
			tool_name: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
			flue_event_version: 3,
			flue_event_index: 1,
			duration_ms: 4,
		});

		const serialized = JSON.stringify(outputRecords(info));
		expect(serialized).toContain('[REDACTED]');
		expect(serialized).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234567890');
	});

	test('contains console failure and does not throw into the product path', () => {
		vi.spyOn(console, 'info').mockImplementation(() => {
			throw new Error('console unavailable');
		});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});

		expect(() =>
			emitTelemetry({
				event_name: 'sandbox.lifecycle',
				outcome: 'ok',
				conversation_id: 'conversation-1',
				phase: 'attach',
			}),
		).not.toThrow();
		expect(JSON.stringify(outputRecords(error))).toContain('telemetry.emit_failure');
	});

	test('canonicalizes repository URLs so embedded credentials cannot reach logs', () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});

		emitTelemetry({
			event_name: 'sandbox.lifecycle',
			outcome: 'ok',
			conversation_id: 'conversation-1',
			phase: 'hydrate',
			repo: 'https://user:never-log-me@github.com/org/repo.git',
		});

		const serialized = JSON.stringify(outputRecords(info));
		expect(serialized).toContain('org/repo');
		expect(serialized).not.toContain('never-log-me');
		expect(serialized).not.toContain('user');
	});
});

describe('classifyTelemetryError', () => {
	test('omits error fields when no error occurred', () => {
		expect(classifyTelemetryError(undefined)).toEqual({});
	});

	test('keeps only controlled type and code fields', () => {
		const classified = classifyTelemetryError({
			type: 'provider_error',
			code: 'rate_limited',
			message: 'Bearer top-secret',
			stack: '/private/workspace/source.ts',
		});

		expect(classified).toEqual({ error_type: 'provider_error', error_code: 'rate_limited' });
	});
});

describe('observeFlueTelemetry', () => {
	test('is the Coworker module observer instead of the temporary raw debug logger', async () => {
		const source = await readFile(new URL('./agents/coworker.ts', import.meta.url), 'utf8');
		expect(source).toContain('observeFlueTelemetry(event, context.id)');
		expect(source).toContain("phase: 'hydrate'");
		expect(source).toContain("phase: 'attach'");
		expect(source).not.toContain('debugFields(');
		expect(source).not.toContain('toolDebugError(');
		expect(source).not.toContain('console.info(');
	});

	test('removes duplicate ad hoc provider request logging', async () => {
		const source = await readFile(new URL('./agents/opencode-session.ts', import.meta.url), 'utf8');
		expect(source).not.toContain('console.info(');
		expect(source).not.toContain('withOpenCodeRequestLog');
	});

	test('maps a terminal turn without prompt or response content', () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const event = {
			type: 'turn',
			v: 3,
			eventIndex: 8,
			timestamp: '2026-09-13T00:00:00.000Z',
			conversationId: 'conversation-1',
			submissionId: 'submission-1',
			operationId: 'operation-1',
			turnId: 'turn-1',
			purpose: 'agent',
			durationMs: 25,
			request: {
				providerId: 'opencode-go',
				providerName: 'OpenCode Go',
				requestedModel: 'deepseek-v4-flash',
				api: 'openai-completions',
				contextCompacted: true,
			},
			response: {
				responseModel: 'deepseek-v4-flash',
				finishReason: 'stop',
				providerFinishReason: 'stop',
				gatewayLogId: 'gateway-1',
				output: {
					role: 'assistant',
					content: [{ type: 'text', text: 'private model output' }],
				},
				usage: {
					input: 10,
					output: 3,
					cacheRead: 2,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, total: 3 },
				},
			},
			isError: false,
		} satisfies FlueObservation;

		observeFlueTelemetry(event, 'fallback-conversation');

		const records = outputRecords(info);
		expect(records).toEqual([
			expect.objectContaining({
				event_name: 'agent.turn',
				conversation_id: 'conversation-1',
				submission_id: 'submission-1',
				operation_id: 'operation-1',
				turn_id: 'turn-1',
				input_tokens: 10,
				output_tokens: 3,
				total_tokens: 15,
				outcome: 'ok',
			}),
		]);
		expect(JSON.stringify(records)).not.toContain('private model output');
	});

	test('joins bounded tool-start metadata to the terminal tool event and clears it', () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const start = {
			type: 'tool_start',
			v: 3,
			eventIndex: 9,
			timestamp: '2026-09-13T00:00:00.000Z',
			conversationId: 'conversation-1',
			submissionId: 'submission-1',
			turnId: 'turn-1',
			toolCallId: 'tool-1',
			toolName: 'bash',
			origin: 'model',
			args: { command: 'echo private-command' },
		} satisfies FlueObservation;
		const terminal = {
			type: 'tool',
			v: 3,
			eventIndex: 10,
			timestamp: '2026-09-13T00:00:01.000Z',
			conversationId: 'conversation-1',
			submissionId: 'submission-1',
			turnId: 'turn-1',
			toolCallId: 'tool-1',
			toolName: 'bash',
			isError: false,
			result: 'private command output',
			durationMs: 30,
		} satisfies FlueObservation;

		observeFlueTelemetry(start, 'fallback-conversation');
		observeFlueTelemetry(terminal, 'fallback-conversation');
		observeFlueTelemetry(terminal, 'fallback-conversation');

		const records = outputRecords(info);
		expect(records[0]).toEqual(
			expect.objectContaining({
				event_name: 'agent.tool',
				origin: 'model',
				arguments_bytes: expect.any(Number),
				result_bytes: expect.any(Number),
			}),
		);
		expect(records[1]).not.toHaveProperty('origin');
		expect(records[1]).not.toHaveProperty('arguments_bytes');
		expect(JSON.stringify(records)).not.toContain('private-command');
		expect(JSON.stringify(records)).not.toContain('private command output');
	});

	test('maps recovery and settlement into the submission family', () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const recovery = {
			type: 'submission_recovery',
			v: 3,
			eventIndex: 4,
			timestamp: '2026-09-13T00:00:00.000Z',
			conversationId: 'conversation-1',
			submissionId: 'submission-1',
			operation: 'process_submission',
			outcome: 'deferred',
			attemptCount: 2,
			maxAttempts: 4,
			error: { message: 'private recovery error', type: 'transient' },
		} satisfies FlueObservation;
		const settlement = {
			type: 'submission_settled',
			v: 3,
			eventIndex: 5,
			timestamp: '2026-09-13T00:00:01.000Z',
			conversationId: 'conversation-1',
			submissionId: 'submission-1',
			outcome: 'failed',
			error: { message: 'private settlement error', type: 'permanent' },
		} satisfies FlueObservation;

		observeFlueTelemetry(recovery, 'fallback-conversation');
		observeFlueTelemetry(settlement, 'fallback-conversation');

		const records = outputRecords(info);
		expect(records).toEqual([
			expect.objectContaining({
				event_name: 'agent.submission',
				stage: 'recovery',
				outcome: 'deferred',
				attempt: 2,
				max_attempts: 4,
				error_type: 'transient',
			}),
			expect.objectContaining({
				event_name: 'agent.submission',
				stage: 'settlement',
				outcome: 'failed',
				error_type: 'permanent',
			}),
		]);
		expect(JSON.stringify(records)).not.toContain('private recovery error');
		expect(JSON.stringify(records)).not.toContain('private settlement error');
	});
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
