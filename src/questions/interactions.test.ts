import app from '../app.ts';
import { createHmac } from 'node:crypto';
import type { SlackBlockActionsPayload } from '@flue/slack';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createSlackChannelForEnv, type SlackRuntime } from '../channels/slack.ts';
import { __resetSlackClientForTests } from '../channels/slack-reply.ts';
import {
	stubSlackApi,
	type SlackApiCall,
	type SlackApiResponder,
} from '../channels/testing/slack-api-stub.ts';
import type { CodexAuthControl } from '../integrations/codex-auth/codex-auth.ts';
import type { D1Database } from '../memory/d1.ts';
import { openTestDatabase } from '../testing/d1.ts';
import { createQuestionStore } from './d1-store.ts';
import type { QuestionStore } from './store.ts';
import type { QuestionStoreFactory } from './worker-store.ts';

const env = {
	SLACK_SIGNING_SECRET: 'signing-test',
	SLACK_BOT_TOKEN: 'token',
	DAYTONA_API_KEY: 'test',
	OPENCODE_API_KEY: 'test',
};

const codexAuth = (): CodexAuthControl => {
	throw new Error('Voting must not use model routing');
};

function payload(): SlackBlockActionsPayload {
	return {
		type: 'block_actions',
		team: { id: 'T1' },
		user: { id: 'ANY_VOTER', name: 'Maya' },
		api_app_id: 'APP',
		container: { type: 'message', channel_id: 'C1', message_ts: '2.3' },
		message: { ts: '2.3', thread_ts: '1.2' },
		actions: [
			{
				type: 'button',
				action_id: 'question_vote:A',
				action_ts: '1791072000.000001',
				value: JSON.stringify({ v: 1, questionId: 'q1', choiceId: 'A' }),
			},
		],
	};
}

type MalformedActionsPayload = { type: 'block_actions'; actions: { action_id: number }[] };

function signedRequest(
	data: SlackBlockActionsPayload | MalformedActionsPayload,
	signatureValid = true,
): Request {
	const body = new URLSearchParams({ payload: JSON.stringify(data) }).toString();
	const timestamp = Math.floor(Date.now() / 1000).toString();

	const signature = createHmac('sha256', signatureValid ? env.SLACK_SIGNING_SECRET : 'wrong-secret')
		.update(`v0:${timestamp}:${body}`)
		.digest('hex');

	return new Request('https://example.test/interactions', {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			'x-slack-request-timestamp': timestamp,
			'x-slack-signature': `v0=${signature}`,
		},
		body,
	});
}

