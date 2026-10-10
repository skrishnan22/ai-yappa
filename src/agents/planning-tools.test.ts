import type { ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonValueSchema, type JsonObject, type JsonValue } from '../json.ts';
import { __resetSlackClientForTests } from '../channels/slack-reply.ts';
import {
	type SlackApiResponder,
	stringParam,
	stubSlackApi,
} from '../channels/testing/slack-api-stub.ts';
import { createD1PlanningStore } from '../planning/d1-decision-log.ts';
import type { Decision, PlanningStore } from '../planning/decision-log.ts';
import { openTestDatabase } from '../testing/d1.ts';
import { planningTools } from './planning-tools.ts';

afterEach(() => {
	vi.unstubAllGlobals();
	__resetSlackClientForTests();
});

const CONVERSATION = 'conv-1';

const question = {
	question: 'Which database?',
	context: 'Needs transactions',
	recommendation: 'Postgres',
	choices: [
		{ id: 'pg', label: 'Postgres' },
		{ id: 'my', label: 'MySQL' },
	],
};

const decision: Decision = {
	choiceId: 'pg',
	reasoning: 'We already run it',
	decidedBy: 'U1',
	decidedByName: 'Maya',
	decidedAt: '2026-10-10T12:00:00.000Z',
};

// Slack answers ok:false with an error code; the WebClient throws on it.
const failPosts: SlackApiResponder = async (call) => ({
	ok: call.method !== 'chat.postMessage',
	error: 'channel_not_found',
});

async function setup(
	options: { token?: string; respond?: SlackApiResponder } = { token: 'xoxb-test' },
) {
	const db = await openTestDatabase();
	const store = createD1PlanningStore(db);
	let nextTs = 0;

	const calls = stubSlackApi(
		options.respond ??
			(async (call): Promise<Record<string, JsonValue>> =>
				call.method === 'chat.postMessage'
					? { ok: true, channel: 'C1', ts: `9.${++nextTs}` }
					: { ok: true }),
	);

	let nextId = 0;

	const tools = planningTools({
		conversationId: CONVERSATION,
		channelId: 'C1',
		threadTs: '1.1',
		token: options.token,
		store,
		now: () => new Date('2026-10-10T11:00:00.000Z'),
		newId: () => `card-${++nextId}`,
	});

	return { store, calls, tools };
}

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
	const found = tools.find((candidate) => candidate.name === name);

	if (!found) throw new Error(`No tool ${name}`);

	return found;
}

const runResultSchema = v.object({ output: jsonValueSchema });

async function run(tools: ToolDefinition[], name: string, data: JsonObject) {
	const result = await tool(tools, name).run({
		data,
		toolCallId: name,
		log: { info() {}, warn() {}, error() {} },
	});

	return v.parse(runResultSchema, result).output;
}

async function decide(store: PlanningStore, cardId: string, overrides: Partial<Decision> = {}) {
	const decided = await store.log.decide({
		cardId,
		revision: 1,
		decision: { ...decision, ...overrides },
	});

	expect(decided).toBe(true);
}

describe('planningTools', () => {
	it('exposes the four planning tools', async () => {
		const { tools } = await setup();

		expect(tools.map((candidate) => candidate.name)).toEqual([
			'ask_decision',
			'reword_decision',
			'list_decisions',
			'end_planning',
		]);
	});

	it('rejects choices with duplicate ids or outside 2–5', async () => {
		const { tools } = await setup();
		const input = tool(tools, 'ask_decision').input;

		if (!input) throw new Error('ask_decision has no input schema');

		const choice = (id: string) => ({ id, label: id });

		expect(v.is(input, question)).toBe(true);
		expect(v.is(input, { ...question, choices: [choice('a'), choice('a')] })).toBe(false);
		expect(v.is(input, { ...question, choices: [choice('a')] })).toBe(false);
		expect(v.is(input, { ...question, choices: ['a', 'b', 'c', 'd', 'e', 'f'].map(choice) })).toBe(
			false,
		);
	});

	// Slack caps a radio option value at 150 characters.
	it('rejects choice ids too long for a Slack option value', async () => {
		const { tools } = await setup();
		const input = tool(tools, 'ask_decision').input;

		if (!input) throw new Error('ask_decision has no input schema');

		const long = { id: 'x'.repeat(65), label: 'Long' };

		expect(v.is(input, { ...question, choices: [long, { id: 'b', label: 'B' }] })).toBe(false);
	});

	it('rejects blank choice labels', async () => {
		const { tools } = await setup();
		const input = tool(tools, 'ask_decision').input;

		if (!input) throw new Error('ask_decision has no input schema');

		const blank = { id: 'a', label: '  ' };

		expect(v.is(input, { ...question, choices: [blank, { id: 'b', label: 'B' }] })).toBe(false);
	});
});

