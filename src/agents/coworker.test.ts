import { describe, expect, test } from 'vitest';
import { hasSuccessfulSlackReply } from './coworker.ts';

describe('hasSuccessfulSlackReply', () => {
	test('accepts a successful reply anywhere in the aggregate tool calls', () => {
		expect(
			hasSuccessfulSlackReply([
				{ tool: 'bash', isError: false },
				{ tool: 'reply_in_slack_thread', isError: false },
			]),
		).toBe(true);
	});

	test('rejects a missing or failed Slack reply', () => {
		expect(hasSuccessfulSlackReply([{ tool: 'bash', isError: false }])).toBe(false);
		expect(hasSuccessfulSlackReply([{ tool: 'reply_in_slack_thread', isError: true }])).toBe(false);
	});
});
