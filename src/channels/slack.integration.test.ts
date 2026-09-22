import { createHmac } from 'node:crypto';
import type { DispatchReceipt } from '@flue/runtime';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	dispatch: vi.fn<typeof import('@flue/runtime').dispatch>(),
	getAgentInstance: vi.fn<typeof import('@flue/runtime').getAgentInstance>(async () => null),
	getSlackClient: vi.fn<typeof import('./slack-reply.ts').getSlackClient>(),
}));

vi.mock('@flue/runtime', async (importOriginal) => ({
	...(await importOriginal<typeof import('@flue/runtime')>()),
	dispatch: mocks.dispatch,
	getAgentInstance: mocks.getAgentInstance,
}));
vi.mock('./slack-reply.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('./slack-reply.ts')>()),
	getSlackClient: mocks.getSlackClient,
}));
vi.mock('../config.ts', () => ({
	isAllowedInvoker: (userId: string | undefined) => userId === 'U-test',
	repoForChannel: (channelId: string) =>
		channelId === 'C-test' ? 'https://github.com/example/repo.git' : undefined,
}));

const { default: app } = await import('../app.ts');

const secret = 'signing-secret';
const serverEnv = {
	SLACK_SIGNING_SECRET: secret,
	SLACK_BOT_TOKEN: 'xoxb-test',
	DAYTONA_API_KEY: 'dtn-test',
	OPENCODE_API_KEY: 'sk-test',
};

describe('Slack event admission', () => {
	beforeEach(() => {
		mocks.dispatch.mockReset();
		mocks.getAgentInstance.mockClear();
		mocks.getSlackClient.mockReset();
		const submissions = new Map<string, string>();
		mocks.dispatch.mockImplementation(async (_agent, request) => {
			if (request.idempotencyKey === undefined) throw new Error('Missing idempotency key.');
			const existing = submissions.get(request.idempotencyKey);
			const submissionId = existing ?? `submission-${submissions.size + 1}`;
			submissions.set(request.idempotencyKey, submissionId);
			return {
				submissionId,
				acceptedAt: new Date().toISOString(),
				uid: 'agent-uid',
				...(existing === undefined ? {} : { deduplicated: true }),
			};
		});
	});

	test('acknowledges after durable dispatch without fetching thread history', async () => {
		let admit: ((receipt: DispatchReceipt) => void) | undefined;
		mocks.dispatch.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					admit = resolve;
				}),
		);
		let responded = false;
		const responsePromise = Promise.resolve(app.fetch(signedEventRequest('Ev-1'), serverEnv)).then(
			(response) => {
				responded = true;
				return response;
			},
		);
		await vi.waitFor(() => expect(admit).toBeTypeOf('function'));
		expect(responded).toBe(false);
		admit?.({
			submissionId: 'submission-1',
			acceptedAt: new Date().toISOString(),
			uid: 'agent-uid',
		});
		const response = await responsePromise;

		expect(response.status).toBe(200);
		expect(mocks.getSlackClient).not.toHaveBeenCalled();
		expect(mocks.dispatch).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({
				idempotencyKey: 'Ev-1',
				message: {
					kind: 'signal',
					type: 'slack.app_mention',
					body: '<@U-BOT> please fix it',
					attributes: { eventId: 'Ev-1' },
				},
			}),
		);
	});

	test('returns a retryable response when durable admission fails', async () => {
		mocks.dispatch.mockRejectedValueOnce(new Error('admission unavailable'));

		const response = await app.fetch(signedEventRequest('Ev-failed'), serverEnv);

		expect(response.status).toBeGreaterThanOrEqual(500);
	});

	test('uses the Slack event id as the duplicate admission key', async () => {
		const first = await app.fetch(signedEventRequest('Ev-duplicate'), serverEnv);
		const duplicate = await app.fetch(signedEventRequest('Ev-duplicate'), serverEnv);

		expect(first.status).toBe(200);
		expect(duplicate.status).toBe(200);
		expect(mocks.dispatch).toHaveBeenCalledTimes(2);
		expect(mocks.dispatch.mock.calls.map(([, request]) => request.idempotencyKey)).toEqual([
			'Ev-duplicate',
			'Ev-duplicate',
		]);
	});
});

function signedEventRequest(eventId: string): Request {
	const body = JSON.stringify({
		type: 'event_callback',
		team_id: 'T1',
		event_id: eventId,
		authorizations: [{ user_id: 'U-BOT', is_bot: true }],
		event: {
			type: 'app_mention',
			user: 'U-test',
			text: '<@U-BOT> please fix it',
			channel: 'C-test',
			ts: '1750000000.000001',
		},
	});
	const timestamp = Math.floor(Date.now() / 1_000).toString();
	const signature = `v0=${createHmac('sha256', secret)
		.update(`v0:${timestamp}:${body}`)
		.digest('hex')}`;
	return new Request('https://example.test/channels/slack/events', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-slack-request-timestamp': timestamp,
			'x-slack-signature': signature,
		},
		body,
	});
}
