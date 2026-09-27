import { describe, expect, test } from 'vitest';
import { decideAdmit, decideInvocation, isTimeoutRetry, mentionsAuthorizedBot } from './admit.ts';

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

describe('decideInvocation', () => {
	const mention = (text: string, chatgptConnected = true) =>
		decideInvocation({
			signalType: 'slack.app_mention',
			text,
			chatgptConnected,
			conversationExists: false,
		});

	test('records the model choice and strips the arguments', () => {
		expect(mention('<@U1> model:luna think:high fix it')).toEqual({
			kind: 'proceed',
			body: '<@U1> fix it',
			modelChoice: {
				model: { provider: 'chatgpt', modelId: 'gpt-5.6-luna' },
				thinkingLevel: 'high',
			},
		});
		expect(mention('<@U1> fix it')).toEqual({ kind: 'proceed', body: '<@U1> fix it' });
	});

	test('refuses bad arguments with the help text', () => {
		const unknown = mention('<@U1> model:gpt-4o fix it');
		const conflict = mention('<@U1> model:luna fix it model:kimi');

		expect(unknown.kind).toBe('bad-args');
		expect(unknown).toHaveProperty('reply', expect.stringContaining('Unknown model `gpt-4o`.'));
		expect(unknown).toHaveProperty('reply', expect.stringContaining('`deepseek`'));
		expect(conflict.kind).toBe('bad-args');
	});

	test('refuses a ChatGPT model while ChatGPT is not usable', () => {
		const refused = mention('<@U1> model:luna fix it', false);

		expect(refused.kind).toBe('model-unavailable');
		expect(refused).toHaveProperty('reply', expect.stringContaining('`gpt-5.6-luna`'));
		expect(mention('<@U1> model:kimi fix it', false).kind).toBe('proceed');
	});

	test('leaves unmentioned replies and later mentions as plain text', () => {
		expect(
			decideInvocation({
				signalType: 'slack.message',
				text: 'model:nonsense please',
				chatgptConnected: false,
				conversationExists: true,
			}),
		).toEqual({ kind: 'proceed', body: 'model:nonsense please' });
		// The thread's choice is recorded; a disconnected ChatGPT must not block
		// the mid-thread fallback.
		expect(
			decideInvocation({
				signalType: 'slack.app_mention',
				text: '<@U1> model:luna continue',
				chatgptConnected: false,
				conversationExists: true,
			}),
		).toEqual({ kind: 'proceed', body: '<@U1> model:luna continue' });
	});
});

describe('isTimeoutRetry', () => {
	test('matches only Slack timeout redeliveries', () => {
		expect(isTimeoutRetry(new Headers({ 'x-slack-retry-reason': 'http_timeout' }))).toBe(true);
		expect(isTimeoutRetry(new Headers({ 'x-slack-retry-reason': 'http_error' }))).toBe(false);
		expect(isTimeoutRetry(new Headers())).toBe(false);
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
