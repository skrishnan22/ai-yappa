import * as v from 'valibot';
import type { JsonObject } from '../json.ts';
import type { D1Database, D1Value } from '../memory/d1.ts';
import type { Automation, AutomationFields, AutomationRun, AutomationStore } from './automation.ts';

const automationRowSchema = v.object({
	id: v.string(),
	kind: v.picklist(['agent', 'reminder']),
	owner_user_id: v.string(),
	scope: v.picklist(['personal', 'channel']),
	destination_channel_id: v.string(),
	repo: v.nullable(v.string()),
	title: v.string(),
	prompt: v.string(),
	schedule: v.nullable(v.string()),
	run_at: v.nullable(v.string()),
	timezone: v.string(),
	next_run_at: v.nullable(v.string()),
	last_run_at: v.nullable(v.string()),
	status: v.picklist(['active', 'paused', 'blocked', 'completed', 'deleted']),
	consecutive_failures: v.number(),
	created_at: v.string(),
	updated_at: v.string(),
});

const runRowSchema = v.object({
	automation_id: v.string(),
	fire_time: v.string(),
	status: v.picklist(['claimed', 'dispatched', 'posted', 'failed', 'succeeded']),
	conversation_id: v.nullable(v.string()),
	submission_id: v.nullable(v.string()),
	reason: v.nullable(v.string()),
	created_at: v.string(),
});

// The field columns, in fieldValues() order, bind as ?2..?10 below.
const FIELDS =
	'kind, scope, destination_channel_id, repo, title, prompt, schedule, run_at, timezone';

const SET_FIELDS =
	'kind = ?2, scope = ?3, destination_channel_id = ?4, repo = ?5, title = ?6, prompt = ?7, schedule = ?8, run_at = ?9, timezone = ?10';

const SQL = {
	insert: `INSERT INTO automations (id, ${FIELDS}, owner_user_id, next_run_at, status, created_at, updated_at)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'active', ?13, ?13) RETURNING *`,
	get: 'SELECT * FROM automations WHERE id = ?1',
	due: `SELECT * FROM automations WHERE status = 'active' AND next_run_at <= ?1
		ORDER BY next_run_at LIMIT ?2`,
	visible: `SELECT * FROM automations WHERE status <> 'deleted'
		AND ((scope = 'personal' AND owner_user_id = ?1) OR (scope = 'channel' AND destination_channel_id = ?2))
		ORDER BY created_at, id`,
	advance: `UPDATE automations SET last_run_at = ?2, next_run_at = ?3,
		status = CASE WHEN ?3 IS NULL THEN 'completed' ELSE status END, updated_at = ?4
		WHERE id = ?1 AND status = 'active' AND next_run_at = ?2 AND changes() = 1`,
	update: `UPDATE automations SET ${SET_FIELDS}, next_run_at = ?11, status = ?12, updated_at = ?13
		WHERE id = ?1 AND status <> 'deleted' RETURNING *`,
	setStatus: `UPDATE automations SET status = ?2, next_run_at = COALESCE(?3, next_run_at),
		consecutive_failures = CASE WHEN ?2 = 'active' THEN 0 ELSE consecutive_failures END,
		updated_at = ?4
		WHERE id = ?1 AND status <> 'deleted' RETURNING *`,
	claimScheduled: `INSERT INTO automation_runs (automation_id, fire_time, status, created_at)
		SELECT id, ?2, 'claimed', ?3 FROM automations
		WHERE id = ?1 AND status = 'active' AND next_run_at = ?2
		ON CONFLICT DO NOTHING`,
	claim: `INSERT INTO automation_runs (automation_id, fire_time, status, created_at)
		VALUES (?1, ?2, 'claimed', ?3) ON CONFLICT DO NOTHING`,
	dispatched: `UPDATE automation_runs SET status = 'dispatched', conversation_id = ?3, submission_id = ?4
		WHERE automation_id = ?1 AND fire_time = ?2 AND status = 'claimed'`,
	recordOutcome: `UPDATE automation_runs SET status = ?4, reason = ?5
		WHERE (submission_id = ?1 AND status = 'dispatched')
			OR (automation_id = ?2 AND fire_time = ?3 AND status = 'claimed')`,
	countOutcome: `UPDATE automations SET
		consecutive_failures = CASE WHEN ?4 = 'failed' THEN consecutive_failures + 1 ELSE 0 END,
		status = CASE WHEN ?4 = 'failed' AND status = 'active' AND consecutive_failures + 1 >= ?5
			THEN 'paused' ELSE status END,
		updated_at = ?6
		WHERE changes() = 1 AND id = (
			SELECT automation_id FROM automation_runs
			WHERE submission_id = ?1 OR (automation_id = ?2 AND fire_time = ?3)
		) RETURNING *`,
	runs: 'SELECT * FROM automation_runs WHERE automation_id = ?1 ORDER BY fire_time',
} as const;

