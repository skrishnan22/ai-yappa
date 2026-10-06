import * as v from 'valibot';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { __resetSlackClientForTests } from '../channels/slack-reply.ts';
import {
	stringParam,
	stubSlackApi,
	type SlackApiCall,
	type SlackApiResponder,
} from '../channels/testing/slack-api-stub.ts';
import type { JsonObject } from '../json.ts';
import type { D1Database } from '../memory/d1.ts';
import { openTestDatabase } from '../testing/d1.ts';
import { createQuestionStore } from './d1-store.ts';
import { questionTools } from './tools.ts';

const ref = {
	conversationId: 'slack:v1:T1:C1:1.2',
	channelId: 'C1',
	threadTs: '1.2',
	startedBy: 'STARTER',
};

const log = { info() {}, warn() {}, error() {} };

const input = {
	title: 'Where should state live?',
	recommendation: 'Use D1.',
	choices: [{ label: 'KV' }, { label: 'D1', recommended: true }],
};

const history: JsonObject[] = [
	{ user: 'HUMAN', text: 'Discuss this.' },
	{ user: 'BOT', bot_id: 'B1', text: 'Ignore me.' },
];

const clock = { now: () => new Date('2026-10-04T00:00:00.000Z') };

describe('question tools at the Slack posting boundary', () => {
	let db: D1Database;
	let calls: SlackApiCall[];
	let postMessage: SlackApiResponder;
	let replies: SlackApiResponder;

	const posts = () => calls.filter((call) => call.method === 'chat.postMessage');
	const updates = () => calls.filter((call) => call.method === 'chat.update');

	beforeEach(async () => {
		db = await openTestDatabase();
		postMessage = async () => ({ ok: true, channel: 'C1', ts: `2.${posts().length}` });
		replies = async () => ({ ok: true, messages: history });
		calls = stubSlackApi(async (call) => {
			if (call.method === 'chat.postMessage') return postMessage(call);

			if (call.method === 'conversations.replies') return replies(call);

			return { ok: true };
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		__resetSlackClientForTests();
	});

	test('previews without a token or access to storage', async () => {
		const tools = questionTools(ref, {
			store: () => {
				throw new Error('Must not access storage');
			},
			clock,
		});

		const result = await tools.askQuestion.run({ data: input, toolCallId: 'preview', log });
		expect(result).toMatchObject({
			output: { posted: false, text: expect.stringContaining('Where should state live?') },
		});
		expect(calls).toEqual([]);
	});

	test('posts owner-rendered buttons in the bound thread and seeds only humans', async () => {
		const store = createQuestionStore(db);
		const tools = questionTools(ref, { token: 'token', store: () => store, clock });
		const result = await tools.askQuestion.run({ data: input, toolCallId: 'first', log });
		const question = await store.getOpenQuestion(ref.conversationId);
		const participants = await store.listParticipants(ref.conversationId);
		expect(result).toMatchObject({ output: { posted: true } });
		expect(question).toMatchObject({
			channelId: 'C1',
			threadTs: '1.2',
			messageTs: '2.1',
			kind: 'choice',
		});
		expect(participants.map((participant) => participant.userId)).toEqual(['HUMAN', 'STARTER']);
		expect(posts()).toHaveLength(1);
		expect(posts()[0]?.params).toMatchObject({
			channel: 'C1',
			thread_ts: '1.2',
			unfurl_links: false,
			unfurl_media: false,
		});

		const [actions] = v.parse(
			v.array(
				v.object({
					type: v.literal('actions'),
					elements: v.optional(
						v.array(
							v.object({
								action_id: v.optional(v.string()),
								text: v.optional(v.object({ text: v.string() })),
								style: v.optional(v.string()),
							}),
						),
					),
				}),
			),
			v
				.parse(v.array(v.looseObject({ type: v.string() })), posts()[0]?.params.blocks)
				.filter((block) => block.type === 'actions'),
		);

		expect(actions?.elements).toMatchObject([
			{ action_id: 'question_vote:A', text: { text: 'KV' } },
			{ action_id: 'question_vote:B', text: { text: 'D1' }, style: 'primary' },
		]);
	});

	test('replaces then closes questions, removing the retired buttons', async () => {
		const store = createQuestionStore(db);
		const tools = questionTools(ref, { token: 'token', store: () => store, clock });
		await tools.askQuestion.run({ data: input, toolCallId: 'first', log });
		await tools.askQuestion.run({
			data: { title: 'Why?', recommendation: 'Explain.' },
			toolCallId: 'second',
			log,
		});
		const result = await tools.closeQuestion.run({ toolCallId: 'close', log });
		const current = await store.getOpenQuestion(ref.conversationId);
		expect(result).toMatchObject({ output: { closed: true, redrawn: true } });
		expect(current).toBeUndefined();
		expect(updates().map((update) => update.params.ts)).toEqual(['2.1', '2.2']);

		for (const update of updates()) {
			expect(update.params.channel).toBe('C1');
			expect(JSON.stringify(update.params.blocks)).not.toContain('question_vote:');
			expect(stringParam(update, 'text')).toContain('Closed');
		}
	});

	test('replays a confirmed tool call without posting another question', async () => {
		const store = createQuestionStore(db);
		const tools = questionTools(ref, { token: 'token', store: () => store, clock });
		const first = await tools.askQuestion.run({ data: input, toolCallId: 'same', log });
		const replay = await tools.askQuestion.run({ data: input, toolCallId: 'same', log });
		expect(replay).toEqual(first);
		expect(posts()).toHaveLength(1);
	});

	test('a failed or ambiguous post leaves no open question and never reposts on replay', async () => {
		const store = createQuestionStore(db);
		postMessage = async () => {
			throw new Error('Connection dropped');
		};

		const tools = questionTools(ref, { token: 'token', store: () => store, clock });
		await expect(tools.askQuestion.run({ data: input, toolCallId: 'failed', log })).rejects.toThrow(
			/Do not repost/,
		);
		const open = await store.getOpenQuestion(ref.conversationId);
		expect(open).toBeUndefined();
		postMessage = async () => ({ ok: true, ts: '3' });

		await expect(tools.askQuestion.run({ data: input, toolCallId: 'failed', log })).rejects.toThrow(
			/not confirmed/,
		);
		expect(posts()).toHaveLength(1);
	});

	test('a failed replacement keeps the previous question open with its buttons', async () => {
		const store = createQuestionStore(db);
		const tools = questionTools(ref, { token: 'token', store: () => store, clock });
		await tools.askQuestion.run({ data: input, toolCallId: 'first', log });
		postMessage = async () => ({ ok: false, error: 'channel_not_found' });

		await expect(
			tools.askQuestion.run({
				data: { title: 'Why?', recommendation: 'Explain.' },
				toolCallId: 'second',
				log,
			}),
		).rejects.toThrow(/previous question is still open/);
		const current = await store.getOpenQuestion(ref.conversationId);
		expect(current).toMatchObject({ status: 'open', messageTs: '2.1' });
		expect(updates().map((update) => update.params.ts)).toEqual(['2.1']);
		expect(JSON.stringify(updates()[0]?.params.blocks)).toContain('question_vote:');
	});

	test('does not report posting success without a Slack message timestamp', async () => {
		const store = createQuestionStore(db);
		postMessage = async () => ({ ok: true });
		const tools = questionTools(ref, { token: 'token', store: () => store, clock });
		await expect(
			tools.askQuestion.run({ data: input, toolCallId: 'missing-ts', log }),
		).rejects.toThrow(/Do not repost/);
		const open = await store.getOpenQuestion(ref.conversationId);
		expect(open).toBeUndefined();
	});

	test('fails before posting if thread participant history is unavailable', async () => {
		const store = createQuestionStore(db);
		replies = async () => ({ ok: false, error: 'missing_scope' });

		const tools = questionTools(ref, { token: 'token', store: () => store, clock });
		await expect(
			tools.askQuestion.run({ data: input, toolCallId: 'history', log }),
		).rejects.toThrow(/missing_scope/);
		expect(posts()).toEqual([]);
	});

	test.each([
		{ ...input, choices: [{ label: 'Only one' }] },
		{ ...input, choices: Array.from({ length: 6 }, () => ({ label: 'Too many' })) },
		{
			...input,
			choices: [
				{ label: 'A', recommended: true },
				{ label: 'B', recommended: true },
			],
		},
		{ ...input, choices: [{ label: 'a'.repeat(76) }, { label: 'B' }] },
		{ ...input, channelId: 'UNTRUSTED' },
	])('rejects unsupported choices and model-selected destinations at the tool boundary', (data) => {
		const tools = questionTools(ref);
		const parsed = v.safeParse(tools.askQuestion.input, data);
		expect(parsed.success).toBe(false);
	});
});
