import { beforeEach, describe, expect, test } from 'vitest';
import type { D1Database } from '../memory/d1.ts';
import { openMigratedSqlite } from '../memory/testing/sqlite-d1.ts';
import { createQuestionStore } from './d1-store.ts';
import type { OpenQuestion, QuestionStore, Vote } from './store.ts';

const NOW = '2026-10-04T00:00:00.000Z';

const LATER = '2026-10-04T00:01:00.000Z';

function question(id = 'q1', conversationId = 'conv-a'): OpenQuestion {
	return {
		id,
		conversationId,
		channelId: 'C1',
		threadTs: '1710000000.000001',
		title: 'Where should state live?',
		recommendation: 'Use D1.',
		createdAt: NOW,
		status: 'open',
		kind: 'choice',
		choices: [
			{ id: 'A', label: 'KV' },
			{ id: 'B', label: 'D1', recommended: true },
		],
	};
}

function openEnded(id: string, conversationId = 'conv-a'): OpenQuestion {
	return {
		id,
		conversationId,
		channelId: 'C1',
		threadTs: '1',
		title: 'Why?',
		body: 'Context.',
		recommendation: 'Explain.',
		createdAt: NOW,
		status: 'open',
		kind: 'open',
	};
}

function vote(userId = 'U1', choiceId = 'A', questionId = 'q1'): Vote {
	return { questionId, userId, choiceId, userName: userId, updatedAt: NOW };
}

describe('QuestionStore (D1)', () => {
	let db: D1Database;
	let store: QuestionStore;

	beforeEach(() => {
		db = openMigratedSqlite();
		store = createQuestionStore(db);
	});

	const submit = (questionId: string, userId: string, userName: string, closedAt: string) =>
		store.submitQuestion({ questionId, userId, userName, closedAt });

	test('round-trips choice and open-ended questions', async () => {
		await store.openQuestion(question());
		await store.openQuestion(openEnded('q2', 'conv-b'));
		const choice = await store.getQuestion('q1');
		const open = await store.getOpenQuestion('conv-b');
		const missing = await store.getQuestion('missing');
		const noOpen = await store.getOpenQuestion('missing');
		expect(choice).toEqual(question());
		expect(open).toEqual(openEnded('q2', 'conv-b'));
		expect(missing).toBeUndefined();
		expect(noOpen).toBeUndefined();
	});

	test('opening a question closes the previous one in the same conversation only', async () => {
		await store.openQuestion(question());
		await store.openQuestion(question('other', 'conv-b'));
		await store.openQuestion({ ...question('q2'), createdAt: LATER });
		const previous = await store.getQuestion('q1');
		const current = await store.getOpenQuestion('conv-a');
		const other = await store.getOpenQuestion('conv-b');
		expect(previous).toMatchObject({ status: 'closed', closedAt: LATER });
		expect(current?.id).toBe('q2');
		expect(other?.id).toBe('other');
	});

	test('a failed replacement leaves the previous question open', async () => {
		await store.openQuestion(question());
		await store.openQuestion(question('duplicate', 'conv-b'));
		await expect(store.openQuestion(question('duplicate'))).rejects.toThrow(/UNIQUE/);
		const current = await store.getOpenQuestion('conv-a');
		expect(current?.id).toBe('q1');
	});

	test('the database allows one open question per conversation', async () => {
		await store.openQuestion(question());

		const insert = db
			.prepare(`INSERT INTO questions
			(id, conversation_id, channel_id, thread_ts, kind, title, recommendation, status, created_at)
			VALUES ('q2', 'conv-a', 'C1', '1', 'open', 'Why?', 'Explain.', 'open', ?1)`)
			.bind(NOW);

		await expect(insert.run()).rejects.toThrow(/UNIQUE/);
	});

	test('records the posted message timestamp, including after closure', async () => {
		await store.openQuestion(question());
		await store.closeQuestion('q1', LATER);
		const recorded = await store.setMessageTs('q1', '1710000000.123456');
		const missing = await store.setMessageTs('missing', '1');
		const saved = await store.getQuestion('q1');
		expect([recorded, missing]).toEqual([true, false]);
		expect(saved?.messageTs).toBe('1710000000.123456');
	});

	test('the first submit wins and keeps its attribution', async () => {
		await store.openQuestion(question());
		const first = await submit('q1', 'U1', 'Maya', LATER);
		const second = await submit('q1', 'U2', 'Raj', NOW);
		const close = await store.closeQuestion('q1', NOW);
		const open = await store.getOpenQuestion('conv-a');
		const saved = await store.getQuestion('q1');
		expect([first, second, close]).toEqual([true, false, false]);
		expect(open).toBeUndefined();
		expect(saved).toMatchObject({
			status: 'submitted',
			submittedBy: 'U1',
			submittedByName: 'Maya',
			closedAt: LATER,
		});
	});

	test('a closed or missing question cannot be closed again or submitted', async () => {
		await store.openQuestion(question());
		const first = await store.closeQuestion('q1', LATER);
		const again = await store.closeQuestion('q1', NOW);
		const closeMissing = await store.closeQuestion('missing', NOW);
		const submitClosed = await submit('q1', 'U1', 'Maya', NOW);
		const submitMissing = await submit('missing', 'U1', 'Maya', NOW);
		const saved = await store.getQuestion('q1');
		expect([first, again, closeMissing, submitClosed, submitMissing]).toEqual([
			true,
			false,
			false,
			false,
			false,
		]);
		expect(saved).toMatchObject({ status: 'closed', closedAt: LATER });
	});

	test('participants keep their first join time, ordered and per conversation', async () => {
		await store.upsertParticipant({ conversationId: 'conv-a', userId: 'U2', joinedAt: NOW });
		await store.upsertParticipant({ conversationId: 'conv-a', userId: 'U1', joinedAt: NOW });
		await store.upsertParticipant({ conversationId: 'conv-a', userId: 'U1', joinedAt: LATER });
		await store.upsertParticipant({ conversationId: 'conv-b', userId: 'U1', joinedAt: LATER });
		const participants = await store.listParticipants('conv-a');
		const other = await store.listParticipants('conv-b');
		expect(participants).toEqual([
			{ conversationId: 'conv-a', userId: 'U1', joinedAt: NOW },
			{ conversationId: 'conv-a', userId: 'U2', joinedAt: NOW },
		]);
		expect(other).toHaveLength(1);
	});

	test('a user has one vote and can change its choice and display name', async () => {
		await store.openQuestion(question());
		const changed = { ...vote('U2', 'B'), userName: 'Raj', updatedAt: LATER };
		const first = await store.upsertVote(vote('U2'));
		const second = await store.upsertVote(changed);
		await store.upsertVote(vote('U1', 'B'));
		const votes = await store.listVotes('q1');
		expect([first, second]).toEqual([true, true]);
		expect(votes).toEqual([vote('U1', 'B'), changed]);
	});

	test('rejects votes for unknown choices and missing, submitted or open-ended questions', async () => {
		await store.openQuestion(question());
		await store.upsertVote(vote());
		const unknownChoice = await store.upsertVote(vote('U1', 'missing'));
		const missing = await store.upsertVote(vote('U1', 'A', 'missing'));
		await submit('q1', 'U1', 'Maya', LATER);
		const submitted = await store.upsertVote(vote('U1', 'B'));
		await store.openQuestion(openEnded('q2'));
		const open = await store.upsertVote(vote('U1', 'A', 'q2'));
		const votes = await store.listVotes('q1');
		expect([unknownChoice, missing, submitted, open]).toEqual([false, false, false, false]);
		expect(votes).toEqual([vote()]);
	});
});
