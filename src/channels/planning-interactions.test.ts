import type { SlackInteractionPayload, SlackViewSubmissionPayload } from '@flue/slack';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DECIDE_ACTION, decideModal, REOPEN_ACTION } from '../planning/card-blocks.ts';
import { createD1PlanningStore } from '../planning/d1-decision-log.ts';
import type { Decision, NewCard, PlanningStore } from '../planning/decision-log.ts';
import { openTestDatabase } from '../testing/d1.ts';
import {
	handlePlanningInteraction,
	type PlanningContinuation,
	type PlanningInteractionDeps,
} from './planning-interactions.ts';
import { __resetSlackClientForTests, getSlackClient } from './slack-reply.ts';
import { type SlackApiResponder, stringParam, stubSlackApi } from './testing/slack-api-stub.ts';

const HOME_TEAM = 'T_HOME';

const STALE = 'This card changed since you opened it';

const REFUSED = 'Yappa only works for members of this workspace.';

const choices = [
	{ id: 'pg', label: 'Postgres' },
	{ id: 'd1', label: 'D1' },
];

function newCard(overrides: Partial<NewCard> = {}): NewCard {
	return {
		cardId: 'card-1',
		conversationId: 'conv-1',
		channelId: 'C1',
		threadTs: '1.0',
		question: 'Which database?',
		recommendation: 'D1',
		choices,
		createdAt: '2026-10-10T10:00:00.000Z',
		...overrides,
	};
}

const earlierDecision: Decision = {
	choiceId: 'pg',
	reasoning: 'We run it already',
	decidedBy: 'U1',
	decidedByName: 'maya',
	decidedAt: '2026-10-10T11:00:00.000Z',
};

type User = { id: string; name?: string; team_id?: string };

const member: User = { id: 'U1', name: 'maya', team_id: HOME_TEAM };

async function setup(respond?: SlackApiResponder) {
	const db = await openTestDatabase();
	const store = createD1PlanningStore(db);
	const calls = stubSlackApi(respond);
	const continuations: PlanningContinuation[] = [];

	const deps: PlanningInteractionDeps = {
		store,
		slack: getSlackClient('xoxb-test'),
		workspaceTeamOf: () => HOME_TEAM,
		continueConversation: async (continuation) => {
			continuations.push(continuation);
		},
		defer: (work) => work,
		now: () => new Date('2026-10-10T12:00:00.000Z'),
	};

	return { store, calls, continuations, deps };
}

async function seed(store: PlanningStore, overrides: Partial<NewCard> = {}) {
	const card = await store.log.ask(newCard(overrides));
	await store.log.setMessageTs(card.cardId, '2.0');
}

function click(actionId: string, user: User = member, value = 'card-1'): SlackInteractionPayload {
	return {
		type: 'block_actions',
		team: { id: HOME_TEAM },
		user,
		api_app_id: 'A1',
		trigger_id: 'trigger-1',
		container: {},
		actions: [{ type: 'button', action_id: actionId, value }],
	};
}

// The modal as Slack returns it on submit: our view plus the entered state.
async function openedView(
	store: PlanningStore,
	state: { choice?: string; custom?: string; reasoning?: string },
) {
	const [card] = await store.log.listCards('conv-1');
	const view = decideModal(card!);

	return {
		...view,
		state: {
			values: {
				choice: { choice: { selected_option: state.choice ? { value: state.choice } : null } },
				custom: { custom: { value: state.custom ?? null } },
				reasoning: { reasoning: { value: state.reasoning ?? null } },
			},
		},
	};
}

function submit(
	view: SlackViewSubmissionPayload['view'],
	user: User = member,
): SlackInteractionPayload {
	return { type: 'view_submission', team: { id: HOME_TEAM }, user, api_app_id: 'A1', view };
}

