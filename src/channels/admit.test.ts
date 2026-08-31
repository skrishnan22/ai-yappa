import { describe, expect, test } from 'vitest';
import { decideAdmit } from './admit.ts';

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