function fieldValues(fields: AutomationFields): D1Value[] {
	return [
		fields.kind,
		fields.scope,
		fields.destinationChannelId,
		fields.repo ?? null,
		fields.title,
		fields.prompt,
		fields.schedule.kind === 'recurring' ? fields.schedule.cron : null,
		fields.schedule.kind === 'once' ? fields.schedule.runAt : null,
		fields.timezone,
	];
}

function readAutomation(raw: JsonObject): Automation {
	const row = v.parse(automationRowSchema, raw);

	return {
		id: row.id,
		kind: row.kind,
		title: row.title,
		prompt: row.prompt,
		scope: row.scope,
		destinationChannelId: row.destination_channel_id,
		repo: row.repo ?? undefined,
		// The table's CHECK keeps exactly one of schedule and run_at.
		schedule: row.schedule
			? { kind: 'recurring', cron: row.schedule }
			: { kind: 'once', runAt: row.run_at ?? '' },
		timezone: row.timezone,
		ownerUserId: row.owner_user_id,
		status: row.status,
		nextRunAt: row.next_run_at ?? undefined,
		lastRunAt: row.last_run_at ?? undefined,
		consecutiveFailures: row.consecutive_failures,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function readRun(raw: JsonObject): AutomationRun {
	const row = v.parse(runRowSchema, raw);

	return {
		automationId: row.automation_id,
		fireTime: row.fire_time,
		status: row.status,
		conversationId: row.conversation_id ?? undefined,
		submissionId: row.submission_id ?? undefined,
		reason: row.reason ?? undefined,
		createdAt: row.created_at,
	};
}

export function createD1AutomationStore(db: D1Database): AutomationStore {
	async function firstRow<T>(
		sql: string,
		values: D1Value[],
		read: (raw: JsonObject) => T,
	): Promise<T | undefined> {
		const [row] = await allRows(sql, values, read);

		return row;
	}

	async function allRows<T>(
		sql: string,
		values: D1Value[],
		read: (raw: JsonObject) => T,
	): Promise<T[]> {
		const { results } = await db
			.prepare(sql)
			.bind(...values)
			.all();

		return results.map(read);
	}

	return {
		automations: {
			async create(automation) {
				const created = await firstRow(
					SQL.insert,
					[
						automation.id,
						...fieldValues(automation),
						automation.ownerUserId,
						automation.nextRunAt,
						automation.createdAt,
					],
					readAutomation,
				);

				if (!created) throw new Error(`Automation ${automation.id} was not saved.`);

				return created;
			},
			get: (id) => firstRow(SQL.get, [id], readAutomation),
			due: ({ now, limit }) => allRows(SQL.due, [now, limit], readAutomation),
			visibleTo: ({ userId, channelId }) =>
				allRows(SQL.visible, [userId, channelId], readAutomation),
			update: ({ id, fields, nextRunAt, status, at }) =>
				firstRow(SQL.update, [id, ...fieldValues(fields), nextRunAt, status, at], readAutomation),
			setStatus: ({ id, status, nextRunAt, at }) =>
				firstRow(SQL.setStatus, [id, status, nextRunAt ?? null, at], readAutomation),
		},
		runs: {
			async claimScheduled({ automationId, fireTime, nextRunAt, at }) {
				// D1 batches are transactional. changes() limits advancement to this batch's insert.
				const [claim] = await db.batch([
					db.prepare(SQL.claimScheduled).bind(automationId, fireTime, at),
					db.prepare(SQL.advance).bind(automationId, fireTime, nextRunAt ?? null, at),
				]);

				return claim?.meta.changes === 1;
			},
			async claim({ automationId, fireTime, createdAt }) {
				const { meta } = await db.prepare(SQL.claim).bind(automationId, fireTime, createdAt).run();

				return meta.changes === 1;
			},
			async dispatched({ automationId, fireTime, conversationId, submissionId }) {
				await db
					.prepare(SQL.dispatched)
					.bind(automationId, fireTime, conversationId, submissionId)
					.run();
			},
			async recordOutcome(outcome) {
				const identity: D1Value[] =
					'submissionId' in outcome
						? [outcome.submissionId, null, null]
						: [null, outcome.automationId, outcome.fireTime];

				const { status, reason, pauseAt, at } = outcome;

				// Only a newly recorded outcome changes the counter. Errors roll back both writes.
				const [, counted] = await db.batch([
					db.prepare(SQL.recordOutcome).bind(...identity, status, reason ?? null),
					db.prepare(SQL.countOutcome).bind(...identity, status, pauseAt, at),
				]);

				const [row] = counted?.results ?? [];

				return row ? readAutomation(row) : undefined;
			},
			list: (automationId) => allRows(SQL.runs, [automationId], readRun),
		},
	};
}