describe('ask_decision', () => {
	it('starts a planning session if none is active, such as after a reopen past the end', async () => {
		const { store, tools } = await setup();

		await run(tools, 'ask_decision', question);
		const active = await store.sessions.isActive(CONVERSATION);

		expect(active).toBe(true);
	});

	it('stores revision 1, posts a card with a Decide button and saves its ts', async () => {
		const { store, calls, tools } = await setup();

		const output = await run(tools, 'ask_decision', question);

		expect(output).toEqual({ label: 'D1', cardId: 'card-1', posted: true, ts: '9.1' });
		const latest = await store.log.latest('card-1');

		expect(latest).toMatchObject({
			revision: 1,
			conversationId: CONVERSATION,
			question: 'Which database?',
			messageTs: '9.1',
			createdAt: '2026-10-10T11:00:00.000Z',
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			method: 'chat.postMessage',
			token: 'xoxb-test',
			params: { channel: 'C1', thread_ts: '1.1' },
		});

		expect(JSON.stringify(calls[0]?.params.blocks)).toContain('planning_decide');
	});

	it('records the card without posting when there is no token', async () => {
		const { store, calls, tools } = await setup({});

		const output = await run(tools, 'ask_decision', question);

		expect(output).toEqual({ label: 'D1', cardId: 'card-1', posted: false, ts: null });
		const latest = await store.log.latest('card-1');

		expect(latest).toMatchObject({ revision: 1, messageTs: undefined });
		expect(calls).toEqual([]);
	});

	it('saves no card when the post fails', async () => {
		const { store, tools } = await setup({ token: 'xoxb-test', respond: failPosts });

		await expect(run(tools, 'ask_decision', question)).rejects.toThrow(/channel_not_found/);

		const cards = await store.log.listCards(CONVERSATION);

		expect(cards).toEqual([]);
	});

	it('withdraws the posted card when it cannot be saved', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { store, calls, tools } = await setup();

		vi.spyOn(store.log, 'ask').mockRejectedValue(new Error('D1 unavailable'));

		await expect(run(tools, 'ask_decision', question)).rejects.toThrow(/D1 unavailable/);

		expect(calls.map((call) => call.method)).toEqual(['chat.postMessage', 'chat.update']);
		expect(calls[1]).toMatchObject({
			params: { ts: '9.1', text: 'This question could not be saved.' },
		});
	});

	it('describes the Decide-button-only answering rule', async () => {
		const { tools } = await setup();

		expect(tool(tools, 'ask_decision').description).toMatch(/only with its Decide button/);
		expect(tool(tools, 'ask_decision').description).toMatch(/never treat thread replies/);
	});
});

describe('reword_decision', () => {
	it('adds revision 2 and updates the card message', async () => {
		const { store, calls, tools } = await setup();

		await run(tools, 'ask_decision', question);

		const output = await run(tools, 'reword_decision', {
			card: 'D1',
			question: 'Which primary database?',
			recommendation: 'Postgres',
		});

		expect(output).toEqual({ ok: true, label: 'D1', revision: 2 });
		const latest = await store.log.latest('card-1');

		expect(latest).toMatchObject({
			revision: 2,
			question: 'Which primary database?',
		});

		const update = calls.find((call) => call.method === 'chat.update');

		expect(update).toMatchObject({ params: { channel: 'C1', ts: '9.1' } });
		expect(stringParam(update ?? { params: {} }, 'text')).toContain('Which primary database?');
	});

	it('refuses a decided card and points to Reopen', async () => {
		const { store, calls, tools } = await setup();

		await run(tools, 'ask_decision', question);
		await decide(store, 'card-1');

		const output = await run(tools, 'reword_decision', {
			card: 'D1',
			question: 'Changed?',
			recommendation: 'MySQL',
		});

		expect(output).toEqual({ ok: false, reason: expect.stringMatching(/Reopen/) });
		const latest = await store.log.latest('card-1');

		expect(latest).toMatchObject({ revision: 1 });
		expect(calls.map((call) => call.method)).toEqual(['chat.postMessage']);
	});

	it('refuses an unknown card label', async () => {
		const { tools } = await setup();

		const output = await run(tools, 'reword_decision', {
			card: 'D7',
			question: 'Changed?',
			recommendation: 'MySQL',
		});

		expect(output).toEqual({ ok: false, reason: expect.stringMatching(/D7/) });
	});
});

