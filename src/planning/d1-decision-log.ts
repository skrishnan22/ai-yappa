import * as v from 'valibot';
import type { JsonObject } from '../json.ts';
import type { D1Database, D1Statement } from '../memory/d1.ts';
import type { CardRevision, CardWording, PlanningStore } from './decision-log.ts';

// Decisions store only the choice id, so ids must be unique within a card.
// Applied on write and on read, so every stored card stays readable.
const choicesSchema = v.pipe(
	v.array(v.object({ id: v.string(), label: v.string() })),
	v.minLength(2),
	v.maxLength(5),
	v.check(
		(choices) => new Set(choices.map((choice) => choice.id)).size === choices.length,
		'Choice ids must be unique',
	),
);

const choicesJsonSchema = v.pipe(v.string(), v.parseJson(), choicesSchema);

const revisionRowSchema = v.object({
	card_id: v.string(),
	revision: v.number(),
	conversation_id: v.string(),
	channel_id: v.string(),
	thread_ts: v.string(),
	message_ts: v.nullable(v.string()),
	question: v.string(),
	context: v.nullable(v.string()),
	recommendation: v.string(),
	choices: v.nullable(v.string()),
	choice_id: v.nullable(v.string()),
	custom_answer: v.nullable(v.string()),
	reasoning: v.nullable(v.string()),
	decided_by: v.nullable(v.string()),
	decided_by_name: v.nullable(v.string()),
	decided_at: v.nullable(v.string()),
	created_at: v.string(),
});

const SQL = {
	insertRevision: `INSERT INTO card_revisions
		(card_id, revision, conversation_id, channel_id, thread_ts, message_ts, question, context, recommendation, choices, created_at)
		VALUES (?1, 1, ?2, ?3, ?4, ?10, ?5, ?6, ?7, ?8, ?9)`,
	latest: 'SELECT * FROM card_revisions WHERE card_id = ?1 ORDER BY revision DESC LIMIT 1',
	setMessageTs: 'UPDATE card_revisions SET message_ts = ?2 WHERE card_id = ?1',
	decide: `UPDATE card_revisions
		SET choice_id = ?3, custom_answer = ?4, reasoning = ?5, decided_by = ?6, decided_by_name = ?7, decided_at = ?8
		WHERE card_id = ?1 AND revision = ?2 AND decided_at IS NULL
			AND revision = (SELECT MAX(revision) FROM card_revisions WHERE card_id = ?1)`,
	reopen: `INSERT INTO card_revisions
		(card_id, revision, conversation_id, channel_id, thread_ts, message_ts, question, context, recommendation, choices, created_at)
		SELECT card_id, revision + 1, conversation_id, channel_id, thread_ts, message_ts, question, context, recommendation, choices, ?2
		FROM card_revisions
		WHERE card_id = ?1 AND revision = ?3 AND decided_at IS NOT NULL
			AND revision = (SELECT MAX(revision) FROM card_revisions WHERE card_id = ?1)
		RETURNING *`,
	reword: `INSERT INTO card_revisions
		(card_id, revision, conversation_id, channel_id, thread_ts, message_ts, question, context, recommendation, choices, created_at)
		SELECT card_id, revision + 1, conversation_id, channel_id, thread_ts, message_ts, ?3, ?4, ?5, ?6, ?2
		FROM card_revisions
		WHERE card_id = ?1 AND decided_at IS NULL
			AND revision = (SELECT MAX(revision) FROM card_revisions WHERE card_id = ?1)
		RETURNING *`,
	conversationRevisions:
		'SELECT * FROM card_revisions WHERE conversation_id = ?1 ORDER BY created_at, card_id, revision',
	startSession: `INSERT INTO planning_sessions (conversation_id, started_at) VALUES (?1, ?2)
		ON CONFLICT (conversation_id) DO UPDATE SET started_at = ?2, ended_at = NULL`,
	endSession:
		'UPDATE planning_sessions SET ended_at = ?2 WHERE conversation_id = ?1 AND ended_at IS NULL',
	activeSession:
		'SELECT 1 AS active FROM planning_sessions WHERE conversation_id = ?1 AND ended_at IS NULL',
} as const;

function choicesColumn(wording: CardWording): string | null {
	return wording.choices ? JSON.stringify(v.parse(choicesSchema, wording.choices)) : null;
}

