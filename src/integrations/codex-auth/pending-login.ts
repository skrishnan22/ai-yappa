import type { SqlStorage } from 'cloudflare:workers';
import * as v from 'valibot';
import type { DeviceCode } from './device-code.ts';

// A device-code login waiting for the admin's approval. `responseUrl` is the
// Slack slash command's `response_url`, used to edit the admin's ephemeral
// message when the login settles. `pollAt` is when the next poll is due; the
// object's one alarm also serves proactive refresh.
export type PendingLogin = DeviceCode & { deadline: number; pollAt: number; responseUrl: string };

// At most one pending login per deployment. Plaintext: the row lives at most
// 15 minutes, and only this Durable Object can read its storage.
export interface PendingLoginRecord {
	get(): PendingLogin | undefined;
	set(login: PendingLogin): void;
	clear(): void;
}

const pendingLoginRowSchema = v.object({
	deviceAuthId: v.string(),
	userCode: v.string(),
	intervalMs: v.number(),
	deadline: v.number(),
	pollAt: v.number(),
	responseUrl: v.string(),
});

const CREATE_PENDING_LOGIN_TABLE = `
	CREATE TABLE IF NOT EXISTS pending_login (
		slot INTEGER PRIMARY KEY CHECK (slot = 0),
		device_auth_id TEXT NOT NULL,
		user_code TEXT NOT NULL,
		interval_ms INTEGER NOT NULL,
		deadline INTEGER NOT NULL,
		poll_at INTEGER NOT NULL DEFAULT 0,
		response_url TEXT NOT NULL
	)
`;

const PENDING_LOGIN_TABLE_INFO = 'PRAGMA table_info(pending_login)';

const ADD_POLL_AT_COLUMN =
	'ALTER TABLE pending_login ADD COLUMN poll_at INTEGER NOT NULL DEFAULT 0';

const SELECT_PENDING_LOGIN = `
	SELECT
		device_auth_id AS deviceAuthId,
		user_code AS userCode,
		interval_ms AS intervalMs,
		deadline,
		poll_at AS pollAt,
		response_url AS responseUrl
	FROM pending_login
	WHERE slot = 0
`;

const UPSERT_PENDING_LOGIN = `
	INSERT INTO pending_login (slot, device_auth_id, user_code, interval_ms, deadline, poll_at, response_url)
	VALUES (0, ?, ?, ?, ?, ?, ?)
	ON CONFLICT (slot) DO UPDATE SET
		device_auth_id = excluded.device_auth_id,
		user_code = excluded.user_code,
		interval_ms = excluded.interval_ms,
		deadline = excluded.deadline,
		poll_at = excluded.poll_at,
		response_url = excluded.response_url
`;

const DELETE_PENDING_LOGIN = 'DELETE FROM pending_login';

// `PendingLoginRecord` over the Durable Object's SQLite storage, so polling
// resumes after the object restarts.
export function sqlPendingLogin(sql: SqlStorage): PendingLoginRecord {
	sql.exec(CREATE_PENDING_LOGIN_TABLE);

	const columns = sql.exec(PENDING_LOGIN_TABLE_INFO).toArray();

	// Tables created before `poll_at` existed: a pending row polls at once.
	if (!columns.some((column) => column.name === 'poll_at')) {
		sql.exec(ADD_POLL_AT_COLUMN);
	}

	return {
		get() {
			const [row] = sql.exec(SELECT_PENDING_LOGIN).toArray();

			return row === undefined ? undefined : v.parse(pendingLoginRowSchema, row);
		},
		set(login) {
			sql.exec(
				UPSERT_PENDING_LOGIN,
				login.deviceAuthId,
				login.userCode,
				login.intervalMs,
				login.deadline,
				login.pollAt,
				login.responseUrl,
			);
		},
		clear() {
			sql.exec(DELETE_PENDING_LOGIN);
		},
	};
}
