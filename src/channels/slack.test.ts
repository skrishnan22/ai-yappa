import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SlackRuntime } from './slack.ts';
import { createSlackChannelForEnv } from './slack.ts';
import { __resetSlackClientForTests } from './slack-reply.ts';
import { stringParam, stubSlackApi } from './testing/slack-api-stub.ts';
import type { CodexAuthControl } from '../integrations/codex-auth/codex-auth.ts';

type SlackEventPayload = {
	type: 'event_callback';
	token: string;
	team_id: string;
	api_app_id: string;
	event_id: string;
	event_time: number;
	is_ext_shared_channel?: boolean;
	event: {
		type: 'app_mention' | 'message';
		user: string;
		text: string;
		channel: string;
		ts: string;
		thread_ts?: string;
		user_team?: string;
		team?: string;
	};
};

const SIGNING_SECRET = 'test-signing-secret';

const CHANNEL_ID = 'C0BTJCJD69K';

const THREAD_TS = '1710000000.000001';

const THREAD_STARTER = 'U0BGR738WMC';

// Never on the old invoker allowlist: any workspace member may continue a thread.
const FOLLOW_UP_USER = 'U_FOLLOW_UP';

const WORKSPACE_TEAM = 'TTEAM';

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
	userTeam,
	team,
	sharedExternally,
}: {
	eventId: string;
	type: 'app_mention' | 'message';
	user: string;
	text: string;
	ts: string;
	userTeam?: string;
	team?: string;
	sharedExternally?: boolean;
}): SlackEventPayload {
	const event: SlackEventPayload['event'] = {
		type,
		user,
		text,
		channel: CHANNEL_ID,
		ts,
	};

	if (type === 'message') event.thread_ts = THREAD_TS;

	if (userTeam) event.user_team = userTeam;

	if (team) event.team = team;

	return {
		type: 'event_callback',
		token: 'verification-token',
		team_id: WORKSPACE_TEAM,
		is_ext_shared_channel: sharedExternally,
		api_app_id: 'AAPP',
		event_id: eventId,
		event_time: 1710000000,
		event,
	};
}

describe('Slack ingress', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		__resetSlackClientForTests();
	});

	test('attributes a follow-up to its author rather than the thread starter', async () => {
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

		stubSlackApi(async () => ({ ok: true, messages: [] }));

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

	test('leaves model arguments untouched on a later app mention', async () => {
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

		stubSlackApi(async () => ({ ok: true, messages: [] }));

		const channel = createSlackChannelForEnv(env, codexAuth, runtime);

		const response = await channel.route().fetch(
			signedEventRequest(
				eventPayload({
					eventId: 'Ev-later-mention',
					type: 'app_mention',
					user: THREAD_STARTER,
					text: '<@UBOT> $model:luna continue',
					ts: THREAD_TS,
				}),
			),
		);

		expect(response.status).toBe(200);
		expect(dispatchRequests).toHaveLength(1);
		expect(dispatchRequests[0]?.message).toMatchObject({
			body: '<@UBOT> $model:luna continue',
		});
	});
	describe('Slack Connect', () => {
		function recordingRuntime() {
			const dispatchRequests: Array<Parameters<SlackRuntime['dispatch']>[1]> = [];

			const runtime: SlackRuntime = {
				dispatch: async (_agent, request) => {
					dispatchRequests.push(request);

					return {
						submissionId: 'submission',
						acceptedAt: '2026-10-10T00:00:00.000Z',
						uid: 'uid',
					};
				},
				getAgentInstance: async () => ({ id: 'instance', uid: 'uid' }),
			};

			return { runtime, dispatchRequests };
		}

		async function deliver(payload: SlackEventPayload) {
			const { runtime, dispatchRequests } = recordingRuntime();
			const calls = stubSlackApi(async () => ({ ok: true, messages: [] }));
			const channel = createSlackChannelForEnv(env, codexAuth, runtime);
			const response = await channel.route().fetch(signedEventRequest(payload));

			expect(response.status).toBe(200);

			return {
				dispatchRequests,
				refusals: calls.filter((call) => call.method === 'chat.postMessage'),
			};
		}

		test('refuses a mention from another organization', async () => {
			const { dispatchRequests, refusals } = await deliver(
				eventPayload({
					eventId: 'Ev-external-mention',
					type: 'app_mention',
					user: 'U_EXTERNAL',
					text: '<@UBOT> start',
					ts: THREAD_TS,
					userTeam: 'T_OTHER',
					sharedExternally: true,
				}),
			);

			expect(dispatchRequests).toHaveLength(0);
			expect(refusals).toHaveLength(1);
			expect(stringParam(refusals[0]!, 'text')).toContain('members of this workspace');
		});

		test('refuses an external reply in a thread that has a Coworker', async () => {
			const { dispatchRequests, refusals } = await deliver(
				eventPayload({
					eventId: 'Ev-external-reply',
					type: 'message',
					user: 'U_EXTERNAL',
					text: 'continue',
					ts: '1710000000.000002',
					userTeam: 'T_OTHER',
					sharedExternally: true,
				}),
			);

			expect(dispatchRequests).toHaveLength(0);
			expect(refusals).toHaveLength(1);
		});

		test('refuses a shared-channel mention that names no sender team', async () => {
			const { dispatchRequests, refusals } = await deliver(
				eventPayload({
					eventId: 'Ev-unknown-team',
					type: 'app_mention',
					user: 'U_UNKNOWN',
					text: '<@UBOT> start',
					ts: THREAD_TS,
					sharedExternally: true,
				}),
			);

			expect(dispatchRequests).toHaveLength(0);
			expect(refusals).toHaveLength(1);
		});

		test('does not trust `team` in place of `user_team` in a shared channel', async () => {
			const { dispatchRequests, refusals } = await deliver(
				eventPayload({
					eventId: 'Ev-team-only',
					type: 'app_mention',
					user: 'U_UNKNOWN',
					text: '<@UBOT> start',
					ts: THREAD_TS,
					team: WORKSPACE_TEAM,
					sharedExternally: true,
				}),
			);

			expect(dispatchRequests).toHaveLength(0);
			expect(refusals).toHaveLength(1);
		});

		test('admits a member whose plain message names only `team` outside Slack Connect', async () => {
			const { dispatchRequests, refusals } = await deliver(
				eventPayload({
					eventId: 'Ev-team-member',
					type: 'message',
					user: FOLLOW_UP_USER,
					text: 'continue',
					ts: '1710000000.000002',
					team: WORKSPACE_TEAM,
				}),
			);

			expect(dispatchRequests).toHaveLength(1);
			expect(refusals).toHaveLength(0);
		});

		test('admits a workspace member in a shared channel', async () => {
			const { dispatchRequests, refusals } = await deliver(
				eventPayload({
					eventId: 'Ev-member-shared',
					type: 'app_mention',
					user: FOLLOW_UP_USER,
					text: '<@UBOT> start',
					ts: THREAD_TS,
					userTeam: WORKSPACE_TEAM,
					sharedExternally: true,
				}),
			);

			expect(dispatchRequests).toHaveLength(1);
			expect(refusals).toHaveLength(0);
		});
	});
});