describe('list_decisions', () => {
	it('reports decided and open cards with earlier answers after a reopen', async () => {
		const { store, tools } = await setup();

		await run(tools, 'ask_decision', question);
		await run(tools, 'ask_decision', {
			question: 'Which cache?',
			recommendation: 'Redis',
		});

		await decide(store, 'card-1');
		await store.log.reopen({
			cardId: 'card-1',
			revision: 1,
			createdAt: '2026-10-10T13:00:00.000Z',
		});
		await decide(store, 'card-2', { choiceId: undefined, customAnswer: 'Redis' });

		const output = await run(tools, 'list_decisions', {});

		expect(output).toEqual({
			decisions: [
				{
					label: 'D1',
					question: 'Which database?',
					context: 'Needs transactions',
					recommendation: 'Postgres',
					choices: question.choices,
					state: 'open',
					answer: null,
					reasoning: null,
					decidedBy: null,
					decidedByName: null,
					decidedAt: null,
					earlier: [
						{
							answer: 'Postgres',
							decidedBy: 'U1',
							decidedAt: '2026-10-10T12:00:00.000Z',
							reasoning: 'We already run it',
						},
					],
				},
				{
					label: 'D2',
					question: 'Which cache?',
					context: null,
					recommendation: 'Redis',
					choices: null,
					state: 'decided',
					answer: 'Redis',
					reasoning: 'We already run it',
					decidedBy: 'U1',
					decidedByName: 'Maya',
					decidedAt: '2026-10-10T12:00:00.000Z',
					earlier: [],
				},
			],
		});
	});
});

describe('end_planning', () => {
	it('posts the summary and ends the session', async () => {
		const { store, calls, tools } = await setup();

		await store.sessions.start(CONVERSATION, '2026-10-10T10:00:00.000Z');
		await run(tools, 'ask_decision', question);
		await decide(store, 'card-1');

		const output = await run(tools, 'end_planning', {});

		expect(output).toEqual({ summary: expect.stringContaining('Postgres'), posted: true });
		const active = await store.sessions.isActive(CONVERSATION);

		expect(active).toBe(false);

		const summary = calls.at(-1);

		expect(summary).toMatchObject({
			method: 'chat.postMessage',
			params: { channel: 'C1', thread_ts: '1.1' },
		});

		expect(stringParam(summary ?? { params: {} }, 'text')).toContain('*D1* Which database?');
	});

	it('ends the session even when the summary cannot be posted', async () => {
		const { store, tools } = await setup({ token: 'xoxb-test', respond: failPosts });

		await store.sessions.start(CONVERSATION, '2026-10-10T10:00:00.000Z');

		await expect(run(tools, 'end_planning', {})).rejects.toThrow(/channel_not_found/);

		const active = await store.sessions.isActive(CONVERSATION);

		expect(active).toBe(false);
	});

	it('ends the session without posting when there is no token', async () => {
		const { store, calls, tools } = await setup({});

		await store.sessions.start(CONVERSATION, '2026-10-10T10:00:00.000Z');

		const output = await run(tools, 'end_planning', {});

		expect(output).toEqual({ summary: 'No decisions were recorded.', posted: false });
		const active = await store.sessions.isActive(CONVERSATION);

		expect(active).toBe(false);
		expect(calls).toEqual([]);
	});
});