describe('signed question votes through the Flue Slack route', () => {
	let db: D1Database;
	let store: QuestionStore;
	let calls: SlackApiCall[];
	let update: SlackApiResponder;
	let work: Promise<unknown>[];
	let dispatched: boolean;

	beforeEach(async () => {
		db = await openTestDatabase();
		store = createQuestionStore(db);
		await store.openQuestion({
			id: 'q1',
			conversationId: 'slack:v1:T1:C1:1.2',
			channelId: 'C1',
			threadTs: '1.2',
			messageTs: '2.3',
			kind: 'choice',
			title: 'Where?',
			recommendation: 'D1.',
			status: 'open',
			createdAt: '2026-10-04T00:00:00.000Z',
			choices: [
				{ id: 'A', label: 'KV' },
				{ id: 'B', label: 'D1' },
			],
		});
		work = [];
		dispatched = false;
		update = async () => ({ ok: true });
		calls = stubSlackApi(async (call) => {
			if (call.method === 'chat.postMessage')
				throw new Error('Voting must not post a new question');

			return call.method === 'chat.update' ? update(call) : { ok: true };
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		__resetSlackClientForTests();
	});

	const updates = () => calls.filter((call) => call.method === 'chat.update');
	const ephemeral = () => calls.filter((call) => call.method === 'chat.postEphemeral');

	function channel(factory: QuestionStoreFactory = () => store) {
		const runtime: SlackRuntime = {
			dispatch: async () => {
				dispatched = true;
				throw new Error('Voting must not dispatch');
			},
			getAgentInstance: async () => {
				throw new Error('Voting must not invoke admission');
			},
		};

		return createSlackChannelForEnv(env, codexAuth, runtime, factory);
	}

	const executionContext = () => ({
		waitUntil: (promise: Promise<unknown>) => {
			work.push(promise);
		},
		passThroughOnException() {},
		props: {},
	});

	test('the public app route forwards background work and the application database', async () => {
		const request = signedRequest(payload());

		const response = await app.fetch(
			new Request('https://example.test/channels/slack/interactions', request),
			{ ...env, APP_DB: db },
			executionContext(),
		);

		expect(response.status).toBe(200);
		expect(work).toHaveLength(1);
		await Promise.all(work);
		const votes = await store.listVotes('q1');
		expect(votes[0]?.choiceId).toBe('A');
		expect(updates()).toHaveLength(1);
	});

	test('records any voter, changes their vote, and ignores an older retried click without dispatch', async () => {
		const route = channel().route();
		const first = payload();
		const response = await route.fetch(signedRequest(first), undefined, executionContext());
		await Promise.all(work);
		const changed = payload();
		changed.actions = [
			{
				type: 'button',
				action_id: 'question_vote:B',
				action_ts: '1791072000.000002',
				value: JSON.stringify({ v: 1, questionId: 'q1', choiceId: 'B' }),
			},
		];
		await route.fetch(signedRequest(changed), undefined, executionContext());
		await Promise.all(work);
		await route.fetch(signedRequest(first), undefined, executionContext());
		await Promise.all(work);
		const votes = await store.listVotes('q1');
		const members = await store.listParticipants('slack:v1:T1:C1:1.2');
		expect(response.status).toBe(200);
		expect(votes).toEqual([
			{
				questionId: 'q1',
				userId: 'ANY_VOTER',
				userName: 'Maya',
				choiceId: 'B',
				updatedAt: '2026-10-04T00:00:00.000002Z',
			},
		]);
		expect(members.map((member) => member.userId)).toEqual(['ANY_VOTER']);
		expect(updates().at(-1)?.params).toMatchObject({
			channel: 'C1',
			ts: '2.3',
			text: expect.stringContaining('Maya → B'),
		});
		expect(dispatched).toBe(false);
		expect(ephemeral()).toEqual([]);
	});

	test('acknowledges malformed action shapes without rejected background work', async () => {
		const malformed = { ...payload(), actions: [{ action_id: 42 }] };

		const response = await channel()
			.route()
			.fetch(signedRequest(malformed), undefined, executionContext());

		await Promise.all(work);
		expect(response.status).toBe(200);
		const votes = await store.listVotes('q1');
		expect(votes).toEqual([]);
	});

	test('rejects an invalid signature before any database mutation or background work', async () => {
		const response = await channel()
			.route()
			.fetch(signedRequest(payload(), false), undefined, executionContext());

		const votes = await store.listVotes('q1');
		expect(response.status).toBe(401);
		expect(votes).toEqual([]);
		expect(work).toEqual([]);
	});

	test.each(['team', 'channel', 'message', 'thread', 'choice', 'action', 'value', 'question'])(
		'refuses a mismatched %s without recording a participant or vote',
		async (field) => {
			const data = payload();

			if (field === 'question')
				data.actions[0] = {
					...data.actions[0],
					type: 'button',
					action_id: 'question_vote:A',
					value: JSON.stringify({ v: 1, questionId: 'missing', choiceId: 'A' }),
				};

			if (field === 'team') data.team = { id: 'OTHER' };

			if (field === 'channel') data.container.channel_id = 'OTHER';

			if (field === 'message') data.container.message_ts = 'OTHER';

			if (field === 'thread') data.message = { thread_ts: 'OTHER' };

			if (field === 'choice')
				data.actions[0] = {
					...data.actions[0],
					type: 'button',
					action_id: 'question_vote:C',
					value: JSON.stringify({ v: 1, questionId: 'q1', choiceId: 'C' }),
				};

			if (field === 'action')
				data.actions[0] = { ...data.actions[0], type: 'button', action_id: 'question_vote:B' };

			if (field === 'value')
				data.actions[0] = {
					...data.actions[0],
					type: 'button',
					action_id: 'question_vote:A',
					value: 'not-json',
				};

			const response = await channel()
				.route()
				.fetch(signedRequest(data), undefined, executionContext());

			await Promise.all(work);
			const votes = await store.listVotes('q1');
			const members = await store.listParticipants('slack:v1:T1:C1:1.2');
			expect(response.status).toBe(200);
			expect(votes).toEqual([]);
			expect(members).toEqual([]);
			expect(ephemeral()).toHaveLength(1);
			expect(dispatched).toBe(false);
		},
	);

	test('a closed question refuses the click and removes stale buttons', async () => {
		await store.finishQuestion('q1', { status: 'closed', closedAt: '2026-10-04T01:00:00.000Z' });
		await channel().route().fetch(signedRequest(payload()), undefined, executionContext());
		await Promise.all(work);
		const votes = await store.listVotes('q1');
		expect(votes).toEqual([]);
		expect(ephemeral()[0]?.params).toMatchObject({
			channel: 'C1',
			user: 'ANY_VOTER',
			thread_ts: '1.2',
			text: expect.stringContaining('closed'),
		});
		expect(JSON.stringify(updates())).not.toContain('question_vote:');
	});

	test('acknowledges before storage resolves and reports a database outage ephemerally', async () => {
		let rejectStore: (reason: Error) => void = () => undefined;

		const pending = new Promise<QuestionStore>((_resolve, reject) => {
			rejectStore = reject;
		});

		const route = channel(() => pending).route();
		const response = await route.fetch(signedRequest(payload()), undefined, executionContext());
		expect(response.status).toBe(200);
		rejectStore(new Error('D1 unavailable'));
		await Promise.all(work);
		expect(ephemeral()[0]?.params.text).toContain('confirm');
		expect(dispatched).toBe(false);
	});

	test('preserves the recorded vote when Slack redraw fails', async () => {
		update = async () => ({ ok: false, error: 'service_unavailable' });

		const response = await channel()
			.route()
			.fetch(signedRequest(payload()), undefined, executionContext());

		await Promise.all(work);
		const votes = await store.listVotes('q1');
		expect(response.status).toBe(200);
		expect(votes[0]?.choiceId).toBe('A');
		expect(ephemeral()[0]?.params.text).toContain('saved');
	});
});