function readRevision(raw: JsonObject): CardRevision {
	const row = v.parse(revisionRowSchema, raw);

	return {
		cardId: row.card_id,
		revision: row.revision,
		conversationId: row.conversation_id,
		channelId: row.channel_id,
		threadTs: row.thread_ts,
		messageTs: row.message_ts ?? undefined,
		question: row.question,
		context: row.context ?? undefined,
		recommendation: row.recommendation,
		choices: row.choices ? v.parse(choicesJsonSchema, row.choices) : undefined,
		createdAt: row.created_at,
		decision:
			row.decided_at && row.decided_by && row.decided_by_name
				? {
						choiceId: row.choice_id ?? undefined,
						customAnswer: row.custom_answer ?? undefined,
						reasoning: row.reasoning ?? undefined,
						decidedBy: row.decided_by,
						decidedByName: row.decided_by_name,
						decidedAt: row.decided_at,
					}
				: undefined,
	};
}

export function createD1PlanningStore(db: D1Database): PlanningStore {
	async function latest(cardId: string) {
		const { results } = await db.prepare(SQL.latest).bind(cardId).all();
		const [row] = results;

		return row ? readRevision(row) : undefined;
	}

	// Returns the row this statement inserted: re-reading the latest could
	// return a later writer's revision. A concurrent writer that took the next
	// revision number collides on the primary key; that is a lost race, not an error.
	async function insertNext(statement: D1Statement) {
		try {
			const { results } = await statement.all();
			const [row] = results;

			return row ? readRevision(row) : undefined;
		} catch (error) {
			if (error instanceof Error && /UNIQUE|PRIMARY KEY/.test(error.message)) return undefined;

			throw error;
		}
	}

	return {
		log: {
			async ask(card) {
				await db
					.prepare(SQL.insertRevision)
					.bind(
						card.cardId,
						card.conversationId,
						card.channelId,
						card.threadTs,
						card.question,
						card.context ?? null,
						card.recommendation,
						choicesColumn(card),
						card.createdAt,
						card.messageTs ?? null,
					)
					.run();

				const revision = await latest(card.cardId);

				if (!revision) throw new Error(`Card ${card.cardId} was not stored`);

				return revision;
			},
			async setMessageTs(cardId, messageTs) {
				await db.prepare(SQL.setMessageTs).bind(cardId, messageTs).run();
			},
			latest,
			async decide({ cardId, revision, decision }) {
				const { meta } = await db
					.prepare(SQL.decide)
					.bind(
						cardId,
						revision,
						decision.choiceId ?? null,
						decision.customAnswer ?? null,
						decision.reasoning ?? null,
						decision.decidedBy,
						decision.decidedByName,
						decision.decidedAt,
					)
					.run();

				return meta.changes === 1;
			},
			reopen: ({ cardId, revision, createdAt }) =>
				insertNext(db.prepare(SQL.reopen).bind(cardId, createdAt, revision)),
			reword: ({ cardId, createdAt, ...wording }) =>
				insertNext(
					db
						.prepare(SQL.reword)
						.bind(
							cardId,
							createdAt,
							wording.question,
							wording.context ?? null,
							wording.recommendation,
							choicesColumn(wording),
						),
				),
			async listCards(conversationId) {
				const { results } = await db.prepare(SQL.conversationRevisions).bind(conversationId).all();
				const byCard = new Map<string, CardRevision[]>();

				for (const raw of results) {
					const revision = readRevision(raw);
					const revisions = byCard.get(revision.cardId) ?? [];

					revisions.push(revision);
					byCard.set(revision.cardId, revisions);
				}

				return [...byCard.values()].map((revisions, index) => {
					const sorted = revisions.toSorted((a, b) => a.revision - b.revision);

					return {
						label: `D${index + 1}`,
						latest: sorted[sorted.length - 1]!,
						history: sorted.slice(0, -1),
					};
				});
			},
		},
		sessions: {
			async start(conversationId, at) {
				await db.prepare(SQL.startSession).bind(conversationId, at).run();
			},
			async end(conversationId, at) {
				const { meta } = await db.prepare(SQL.endSession).bind(conversationId, at).run();

				return meta.changes === 1;
			},
			async isActive(conversationId) {
				const { results } = await db.prepare(SQL.activeSession).bind(conversationId).all();

				return results.length > 0;
			},
		},
	};
}
