import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import type { SlackRuntime } from './slack.ts';
import { createSlackChannelForEnv } from './slack.ts';
import type { SlackBotClient } from './slack-reply.ts';
import { __setSlackClientFactoryForTests } from './slack-reply.ts';
import { allowedInvokerIds } from '../config.ts';
import type { CodexAuthControl } from '../integrations/codex-auth/codex-auth.ts';

type SlackEventPayload = {
	type: 'event_callback';
	token: string;
	team_id: string;
	api_app_id: string;
	event_id: string;
	event_time: number;
	event: {
		type: 'app_mention' | 'message';
		user: string;
		text: string;
		channel: string;
		ts: string;
		thread_ts?: string;
	};
};

const SIGNING_SECRET = 'test-signing-secret';

const CHANNEL_ID = 'C0BTJCJD69K';

const THREAD_TS = '1710000000.000001';

const THREAD_STARTER = 'U0BGR738WMC';

const FOLLOW_UP_USER = 'U_FOLLOW_UP';

const env = {
	SLACK_SIGNING_SECRET: SIGNING_SECRET,
	SLACK_BOT_TOKEN: 'xoxb-test',
	DAYTONA_API_KEY: 'dtn-test',
	OPENCODE_API_KEY: 'opencode-test',
};

const codexAuth = (): CodexAuthControl => ({
	status: async () => ({ state: 'disconnected' }),
	startLogin: async () => ({
		state: 'pending_login',
		expires: 0,
		userCode: 'test-code',
		verificationUrl: 'https://example.test/verify',
	}),
	disconnect: async () => ({ revocation: 'none', cancelledLogin: false }),
});

function signedEventRequest(payload: SlackEventPayload): Request {
	const body = JSON.stringify(payload);
	const timestamp = Math.floor(Date.now() / 1000).toString();

	const signature = createHmac('sha256', SIGNING_SECRET)
		.update(`v0:${timestamp}:${body}`)
		.digest('hex');

	return new Request('https://example.test/events', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-slack-request-timestamp': timestamp,
			'x-slack-signature': `v0=${signature}`,
		},
		body,
	});
}

function eventPayload({
	eventId,
	type,
	user,
	text,
	ts,
}: {
	eventId: string;
	type: 'app_mention' | 'message';
	user: string;
	text: string;
	ts: string;
}): SlackEventPayload {
	const event: SlackEventPayload['event'] = {
		type,
		user,
		text,
		channel: CHANNEL_ID,
		ts,
	};

	if (type === 'message') event.thread_ts = THREAD_TS;

	return {
		type: 'event_callback',
		token: 'verification-token',
		team_id: 'TTEAM',
		api_app_id: 'AAPP',
		event_id: eventId,
		event_time: 1710000000,
		event,
	};
}

describe('Slack admission signal attribution', () => {
	afterEach(() => {
		allowedInvokerIds.delete(FOLLOW_UP_USER);
		__setSlackClientFactoryForTests();
	});

	test('attributes a follow-up to its author rather than the thread starter', async () => {
		allowedInvokerIds.add(FOLLOW_UP_USER);

		const dispatchRequests: Array<Parameters<SlackRuntime['dispatch']>[1]> = [];

		const runtime: SlackRuntime = {
			dispatch: async (_agent, request) => {
				dispatchRequests.push(request);

				return {
					submissionId: 'submission',
					acceptedAt: '2026-09-27T00:00:00.000Z',
					uid: 'uid',
				};
			},
			getAgentInstance: async () => ({ id: 'instance', uid: 'uid' }),
		};

		const slackClient: SlackBotClient = {
			chat: {
				postMessage: async () => ({ ok: true }),
				update: async () => ({ ok: true }),
			},
			conversations: {
				replies: async () => ({ ok: true, messages: [] }),
			},
		};

		__setSlackClientFactoryForTests(() => slackClient);

		const channel = createSlackChannelForEnv(env, codexAuth, runtime);

		const rootResponse = await channel.route().fetch(
			signedEventRequest(
				eventPayload({
					eventId: 'Ev-root',
					type: 'app_mention',
					user: THREAD_STARTER,
					text: '<@UBOT> start',
					ts: THREAD_TS,
				}),
			),
		);

		const followUpResponse = await channel.route().fetch(
			signedEventRequest(
				eventPayload({
					eventId: 'Ev-follow-up',
					type: 'message',
					user: FOLLOW_UP_USER,
					text: 'continue',
					ts: '1710000000.000002',
				}),
			),
		);

		expect(rootResponse.status).toBe(200);
		expect(followUpResponse.status).toBe(200);
		expect(dispatchRequests).toHaveLength(2);
		expect(dispatchRequests[0]?.message).toMatchObject({
			attributes: { eventId: 'Ev-root', userId: THREAD_STARTER },
		});
		expect(dispatchRequests[1]?.message).toMatchObject({
			attributes: { eventId: 'Ev-follow-up', userId: FOLLOW_UP_USER },
		});
	});
});
