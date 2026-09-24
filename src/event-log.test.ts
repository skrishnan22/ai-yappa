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

	test('logs a successful tool without its result body', () => {
		const result = {
			content: [{ type: 'text', text: 'posted' }],
			details: { output: { posted: true } },
		};

		expect(
			formatEventLog(
				observed({
					...base,
					type: 'tool',
					toolName: 'reply_in_slack_thread',
					toolCallId: 'call-ok',
					isError: false,
					durationMs: 20,
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
			toolCallId: 'call-ok',
			isError: false,
			durationMs: 20,
			resultBytes: JSON.stringify(result).length,
		});
	});

	test('uses classified error text when the tool result is not JSON', () => {
		expect(
			formatEventLog(
				observed({
					...base,
					type: 'tool',
					toolName: 'reply_in_slack_thread',
					toolCallId: 'call-2',
					isError: true,
					durationMs: 1,
					result: () => 'hidden',
					errorInfo: { type: 'tool_input_validation', message: 'schema rejected' },
				}),
			),
		).toMatchObject({
			isError: true,
			error: 'schema rejected',
		});
	});

	test('logs tool start with argument size and no argument body', () => {
		const args = { text: 'hi', blocks: [{ type: 'divider' }] };

		expect(
			formatEventLog(
				observed({
					...base,
					type: 'tool_start',
					toolName: 'reply_in_slack_thread',
					toolCallId: 'call-3',
					args,
				}),
			),
		).toEqual({
			event: 'flue.tool_start',
			service: 'slack-agent',
			timestamp: base.timestamp,
			submissionId: 'sub-1',
			instanceId: 'inst-1',
			conversationId: 'conv-1',
			agentName: 'coworker',
			toolName: 'reply_in_slack_thread',
			toolCallId: 'call-3',
			argsBytes: JSON.stringify(args).length,
		});
	});

	test('logs tool start when arguments are absent', () => {
		const record = formatEventLog(
			observed({
				...base,
				type: 'tool_start',
				toolName: 'reply_in_slack_thread',
				toolCallId: 'call-4',
			}),
		);

		expect(record).toMatchObject({ event: 'flue.tool_start', toolCallId: 'call-4' });
		expect(record).not.toHaveProperty('argsBytes');
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
					request: {
						providerId: 'opencode-go',
						providerName: 'opencode-go',
						requestedModel: 'deepseek-v4.1-flash',
						api: 'openai-completions',
					},
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
		).toEqual({
			event: 'flue.turn',
			service: 'slack-agent',
			timestamp: base.timestamp,
			submissionId: 'sub-1',
			instanceId: 'inst-1',
			conversationId: 'conv-1',
			agentName: 'coworker',
			turnId: 'turn-1',
			purpose: 'agent',
			durationMs: 300_000,
			isError: false,
			usage: {
				input: 1000,
				output: 20,
				cacheRead: 800,
				cacheWrite: 200,
				totalTokens: 2020,
			},
		});
	});

	test('omits usage when the turn response has none', () => {
		const record = formatEventLog(
			observed({
				...base,
				type: 'turn',
				turnId: 'turn-2',
				purpose: 'compaction',
				durationMs: 10,
				isError: true,
				request: {
					providerId: 'opencode-go',
					providerName: 'opencode-go',
					requestedModel: 'deepseek-v4.1-flash',
					api: 'openai-completions',
				},
				response: {},
			}),
		);

		expect(record).toMatchObject({ event: 'flue.turn', isError: true, purpose: 'compaction' });
		expect(record).not.toHaveProperty('usage');
	});

	test('fills instance and agent from context when the event omits them', () => {
		expect(
			formatEventLog(
				observed({
					v: 3,
					eventIndex: 1,
					timestamp: base.timestamp,
					type: 'tool_start',
					toolName: 'bash',
					toolCallId: 'call-5',
				}),
				{ instanceId: 'inst-from-context', agentName: 'coworker' },
			),
		).toMatchObject({
			instanceId: 'inst-from-context',
			agentName: 'coworker',
		});
	});

	test('keeps correlation fields from the event when context also has them', () => {
		expect(
			formatEventLog(
				observed({
					...base,
					type: 'tool_start',
					toolName: 'bash',
					toolCallId: 'call-6',
				}),
				{ instanceId: 'inst-from-context', agentName: 'other' },
			),
		).toMatchObject({
			instanceId: 'inst-1',
			agentName: 'coworker',
		});
	});

	test('ignores streaming and request events', () => {
		expect(formatEventLog(observed({ ...base, type: 'text_delta', text: 'hello' }))).toBeNull();
		expect(
			formatEventLog(observed({ ...base, type: 'thinking_delta', delta: 'thinking' })),
		).toBeNull();
		expect(
			formatEventLog(
				observed({
					...base,
					type: 'toolcall_delta',
					toolCallId: 'call-7',
					toolName: 'reply_in_slack_thread',
					argumentTextDelta: '{',
				}),
			),
		).toBeNull();
		expect(
			formatEventLog(
				observed({
					...base,
					type: 'turn_request',
					turnId: 'turn-3',
					purpose: 'agent',
					request: {
						providerId: 'opencode-go',
						providerName: 'opencode-go',
						requestedModel: 'deepseek-v4.1-flash',
						api: 'openai-completions',
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
	test('writes one JSON line and warns on tool errors', () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		logRuntimeEvent(
			observed({
				...base,
				type: 'tool',
				toolName: 'reply_in_slack_thread',
				toolCallId: 'call-8',
				isError: true,
				durationMs: 3,
				result: { content: [{ type: 'text', text: 'schema rejected' }], details: {} },
			}),
		);
		logRuntimeEvent(observed({ ...base, type: 'text_delta', text: 'skip' }));

		expect(log).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
			event: 'flue.tool',
			isError: true,
			error: 'schema rejected',
			toolCallId: 'call-8',
		});
	});

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
