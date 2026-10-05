import * as v from 'valibot';
import type { JsonObject } from '../json.ts';
import type { D1Database } from '../memory/d1.ts';
import type { Question, QuestionContent, QuestionState, QuestionStore } from './store.ts';

const questionRowSchema = v.object({
	id: v.string(),
	conversation_id: v.string(),
	channel_id: v.string(),
	thread_ts: v.string(),
	message_ts: v.nullable(v.string()),
	kind: v.picklist(['open', 'choice']),
	title: v.string(),
	body: v.nullable(v.string()),
	recommendation: v.string(),
	choices: v.nullable(v.string()),
	status: v.picklist(['open', 'closed', 'submitted']),
	submitted_by: v.nullable(v.string()),
	submitted_by_name: v.nullable(v.string()),
	created_at: v.string(),
	closed_at: v.nullable(v.string()),
});

const choicesSchema = v.pipe(
	v.array(
		v.object({
			id: v.string(),
			label: v.string(),
			recommended: v.optional(v.boolean()),
		}),
	),
	v.minLength(2),
	v.maxLength(5),
);

const participantRowSchema = v.object({
	conversation_id: v.string(),
	user_id: v.string(),
	joined_at: v.string(),
});

const voteRowSchema = v.object({
	question_id: v.string(),
	user_id: v.string(),
	choice_id: v.string(),
	user_name: v.string(),
	updated_at: v.string(),
});

// Rebuilds the discriminated Question from a flat row; throws on a row whose
// kind/status columns are inconsistent.
function readQuestion(raw: JsonObject): Question {
	const row = v.parse(questionRowSchema, raw);
	let content: QuestionContent;

	if (row.kind === 'choice') {
		const json: unknown = JSON.parse(v.parse(v.string(), row.choices));
		content = { kind: 'choice', choices: v.parse(choicesSchema, json) };
	} else {
		content = { kind: 'open' };
	}

	let state: QuestionState;

	switch (row.status) {
		case 'open':
			state = { status: 'open' };
			break;
		case 'closed':
			state = { status: 'closed', closedAt: v.parse(v.string(), row.closed_at) };
			break;
		case 'submitted':
			state = {
				status: 'submitted',
				closedAt: v.parse(v.string(), row.closed_at),
				submittedBy: v.parse(v.string(), row.submitted_by),
				submittedByName: v.parse(v.string(), row.submitted_by_name),
			};
			break;
	}

	return {
		id: row.id,
		conversationId: row.conversation_id,
		channelId: row.channel_id,
		threadTs: row.thread_ts,
		messageTs: row.message_ts ?? undefined,
		title: row.title,
		body: row.body ?? undefined,
		recommendation: row.recommendation,
		createdAt: row.created_at,
		...content,
		...state,
	};
}

export function createQuestionStore(db: D1Database): QuestionStore {
	return {
		// Close-then-insert in one batch (one D1 transaction): if the insert fails,
		// the previous question stays open. one_open_question backs this up.
		async openQuestion(question) {
			await db.batch([
				db
					.prepare(
						"UPDATE questions SET status = 'closed', closed_at = ?2 WHERE conversation_id = ?1 AND status = 'open'",
					)
					.bind(question.conversationId, question.createdAt),
				db
					.prepare(`INSERT INTO questions
					(id, conversation_id, channel_id, thread_ts, message_ts, kind, title, body, recommendation, choices, status, created_at)
					VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'open', ?11)`)
					.bind(
						question.id,
						question.conversationId,
						question.channelId,
						question.threadTs,
						question.messageTs ?? null,
						question.kind,
						question.title,
						question.body ?? null,
						question.recommendation,
						question.kind === 'choice' ? JSON.stringify(question.choices) : null,
						question.createdAt,
					),
			]);
		},
		async getQuestion(questionId) {
			const { results } = await db
				.prepare('SELECT * FROM questions WHERE id = ?1')
				.bind(questionId)
				.all();

			const [row] = results;

			return row ? readQuestion(row) : undefined;
		},
		async getOpenQuestion(conversationId) {
			const { results } = await db
				.prepare("SELECT * FROM questions WHERE conversation_id = ?1 AND status = 'open'")
				.bind(conversationId)
				.all();

			const [row] = results;

			if (!row) return undefined;

			const question = readQuestion(row);

			// Unreachable given the WHERE clause; narrows the type without a cast.
			if (question.status !== 'open') throw new Error('Expected an open question');

			return question;
		},
		async setMessageTs(questionId, messageTs) {
			const { meta } = await db
				.prepare('UPDATE questions SET message_ts = ?2 WHERE id = ?1')
				.bind(questionId, messageTs)
				.run();

			return meta.changes === 1;
		},
		// Close and submit only touch an open row, so exactly one caller sees
		// changes === 1 and wins; later callers get false.
		async closeQuestion(questionId, closedAt) {
			const { meta } = await db
				.prepare(
					"UPDATE questions SET status = 'closed', closed_at = ?2 WHERE id = ?1 AND status = 'open'",
				)
				.bind(questionId, closedAt)
				.run();

			return meta.changes === 1;
		},
		async submitQuestion({ questionId, userId, userName, closedAt }) {
			const { meta } = await db
				.prepare(`UPDATE questions SET status = 'submitted', submitted_by = ?2,
				submitted_by_name = ?3, closed_at = ?4 WHERE id = ?1 AND status = 'open'`)
				.bind(questionId, userId, userName, closedAt)
				.run();

			return meta.changes === 1;
		},
		// DO NOTHING keeps the first join time.
		async upsertParticipant({ conversationId, userId, joinedAt }) {
			await db
				.prepare(`INSERT INTO thread_participants (conversation_id, user_id, joined_at)
				VALUES (?1, ?2, ?3) ON CONFLICT (conversation_id, user_id) DO NOTHING`)
				.bind(conversationId, userId, joinedAt)
				.run();
		},
		async listParticipants(conversationId) {
			const { results } = await db
				.prepare(
					'SELECT * FROM thread_participants WHERE conversation_id = ?1 ORDER BY joined_at, user_id',
				)
				.bind(conversationId)
				.all();

			const rows = v.parse(v.array(participantRowSchema), results);

			return rows.map((row) => ({
				conversationId: row.conversation_id,
				userId: row.user_id,
				joinedAt: row.joined_at,
			}));
		},
		// Insert or change one vote per user, only while the question is an open
		// choice question that has this choice id. Returns false otherwise.
		async upsertVote(vote) {
			const { meta } = await db
				.prepare(`INSERT INTO votes (question_id, user_id, choice_id, user_name, updated_at)
				SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (
					SELECT 1 FROM questions q, json_each(q.choices) choice
					WHERE q.id = ?1 AND q.status = 'open' AND q.kind = 'choice'
					AND json_extract(choice.value, '$.id') = ?3
				) ON CONFLICT (question_id, user_id) DO UPDATE SET
				choice_id = excluded.choice_id, user_name = excluded.user_name, updated_at = excluded.updated_at`)
				.bind(vote.questionId, vote.userId, vote.choiceId, vote.userName, vote.updatedAt)
				.run();

			return meta.changes === 1;
		},
		async listVotes(questionId) {
			const { results } = await db
				.prepare('SELECT * FROM votes WHERE question_id = ?1 ORDER BY user_id')
				.bind(questionId)
				.all();

			const rows = v.parse(v.array(voteRowSchema), results);

			return rows.map((row) => ({
				questionId: row.question_id,
				userId: row.user_id,
				choiceId: row.choice_id,
				userName: row.user_name,
				updatedAt: row.updated_at,
			}));
		},
	};
}
