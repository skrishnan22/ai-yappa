import { describe, expect, test } from 'vitest';
import { decideAdmit, mentionsAuthorizedBot } from './admit.ts';

describe('decideAdmit', () => {
	test('refuses a user who is not allowlisted', () => {
		expect(
			decideAdmit({
				signalType: 'slack.app_mention',
				allowed: false,
				repo: 'https://github.com/org/pilot.git',
				conversationExists: false,
			}),
		).toEqual({ kind: 'refuse-invoker' });
	});

	test('refuses a mapped invoker in a channel with no repo', () => {
		expect(
			decideAdmit({
				signalType: 'slack.app_mention',
				allowed: true,
				repo: undefined,
				conversationExists: false,
			}),
		).toEqual({ kind: 'no-repo' });
	});

	test('a mention creates a conversation when none exists', () => {
		expect(
			decideAdmit({
				signalType: 'slack.app_mention',
				allowed: true,
				repo: 'https://github.com/org/pilot.git',
				conversationExists: false,
			}),
		).toEqual({ kind: 'dispatch', repo: 'https://github.com/org/pilot.git' });
	});

	test('an unmentioned reply does not create a conversation', () => {
		expect(
			decideAdmit({
				signalType: 'slack.message',
				allowed: true,
				repo: 'https://github.com/org/pilot.git',
				conversationExists: false,
			}),
		).toEqual({ kind: 'drop-untracked' });
	});

	test('an untracked reply from a disallowed user is silently dropped', () => {
		expect(
			decideAdmit({
				signalType: 'slack.message',
				allowed: false,
				repo: 'https://github.com/org/pilot.git',
				conversationExists: false,
			}),
		).toEqual({ kind: 'drop-untracked' });
	});

	test('an untracked reply in an unmapped channel is silently dropped', () => {
		expect(
			decideAdmit({
				signalType: 'slack.message',
				allowed: true,
				repo: undefined,
				conversationExists: false,
			}),
		).toEqual({ kind: 'drop-untracked' });
	});

	test('an unmentioned reply continues an existing conversation', () => {
		expect(
			decideAdmit({
				signalType: 'slack.message',
				allowed: true,
				repo: 'https://github.com/org/pilot.git',
				conversationExists: true,
			}),
		).toEqual({ kind: 'dispatch', repo: 'https://github.com/org/pilot.git' });
	});
});

describe('mentionsAuthorizedBot', () => {
	test('matches only the bot identity authorized for this delivery', () => {
		const authorizations = [
			{ user_id: 'U_BOT', is_bot: true },
			{ user_id: 'U_HUMAN', is_bot: false },
		];

		expect(mentionsAuthorizedBot('hello <@U_BOT>', authorizations)).toBe(true);
		expect(mentionsAuthorizedBot('hello <@U_HUMAN>', authorizations)).toBe(false);
	});

	test('does not suppress human mentions when Slack omits authorizations', () => {
		expect(mentionsAuthorizedBot('hello <@U_HUMAN>', undefined)).toBe(false);
	});
});
