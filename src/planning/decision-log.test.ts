import { describe, expect, it } from 'vitest';
import { openTestDatabase } from '../testing/d1.ts';
import { createD1PlanningStore } from './d1-decision-log.ts';
import type { Decision, NewCard } from './decision-log.ts';

const choices = [
	{ id: 'a', label: 'Option A' },
	{ id: 'b', label: 'Option B' },
];

function newCard(overrides: Partial<NewCard> = {}): NewCard {
	return {
		cardId: 'card-1',
		conversationId: 'conv-1',
		channelId: 'C1',
		threadTs: '1.0',
		question: 'Which store?',
		context: 'We need durability.',
		recommendation: 'Use D1.',
		choices,
		createdAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

const decision: Decision = {
	choiceId: 'a',
	reasoning: 'Simplest.',
	decidedBy: 'U1',
	decidedByName: 'Ada',
	decidedAt: '2026-01-01T01:00:00.000Z',
};

async function openStore() {
	const db = await openTestDatabase();

	return { db, ...createD1PlanningStore(db) };
}

describe('decision log', () => {
	it('round-trips a card with context and choices', async () => {
		const { log } = await openStore();

		const asked = await log.ask(newCard());

		expect(asked.revision).toBe(1);
		expect(asked.decision).toBeUndefined();
		const result1 = await log.latest('card-1');

		expect(result1).toEqual(asked);
		expect(asked).toMatchObject({
			question: 'Which store?',
			context: 'We need durability.',
			recommendation: 'Use D1.',
			choices,
		});
	});

	it('round-trips a card without context or choices', async () => {
		const { log } = await openStore();

		const asked = await log.ask(newCard({ context: undefined, choices: undefined }));

		expect(asked.context).toBeUndefined();
		expect(asked.choices).toBeUndefined();
	});

	it('rejects choices with duplicate ids', async () => {
		const { log } = await openStore();

		await expect(
			log.ask(
				newCard({
					choices: [
						{ id: 'a', label: 'One' },
						{ id: 'a', label: 'Two' },
					],
				}),
			),
		).rejects.toThrow('unique');
	});

	it('lets the first decision win', async () => {
		const { log } = await openStore();

		await log.ask(newCard());

		const result1 = await log.decide({ cardId: 'card-1', revision: 1, decision });

		expect(result1).toBe(true);
		expect((await log.latest('card-1'))?.decision).toEqual(decision);

		const second = { ...decision, choiceId: 'b', decidedBy: 'U2' };

		const result2 = await log.decide({ cardId: 'card-1', revision: 1, decision: second });

		expect(result2).toBe(false);
		expect((await log.latest('card-1'))?.decision).toEqual(decision);
	});

	it('refuses a decision on a stale revision', async () => {
		const { log } = await openStore();

		await log.ask(newCard());
		await log.reword({
			cardId: 'card-1',
			createdAt: '2026-01-01T00:30:00.000Z',
			question: 'Which database?',
			recommendation: 'Use D1.',
		});

		const result1 = await log.decide({ cardId: 'card-1', revision: 1, decision });

		expect(result1).toBe(false);
		const latest = await log.latest('card-1');

		expect(latest?.revision).toBe(2);
		expect(latest?.decision).toBeUndefined();
	});

	it('reopens a decided card and keeps the earlier decision as history', async () => {
		const { log } = await openStore();

		await log.ask(newCard());
		await log.decide({ cardId: 'card-1', revision: 1, decision });

		const reopened = await log.reopen({ cardId: 'card-1', createdAt: '2026-01-02T00:00:00.000Z' });

		expect(reopened).toMatchObject({ revision: 2, question: 'Which store?', choices });
		expect(reopened?.decision).toBeUndefined();

		const [card] = await log.listCards('conv-1');

		expect(card?.history[0]?.decision).toEqual(decision);
		expect(card?.latest.revision).toBe(2);
	});

	it('does not reopen an open card', async () => {
		const { log } = await openStore();

		await log.ask(newCard());

		const reopened = await log.reopen({ cardId: 'card-1', createdAt: '2026-01-02T00:00:00.000Z' });
		const latest = await log.latest('card-1');

		expect(reopened).toBe(undefined);
		expect(latest?.revision).toBe(1);
	});

	it('creates one revision for concurrent reopens', async () => {
		const { log } = await openStore();

		await log.ask(newCard());
		await log.decide({ cardId: 'card-1', revision: 1, decision });

		const results = await Promise.all([
			log.reopen({ cardId: 'card-1', createdAt: '2026-01-02T00:00:00.000Z' }),
			log.reopen({ cardId: 'card-1', createdAt: '2026-01-02T00:00:00.000Z' }),
		]);

		const latest = await log.latest('card-1');

		expect(results.filter(Boolean)).toHaveLength(1);
		expect(latest?.revision).toBe(2);
	});

	it('does not reword a decided card', async () => {
		const { log } = await openStore();

		await log.ask(newCard());
		await log.decide({ cardId: 'card-1', revision: 1, decision });

		const reworded = await log.reword({
			cardId: 'card-1',
			createdAt: '2026-01-02T00:00:00.000Z',
			question: 'Other?',
			recommendation: 'None.',
		});

		expect(reworded).toBe(undefined);
	});

	it('sets the message timestamp on every revision and carries it forward', async () => {
		const { log } = await openStore();

		await log.ask(newCard());
		await log.reword({
			cardId: 'card-1',
			createdAt: '2026-01-01T00:30:00.000Z',
			question: 'Which database?',
			recommendation: 'Use D1.',
		});
		await log.setMessageTs('card-1', '9.9');

		const [card] = await log.listCards('conv-1');

		expect(card?.history[0]?.messageTs).toBe('9.9');
		expect(card?.latest.messageTs).toBe('9.9');

		await log.decide({
			cardId: 'card-1',
			revision: 2,
			decision: { ...decision, choiceId: undefined, customAnswer: 'Neither' },
		});

		const reopened = await log.reopen({ cardId: 'card-1', createdAt: '2026-01-02T00:00:00.000Z' });

		expect(reopened?.messageTs).toBe('9.9');
	});

	it('lists cards of one conversation in creation order with labels', async () => {
		const { log } = await openStore();

		await log.ask(newCard({ cardId: 'second', createdAt: '2026-01-01T00:00:02.000Z' }));
		await log.ask(newCard({ cardId: 'first', createdAt: '2026-01-01T00:00:01.000Z' }));
		await log.ask(newCard({ cardId: 'other', conversationId: 'conv-2' }));

		const cards = await log.listCards('conv-1');

		expect(cards.map((card) => [card.label, card.latest.cardId])).toEqual([
			['D1', 'first'],
			['D2', 'second'],
		]);
	});

	it('refuses a decision with both a choice and a custom answer', async () => {
		const { log, db } = await openStore();

		await log.ask(newCard());

		await expect(
			db
				.prepare(
					`UPDATE card_revisions SET choice_id = 'a', custom_answer = 'x', decided_by = 'U1',
						decided_by_name = 'Ada', decided_at = '2026-01-01T01:00:00.000Z'`,
				)
				.run(),
		).rejects.toThrow('card_decision');
	});
});

describe('planning sessions', () => {
	it('starts, ends, and restarts', async () => {
		const { sessions } = await openStore();

		const result1 = await sessions.isActive('conv-1');

		expect(result1).toBe(false);
		const result2 = await sessions.end('conv-1', '2026-01-01T00:00:00.000Z');

		expect(result2).toBe(false);
		await sessions.start('conv-1', '2026-01-01T00:00:00.000Z');
		const result3 = await sessions.isActive('conv-1');

		expect(result3).toBe(true);
		const result4 = await sessions.end('conv-1', '2026-01-01T01:00:00.000Z');

		expect(result4).toBe(true);
		const result5 = await sessions.isActive('conv-1');

		expect(result5).toBe(false);
		const result6 = await sessions.end('conv-1', '2026-01-01T02:00:00.000Z');

		expect(result6).toBe(false);
		await sessions.start('conv-1', '2026-01-01T03:00:00.000Z');
		const result7 = await sessions.isActive('conv-1');

		expect(result7).toBe(true);
	});
});
