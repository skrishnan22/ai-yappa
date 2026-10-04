import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openMigratedSqlite } from '../memory/testing/sqlite-d1.ts';
import { createQuestionStore } from './d1-store.ts';
import type { OpenQuestion, QuestionStore, Vote } from './store.ts';
import { createMemoryQuestionStore } from './testing/memory-store.ts';

const NOW = '2026-10-04T00:00:00.000Z';

const LATER = '2026-10-04T00:01:00.000Z';

function question(id = 'q1', conversationId = 'conv-a'): OpenQuestion {
	return {
		id,
		conversationId,
		channelId: 'C1',
		threadTs: '1710000000.000001',
		title: 'Where should state live?',
		body: '',
		recommendation: 'Use D1.',
		createdAt: NOW,
		status: 'open',
		kind: 'choice',
		choices: [
			{ id: 'A', label: 'KV', recommended: false },
			{ id: 'B', label: 'D1', recommended: true },
		],
	};
}

function vote(userId = 'U1', choiceId = 'A', questionId = 'q1'): Vote {
	return { questionId, userId, choiceId, userName: userId, updatedAt: NOW };
}

const implementations = [
	{
		name: 'D1 SQLite',
		create: () => {
			const db = openMigratedSqlite();

			return { store: createQuestionStore(db), dispose: () => db.close() };
		},
	},
	{
		name: 'in-memory fake',
		create: () => {
			return { store: createMemoryQuestionStore(), dispose: () => undefined };
		},
	},
];

