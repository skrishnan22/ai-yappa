import type { FlueObservation } from '@flue/runtime';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { formatEventLog, logRuntimeEvent } from './event-log.ts';

const base = {
	v: 3,
	eventIndex: 2,
	timestamp: '2026-09-24T16:00:00.000Z',
	submissionId: 'sub-1',
	instanceId: 'inst-1',
	conversationId: 'conv-1',
	agentName: 'coworker',
} as const;

const request = {
	providerId: 'opencode-go',
	providerName: 'opencode-go',
	requestedModel: 'deepseek-v4.1-flash',
	api: 'openai-completions',
} as const;

afterEach(() => {
	vi.restoreAllMocks();
});

function observed(event: FlueObservation): FlueObservation {
	return event;
}

describe('formatEventLog', () => {
	test('logs a tool failure with truncated error text and result size only', () => {
		const detail = 'x'.repeat(600);

		const result = {
			content: [{ type: 'text', text: `schema rejected: ${detail}` }],
			details: { issues: detail },
		};

		expect(
			formatEventLog(
				observed({
					...base,
					type: 'tool',
					toolName: 'reply_in_slack_thread',
					toolCallId: 'call-1',
					isError: true,
					durationMs: 4,
					result,
				}),
			),
		).toEqual({
			event: 'flue.tool',
			service: 'slack-agent',
			timestamp: base.timestamp,
			submissionId: 'sub-1',
			instanceId: 'inst-1',
			conversationId: 'conv-1',
			agentName: 'coworker',
			toolName: 'reply_in_slack_thread',
			toolCallId: 'call-1',
			isError: true,
			durationMs: 4,
			resultBytes: JSON.stringify(result).length,
			error: `schema rejected: ${detail}`.slice(0, 500),
		});
	});

	test('logs turn usage including cache tokens', () => {
		expect(
			formatEventLog(
				observed({
					...base,
					type: 'turn',
					turnId: 'turn-1',
					purpose: 'agent',
					durationMs: 300_000,
					isError: false,
					request,
					response: {
						usage: {
							input: 1000,
							output: 20,
							cacheRead: 800,
							cacheWrite: 200,
							totalTokens: 2020,
							cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
						},
					},
				}),
			),
		).toMatchObject({
			event: 'flue.turn',
			submissionId: 'sub-1',
			durationMs: 300_000,
			usage: { input: 1000, output: 20, cacheRead: 800, cacheWrite: 200, totalTokens: 2020 },
		});
	});

	test('ignores streaming and prompt-bearing request events', () => {
		expect(formatEventLog(observed({ ...base, type: 'text_delta', text: 'hello' }))).toBeNull();
		expect(
			formatEventLog(
				observed({
					...base,
					type: 'turn_request',
					turnId: 'turn-2',
					purpose: 'agent',
					request: {
						...request,
						input: {
							systemPrompt: 'secret instructions',
							messages: [{ role: 'user', content: 'hello' }],
						},
					},
				}),
			),
		).toBeNull();
	});
});

describe('logRuntimeEvent', () => {
	test('contains logging failures', () => {
		vi.spyOn(console, 'log').mockImplementation(() => {
			throw new Error('console unavailable');
		});

		expect(() =>
			logRuntimeEvent(
				observed({
					...base,
					type: 'tool_start',
					toolName: 'bash',
					toolCallId: 'call-9',
				}),
			),
		).not.toThrow();
	});
});