describe('handlePlanningInteraction', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		__resetSlackClientForTests();
	});

	it('opens the decide modal at the card’s current revision', async () => {
		const { store, calls, deps } = await setup();
		await seed(store);

		await handlePlanningInteraction(click(DECIDE_ACTION), deps);

		const open = calls.find((call) => call.method === 'views.open');

		expect(stringParam(open!, 'trigger_id')).toBe('trigger-1');
		expect(open!.params.view).toMatchObject({
			private_metadata: JSON.stringify({ cardId: 'card-1', revision: 1 }),
		});
	});

	it('redraws a decided card instead of opening the modal', async () => {
		const { store, calls, deps } = await setup();
		await seed(store);
		await store.log.decide({ cardId: 'card-1', revision: 1, decision: earlierDecision });

		await handlePlanningInteraction(click(DECIDE_ACTION), deps);

		expect(calls.map((call) => call.method)).toEqual(['chat.update']);
		expect(stringParam(calls[0]!, 'ts')).toBe('2.0');
		expect(JSON.stringify(calls[0]!.params.blocks)).toContain(REOPEN_ACTION);
	});

	it('records a chosen option, redraws, and continues once', async () => {
		const { store, calls, continuations, deps } = await setup();
		await seed(store);

		const view = await openedView(store, { choice: 'd1', reasoning: 'No server to run' });
		const result = await handlePlanningInteraction(submit(view), deps);

		expect(result).toBeUndefined();
		expect((await store.log.latest('card-1'))?.decision).toEqual({
			choiceId: 'd1',
			reasoning: 'No server to run',
			decidedBy: 'U1',
			decidedByName: 'maya',
			decidedAt: '2026-10-10T12:00:00.000Z',
		});
		const update = calls.find((call) => call.method === 'chat.update');

		expect(stringParam(update!, 'channel')).toBe('C1');
		expect(JSON.stringify(update!.params.blocks)).toContain('Decided by <@U1>');
		expect(continuations).toHaveLength(1);
		expect(continuations[0]).toMatchObject({
			conversationId: 'conv-1',
			channelId: 'C1',
			threadTs: '1.0',
			type: 'planning.decision',
			eventId: 'planning-decide:card-1:1',
			userId: 'U1',
		});
		expect(continuations[0]!.body).toContain('<@U1> decided D1 "Which database?": D1');
		expect(continuations[0]!.body).toContain('Reasoning: "No server to run"');
	});

	it('records a custom answer on a card without choices', async () => {
		const { store, continuations, deps } = await setup();
		await seed(store, { choices: undefined });

		const view = await openedView(store, { custom: 'SQLite on disk' });
		const result = await handlePlanningInteraction(submit(view), deps);

		expect(result).toBeUndefined();
		expect((await store.log.latest('card-1'))?.decision?.customAnswer).toBe('SQLite on disk');
		expect(continuations[0]!.body).toContain(': SQLite on disk');
	});

	it('refuses the second submission of the same view', async () => {
		const { store, calls, continuations, deps } = await setup();
		await seed(store);
		const view = await openedView(store, { choice: 'pg' });

		await handlePlanningInteraction(submit(view), deps);
		const second = await handlePlanningInteraction(submit(view, { ...member, id: 'U2' }), deps);

		expect(second).toMatchObject({ response_action: 'errors' });
		expect(second?.errors.reasoning).toContain(STALE);
		expect((await store.log.latest('card-1'))?.decision?.decidedBy).toBe('U1');
		expect(continuations).toHaveLength(1);
		expect(calls.filter((call) => call.method === 'chat.update')).toHaveLength(2);
	});

	it('refuses a submission opened before the card was reworded', async () => {
		const { store, continuations, deps } = await setup();
		await seed(store);
		const view = await openedView(store, { choice: 'pg' });
		await store.log.reword({
			cardId: 'card-1',
			createdAt: '2026-10-10T11:30:00.000Z',
			question: 'Which managed database?',
			recommendation: 'D1',
			choices,
		});

		const result = await handlePlanningInteraction(submit(view), deps);

		expect(result?.errors.reasoning).toContain(STALE);
		expect((await store.log.latest('card-1'))?.decision).toBeUndefined();
		expect(continuations).toHaveLength(0);
	});

	it('refuses a choice that is not on the card', async () => {
		const { store, continuations, deps } = await setup();
		await seed(store);

		const view = await openedView(store, { choice: 'mongo' });
		const result = await handlePlanningInteraction(submit(view), deps);

		expect(result?.errors.reasoning).toContain(STALE);
		expect((await store.log.latest('card-1'))?.decision).toBeUndefined();
		expect(continuations).toHaveLength(0);
	});

	it('returns modal validation errors', async () => {
		const { store, deps } = await setup();
		await seed(store);

		const view = await openedView(store, {});
		const result = await handlePlanningInteraction(submit(view), deps);

		expect(result).toEqual({
			response_action: 'errors',
			errors: { choice: 'Choose an option or write an answer.' },
		});
	});

	describe.each([
		['another workspace', { id: 'U9', team_id: 'T_OTHER' }],
		['no workspace', { id: 'U9' }],
	])('a user from %s', (_name, outsider: User) => {
		it('is refused on Decide', async () => {
			const { store, calls, deps } = await setup();
			await seed(store);

			await handlePlanningInteraction(click(DECIDE_ACTION, outsider), deps);

			expect(calls.map((call) => call.method)).toEqual(['chat.postEphemeral']);
			expect(stringParam(calls[0]!, 'user')).toBe('U9');
			expect(stringParam(calls[0]!, 'channel')).toBe('C1');
			expect(stringParam(calls[0]!, 'thread_ts')).toBe('1.0');
			expect(stringParam(calls[0]!, 'text')).toBe(REFUSED);
		});

		it('is refused on Reopen', async () => {
			const { store, calls, continuations, deps } = await setup();
			await seed(store);
			await store.log.decide({ cardId: 'card-1', revision: 1, decision: earlierDecision });

			await handlePlanningInteraction(click(REOPEN_ACTION, outsider, 'card-1:1'), deps);

			expect(calls.map((call) => call.method)).toEqual(['chat.postEphemeral']);
			expect((await store.log.latest('card-1'))?.revision).toBe(1);
			expect(continuations).toHaveLength(0);
		});

		it('is refused on submit', async () => {
			const { store, continuations, deps } = await setup();
			await seed(store);

			const view = await openedView(store, { choice: 'pg' });
			const result = await handlePlanningInteraction(submit(view, outsider), deps);

			expect(result).toEqual({ response_action: 'errors', errors: { reasoning: REFUSED } });
			expect((await store.log.latest('card-1'))?.decision).toBeUndefined();
			expect(continuations).toHaveLength(0);
		});
	});

	it('reopens a decided card, redraws it, and continues', async () => {
		const { store, calls, continuations, deps } = await setup();
		await seed(store);
		await store.log.decide({ cardId: 'card-1', revision: 1, decision: earlierDecision });

		await handlePlanningInteraction(
			click(REOPEN_ACTION, { id: 'U2', team_id: HOME_TEAM }, 'card-1:1'),
			deps,
		);

		const latest = await store.log.latest('card-1');

		expect(latest?.revision).toBe(2);
		expect(latest?.decision).toBeUndefined();
		const update = calls.find((call) => call.method === 'chat.update');

		expect(JSON.stringify(update!.params.blocks)).toContain('Previously: Postgres');
		expect(continuations).toHaveLength(1);
		expect(continuations[0]).toMatchObject({
			type: 'planning.reopen',
			eventId: 'planning-reopen:card-1:2',
			userId: 'U2',
		});
		expect(continuations[0]!.body).toContain(
			'<@U2> reopened D1 "Which database?". Earlier answer: "Postgres", decided by <@U1> (reasoning: "We run it already").',
		);
	});

	it('does not reopen a later decision from a stale Reopen button', async () => {
		const { store, calls, continuations, deps } = await setup();
		await seed(store);
		await store.log.decide({ cardId: 'card-1', revision: 1, decision: earlierDecision });
		await store.log.reopen({
			cardId: 'card-1',
			revision: 1,
			createdAt: '2026-10-10T11:30:00.000Z',
		});
		await store.log.decide({
			cardId: 'card-1',
			revision: 2,
			decision: { ...earlierDecision, choiceId: 'd1' },
		});

		await handlePlanningInteraction(click(REOPEN_ACTION, member, 'card-1:1'), deps);

		const latest = await store.log.latest('card-1');

		expect(latest).toMatchObject({
			revision: 2,
			decision: { choiceId: 'd1' },
		});
		expect(continuations).toHaveLength(0);
		expect(calls.map((call) => call.method)).toEqual(['chat.update']);
	});

	it('draws again when the card changes during its redraw', async () => {
		let store: PlanningStore | undefined;
		let reopenedMidRedraw = false;

		const { calls, continuations, deps, ...rest } = await setup(async (call) => {
			if (call.method === 'chat.update' && store && !reopenedMidRedraw) {
				reopenedMidRedraw = true;
				await store.log.reopen({
					cardId: 'card-1',
					revision: 1,
					createdAt: '2026-10-10T12:30:00.000Z',
				});
			}

			return { ok: true };
		});

		store = rest.store;
		await seed(store);
		const view = await openedView(store, { choice: 'd1' });

		await handlePlanningInteraction(submit(view), deps);

		const updates = calls.filter((call) => call.method === 'chat.update');

		expect(updates).toHaveLength(2);
		expect(JSON.stringify(updates[0]!.params.blocks)).toContain(REOPEN_ACTION);
		expect(JSON.stringify(updates[1]!.params.blocks)).toContain(DECIDE_ACTION);
		expect(continuations).toHaveLength(1);
	});

	it('does not reopen an open card', async () => {
		const { store, calls, continuations, deps } = await setup();
		await seed(store);

		await handlePlanningInteraction(click(REOPEN_ACTION, member, 'card-1:1'), deps);

		expect((await store.log.latest('card-1'))?.revision).toBe(1);
		expect(continuations).toHaveLength(0);
		expect(calls.map((call) => call.method)).toEqual(['chat.update']);
	});

	it('ignores an unknown card', async () => {
		const { calls, deps } = await setup();

		const result = await handlePlanningInteraction(click(DECIDE_ACTION), deps);

		expect(result).toBeUndefined();
		expect(calls).toHaveLength(0);
	});

	describe('when the card message cannot be redrawn', () => {
		// Slack answers ok:false with an error code; the WebClient throws on it.
		const failUpdate: SlackApiResponder = async (call) => ({
			ok: call.method !== 'chat.update',
			error: 'message_not_found',
		});

		it('still continues after a decision', async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const { store, calls, continuations, deps } = await setup(failUpdate);
			await seed(store);
			const view = await openedView(store, { choice: 'd1' });

			const result = await handlePlanningInteraction(submit(view), deps);

			expect(result).toBeUndefined();
			expect(calls.map((call) => call.method)).toContain('chat.update');
			expect(continuations).toHaveLength(1);
			expect(continuations[0]!.type).toBe('planning.decision');
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('message_not_found'));
		});

		it('still continues after a reopen', async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const { store, continuations, deps } = await setup(failUpdate);
			await seed(store);
			await store.log.decide({ cardId: 'card-1', revision: 1, decision: earlierDecision });

			await handlePlanningInteraction(click(REOPEN_ACTION, member, 'card-1:1'), deps);

			expect(continuations).toHaveLength(1);
			expect(continuations[0]!.type).toBe('planning.reopen');
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('message_not_found'));
		});
	});

	it('still continues when the card cannot be read after the decision is saved', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { store, continuations, deps } = await setup();
		await seed(store);
		const view = await openedView(store, { choice: 'd1' });

		const unreadable: PlanningStore = {
			...store,
			log: {
				...store.log,
				listCards: async () => {
					throw new Error('D1 unavailable');
				},
			},
		};

		await handlePlanningInteraction(submit(view), { ...deps, store: unreadable });

		const latest = await store.log.latest('card-1');

		expect(latest?.decision?.choiceId).toBe('d1');
		expect(continuations).toHaveLength(1);
		expect(continuations[0]!.body).toContain('<@U1> decided a card "Which database?": D1');
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('D1 unavailable'));
	});

	it('continues without a redraw when the card has no message', async () => {
		const { store, calls, continuations, deps } = await setup();
		await store.log.ask(newCard());
		const view = await openedView(store, { choice: 'd1' });

		await handlePlanningInteraction(submit(view), deps);

		expect(calls.filter((call) => call.method === 'chat.update')).toHaveLength(0);
		expect(continuations).toHaveLength(1);
	});

	it('quotes the submitted answer even if the card is reopened before the dispatch', async () => {
		const { store, continuations, deps } = await setup();
		await seed(store);
		const view = await openedView(store, { choice: 'd1', reasoning: 'No server to run' });

		const reopenFirst: PlanningStore = {
			...store,
			log: {
				...store.log,
				listCards: async (conversationId) => {
					await store.log.reopen({
						cardId: 'card-1',
						revision: 1,
						createdAt: '2026-10-10T12:30:00.000Z',
					});

					return store.log.listCards(conversationId);
				},
			},
		};

		await handlePlanningInteraction(submit(view), { ...deps, store: reopenFirst });

		expect(continuations[0]!.body).toContain(
			'<@U1> decided D1 "Which database?": D1. Reasoning: "No server to run".',
		);
	});
});