describe.each(implementations)('QuestionStore: $name', ({ create }) => {
	let store: QuestionStore;
	let dispose: () => void;

	beforeEach(() => {
		const instance = create();
		store = instance.store;
		dispose = instance.dispose;
	});
	afterEach(() => dispose());

	test('round-trips choice and open questions in separate conversations', async () => {
		const choice = question();

		const open: OpenQuestion = {
			id: 'q2',
			conversationId: 'conv-b',
			channelId: 'C2',
			threadTs: '2',
			title: 'What should we grill?',
			recommendation: 'Pick a plan.',
			kind: 'open',
			status: 'open',
			createdAt: NOW,
		};

		await store.openQuestion(choice);
		await store.openQuestion(open);
		const savedChoice = await store.getQuestion('q1');
		const savedOpen = await store.getOpenQuestion('conv-b');
		const missing = await store.getQuestion('missing');
		const emptyThread = await store.getOpenQuestion('missing');
		expect(savedChoice).toEqual(choice);
		expect(savedOpen).toEqual(open);
		expect(missing).toBeUndefined();
		expect(emptyThread).toBeUndefined();
	});

	test('atomically replaces the open question in only its conversation', async () => {
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

	test('failed replacement preserves the previous open question', async () => {
		await store.openQuestion(question());
		await store.openQuestion(question('duplicate', 'conv-b'));
		await expect(store.openQuestion(question('duplicate'))).rejects.toThrow(
			/already exists|UNIQUE/,
		);
		const current = await store.getOpenQuestion('conv-a');
		const other = await store.getOpenQuestion('conv-b');
		expect(current?.id).toBe('q1');
		expect(other?.id).toBe('duplicate');
	});

	test('records a posted message timestamp, including after closure', async () => {
		await store.openQuestion(question());
		await store.closeQuestion('q1', LATER);
		const recorded = await store.setMessageTs('q1', '1710000000.123456');
		const missing = await store.setMessageTs('missing', '1');
		const saved = await store.getQuestion('q1');
		expect(recorded).toBe(true);
		expect(missing).toBe(false);
		expect(saved?.messageTs).toBe('1710000000.123456');
	});

	test('concurrent submits have one winner and preserve attribution', async () => {
		await store.openQuestion(question());

		const results = await Promise.all([
			store.submitQuestion({ questionId: 'q1', userId: 'U1', userName: 'Maya', closedAt: LATER }),
			store.submitQuestion({ questionId: 'q1', userId: 'U2', userName: 'Raj', closedAt: NOW }),
		]);

		const saved = await store.getQuestion('q1');
		const open = await store.getOpenQuestion('conv-a');
		const closedAgain = await store.closeQuestion('q1', NOW);
		expect(results).toEqual([true, false]);
		expect(saved).toMatchObject({
			status: 'submitted',
			submittedBy: 'U1',
			submittedByName: 'Maya',
			closedAt: LATER,
		});
		expect(open).toBeUndefined();
		expect(closedAgain).toBe(false);
	});

	test('close is first-wins and a closed question cannot submit', async () => {
		await store.openQuestion(question());
		const first = await store.closeQuestion('q1', LATER);
		const again = await store.closeQuestion('q1', NOW);

		const submitted = await store.submitQuestion({
			questionId: 'q1',
			userId: 'U1',
			userName: 'Maya',
			closedAt: NOW,
		});

		const missing = await store.closeQuestion('missing', NOW);

		const missingSubmit = await store.submitQuestion({
			questionId: 'missing',
			userId: 'U1',
			userName: 'Maya',
			closedAt: NOW,
		});

		const saved = await store.getQuestion('q1');
		expect(first).toBe(true);
		expect(again).toBe(false);
		expect(submitted).toBe(false);
		expect(missing).toBe(false);
		expect(missingSubmit).toBe(false);
		expect(saved).toMatchObject({ status: 'closed', closedAt: LATER });
	});

	test('participants are idempotent, ordered and isolated by conversation', async () => {
		await store.upsertParticipant({ conversationId: 'conv-a', userId: 'U2', joinedAt: NOW });
		await store.upsertParticipant({ conversationId: 'conv-a', userId: 'U1', joinedAt: NOW });
		await store.upsertParticipant({ conversationId: 'conv-a', userId: 'U1', joinedAt: LATER });
		await store.upsertParticipant({ conversationId: 'conv-b', userId: 'U1', joinedAt: LATER });
		const participants = await store.listParticipants('conv-a');
		const other = await store.listParticipants('conv-b');
		const empty = await store.listParticipants('missing');
		expect(participants).toEqual([
			{ conversationId: 'conv-a', userId: 'U1', joinedAt: NOW },
			{ conversationId: 'conv-a', userId: 'U2', joinedAt: NOW },
		]);
		expect(other).toEqual([{ conversationId: 'conv-b', userId: 'U1', joinedAt: LATER }]);
		expect(empty).toEqual([]);
	});

	test('upserts one vote per user, carrying the changed choice and display name', async () => {
		await store.openQuestion(question());
		const first = await store.upsertVote(vote('U2'));

		const changed = await store.upsertVote({
			...vote('U2', 'B'),
			userName: 'Raj',
			updatedAt: LATER,
		});

		await store.upsertVote(vote('U1', 'B'));
		const votes = await store.listVotes('q1');
		const other = await store.listVotes('missing');
		expect(first).toBe(true);
		expect(changed).toBe(true);
		expect(votes).toEqual([
			vote('U1', 'B'),
			{ ...vote('U2', 'B'), userName: 'Raj', updatedAt: LATER },
		]);
		expect(other).toEqual([]);
	});

	test('rejects invalid choices and votes on missing, open-ended or closed questions', async () => {
		await store.openQuestion(question());
		await store.upsertVote(vote());
		const invalid = await store.upsertVote(vote('U1', 'missing'));
		const missing = await store.upsertVote(vote('U1', 'A', 'missing'));
		await store.closeQuestion('q1', LATER);
		const closed = await store.upsertVote(vote('U1', 'B'));
		await store.openQuestion({
			id: 'open',
			conversationId: 'conv-a',
			channelId: 'C1',
			threadTs: '1',
			title: 'Why?',
			recommendation: 'Explain.',
			kind: 'open',
			status: 'open',
			createdAt: NOW,
		});
		const openEnded = await store.upsertVote(vote('U1', 'A', 'open'));
		const votes = await store.listVotes('q1');
		expect([invalid, missing, closed, openEnded]).toEqual([false, false, false, false]);
		expect(votes).toEqual([vote()]);
	});

	test('submitted questions retain votes and reject subsequent changes', async () => {
		await store.openQuestion(question());
		await store.upsertVote(vote());
		await store.submitQuestion({
			questionId: 'q1',
			userId: 'U1',
			userName: 'Maya',
			closedAt: LATER,
		});
		const changed = await store.upsertVote(vote('U1', 'B'));
		const votes = await store.listVotes('q1');
		expect(changed).toBe(false);
		expect(votes).toEqual([vote()]);
	});

	test('does not expose mutable persistence through inputs or returned values', async () => {
		const input = question();
		await store.openQuestion(input);
		input.title = 'Changed input';

		if (input.kind === 'choice' && input.choices[0]) input.choices[0].label = 'Changed input';
		const returned = await store.getQuestion('q1');

		if (returned) returned.title = 'Changed output';

		if (returned?.kind === 'choice' && returned.choices[0])
			returned.choices[0].label = 'Changed output';
		const saved = await store.getQuestion('q1');
		expect(saved).toEqual(question());
	});
});

describe('QuestionStore SQL constraints and storage decoding', () => {
	let db: ReturnType<typeof openMigratedSqlite>;

	beforeEach(() => {
		db = openMigratedSqlite();
	});
	afterEach(() => db.close());

	test('the database rejects two open questions in the same conversation', async () => {
		const store = createQuestionStore(db);
		await store.openQuestion(question());

		const insert = db
			.prepare(`INSERT INTO questions
			(id, conversation_id, channel_id, thread_ts, kind, title, recommendation, status, created_at)
			VALUES ('q2', 'conv-a', 'C1', '1', 'open', 'Why?', 'Explain.', 'open', ?1)`)
			.bind(NOW);

		await expect(insert.run()).rejects.toThrow(/UNIQUE/);
		const current = await store.getOpenQuestion('conv-a');
		expect(current?.id).toBe('q1');
	});

	test.each([
		['unknown kind', 'other', null, 'open', null, null, null],
		['unknown status', 'open', null, 'other', null, null, null],
		['missing submission attribution', 'open', null, 'submitted', LATER, null, null],
		['missing close time', 'open', null, 'closed', null, null, null],
		['choices on an open-ended question', 'open', '[]', 'open', null, null, null],
		['missing choices on a choice question', 'choice', null, 'open', null, null, null],
		['too few choices', 'choice', '[]', 'open', null, null, null],
		['non-array choices', 'choice', '{}', 'open', null, null, null],
		['malformed choices', 'choice', 'not-json', 'open', null, null, null],
	])(
		'rejects %s',
		async (_label, kind, choices, status, closedAt, submittedBy, submittedByName) => {
			const insert = db
				.prepare(`INSERT INTO questions
			(id, conversation_id, channel_id, thread_ts, kind, title, recommendation, choices, status, created_at, closed_at, submitted_by, submitted_by_name)
			VALUES ('invalid', 'conv-a', 'C1', '1', ?1, 'Why?', 'Explain.', ?2, ?3, ?4, ?5, ?6, ?7)`)
				.bind(kind, choices, status, NOW, closedAt, submittedBy, submittedByName);

			await expect(insert.run()).rejects.toThrow(/CHECK|malformed JSON/);
		},
	);

	test('validates JSON choice contents when reading persisted data', async () => {
		await db
			.prepare(`INSERT INTO questions
			(id, conversation_id, channel_id, thread_ts, kind, title, recommendation, choices, status, created_at)
			VALUES ('invalid', 'conv-a', 'C1', '1', 'choice', 'Why?', 'Explain.', '[{"id":"A"},{"id":"B"}]', 'open', ?1)`)
			.bind(NOW)
			.run();
		const store = createQuestionStore(db);
		await expect(store.getQuestion('invalid')).rejects.toThrow(/label/);
	});

	test('propagates database failures instead of returning empty data', async () => {
		await db.prepare('DROP TABLE questions').run();
		const store = createQuestionStore(db);
		await expect(store.getQuestion('q1')).rejects.toThrow(/no such table/);
	});
});
