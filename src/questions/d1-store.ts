import * as v from 'valibot';
import type { JsonObject } from '../json.ts';
import type { D1Database, D1Statement, D1Value } from '../memory/d1.ts';
import type {
	OpenQuestion,
	Question,
	QuestionKind,
	QuestionState,
	QuestionStore,
} from './store.ts';

// Votes store only the choice id, so ids must be unique within a question.
// Applied on write and on read, so every stored question stays readable.
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
	v.check(
		(choices) => new Set(choices.map((choice) => choice.id)).size === choices.length,
		'Choice ids must be unique',
	),
);

const choicesJsonSchema = v.pipe(v.string(), v.parseJson(), choicesSchema);

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

type QuestionRow = v.InferOutput<typeof questionRowSchema>;

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

const SQL = {
	closeOpenQuestion:
		"UPDATE questions SET status = 'closed', closed_at = ?2 WHERE conversation_id = ?1 AND status = 'open'",
	questionById: 'SELECT * FROM questions WHERE id = ?1',
	openQuestion: "SELECT * FROM questions WHERE conversation_id = ?1 AND status = 'open'",
	setMessageTs: 'UPDATE questions SET message_ts = ?2 WHERE id = ?1',
	finishQuestion: `UPDATE questions
		SET status = ?2, closed_at = ?3, submitted_by = ?4, submitted_by_name = ?5
		WHERE id = ?1 AND status = 'open'`,
	addParticipant: `INSERT INTO thread_participants (conversation_id, user_id, joined_at)
		VALUES (?1, ?2, ?3) ON CONFLICT (conversation_id, user_id) DO NOTHING`,
	listParticipants:
		'SELECT * FROM thread_participants WHERE conversation_id = ?1 ORDER BY joined_at, user_id',
	upsertVote: `INSERT INTO votes (question_id, user_id, choice_id, user_name, updated_at)
		SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (
			SELECT 1 FROM questions q, json_each(q.choices) choice
			WHERE q.id = ?1 AND q.status = 'open' AND q.kind = 'choice'
			AND json_extract(choice.value, '$.id') = ?3
		) ON CONFLICT (question_id, user_id) DO UPDATE SET
		choice_id = excluded.choice_id, user_name = excluded.user_name, updated_at = excluded.updated_at`,
	listVotes: 'SELECT * FROM votes WHERE question_id = ?1 ORDER BY user_id',
};

// Column values for a new question; readQuestion is the inverse.
function toRow(question: OpenQuestion) {
	return {
		id: question.id,
		conversation_id: question.conversationId,
		channel_id: question.channelId,
		thread_ts: question.threadTs,
		message_ts: question.messageTs ?? null,
		kind: question.kind,
		title: question.title,
		body: question.body ?? null,
		recommendation: question.recommendation,
		choices:
			question.kind === 'choice' ? JSON.stringify(v.parse(choicesSchema, question.choices)) : null,
		status: 'open',
		created_at: question.createdAt,
	} satisfies Record<string, D1Value>;
}

function readState(row: QuestionRow): QuestionState {
	if (row.status === 'open') return { status: 'open' };

	const closedAt = v.parse(v.string(), row.closed_at);

	if (row.status === 'closed') return { status: 'closed', closedAt };

	return {
		status: 'submitted',
		closedAt,
		submittedBy: v.parse(v.string(), row.submitted_by),
		submittedByName: v.parse(v.string(), row.submitted_by_name),
	};
}

function readQuestion(raw: JsonObject): Question {
	const row = v.parse(questionRowSchema, raw);

	const kind: QuestionKind =
		row.kind === 'choice'
			? { kind: 'choice', choices: v.parse(choicesJsonSchema, row.choices) }
			: { kind: 'open' };

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
		...kind,
		...readState(row),
	};
}

export function createQuestionStore(db: D1Database): QuestionStore {
	async function firstQuestion(statement: D1Statement) {
		const { results } = await statement.all();
		const [row] = results;

		return row ? readQuestion(row) : undefined;
	}

	return {
		// Close-then-insert in one batch, which D1 runs as one transaction: if the
		// insert fails, the previous question stays open. The insert alone would
		// hit one_open_question while the previous question is still open.
		async openQuestion(question) {
			const row = toRow(question);
			const columns = Object.keys(row);
			const placeholders = columns.map(() => '?').join(', ');

			await db.batch([
				db.prepare(SQL.closeOpenQuestion).bind(question.conversationId, question.createdAt),
				db
					.prepare(`INSERT INTO questions (${columns.join(', ')}) VALUES (${placeholders})`)
					.bind(...Object.values(row)),
			]);
		},
		getQuestion: (questionId) => firstQuestion(db.prepare(SQL.questionById).bind(questionId)),
		getOpenQuestion: (conversationId) =>
			firstQuestion(db.prepare(SQL.openQuestion).bind(conversationId)),
		async setMessageTs(questionId, messageTs) {
			const { meta } = await db.prepare(SQL.setMessageTs).bind(questionId, messageTs).run();

			return meta.changes === 1;
		},
		// Only an open row matches, so exactly one caller sees changes === 1.
		async finishQuestion(questionId, end) {
			const submitter = end.status === 'submitted' ? end : undefined;

			const { meta } = await db
				.prepare(SQL.finishQuestion)
				.bind(
					questionId,
					end.status,
					end.closedAt,
					submitter?.submittedBy ?? null,
					submitter?.submittedByName ?? null,
				)
				.run();

			return meta.changes === 1;
		},
		// DO NOTHING keeps the first join time.
		async upsertParticipant({ conversationId, userId, joinedAt }) {
			await db.prepare(SQL.addParticipant).bind(conversationId, userId, joinedAt).run();
		},
		async listParticipants(conversationId) {
			const { results } = await db.prepare(SQL.listParticipants).bind(conversationId).all();
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
				.prepare(SQL.upsertVote)
				.bind(vote.questionId, vote.userId, vote.choiceId, vote.userName, vote.updatedAt)
				.run();

			return meta.changes === 1;
		},
		async listVotes(questionId) {
			const { results } = await db.prepare(SQL.listVotes).bind(questionId).all();
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
