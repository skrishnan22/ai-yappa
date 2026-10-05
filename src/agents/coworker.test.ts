import { describe, expect, test } from 'vitest';
import { hasSkillActivations, hasSuccessfulSlackReply } from './coworker.ts';

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

describe('hasSkillActivations', () => {
	test('needs one successful activate_skill call per invoked skill', () => {
		const activated = { tool: 'activate_skill', isError: false };

		expect(hasSkillActivations([], 0)).toBe(true);
		expect(hasSkillActivations([{ tool: 'bash', isError: false }], 1)).toBe(false);
		expect(hasSkillActivations([{ tool: 'activate_skill', isError: true }], 1)).toBe(false);
		expect(hasSkillActivations([activated], 2)).toBe(false);
		expect(hasSkillActivations([activated, activated], 2)).toBe(true);
	});
});
