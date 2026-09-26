import type { SqlStorage } from 'cloudflare:workers';
import * as v from 'valibot';
import type { DeviceCode } from './device-code.ts';

// A device-code login waiting for the admin's approval. `responseUrl` is the
// Slack slash command's `response_url`, used to edit the admin's ephemeral
// message when the login settles.
export type PendingLogin = DeviceCode & { deadline: number; responseUrl: string };

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
	responseUrl: v.string(),
});

// `PendingLoginRecord` over the Durable Object's SQLite storage, so polling
// resumes after the object restarts.
export function sqlPendingLogin(sql: SqlStorage): PendingLoginRecord {
	sql.exec(
		'CREATE TABLE IF NOT EXISTS pending_login (slot INTEGER PRIMARY KEY CHECK (slot = 0), device_auth_id TEXT NOT NULL, user_code TEXT NOT NULL, interval_ms INTEGER NOT NULL, deadline INTEGER NOT NULL, response_url TEXT NOT NULL)',
	);

	return {
		get() {
			const [row] = sql
				.exec(
					'SELECT device_auth_id AS deviceAuthId, user_code AS userCode, interval_ms AS intervalMs, deadline, response_url AS responseUrl FROM pending_login WHERE slot = 0',
				)
				.toArray();

			return row === undefined ? undefined : v.parse(pendingLoginRowSchema, row);
		},
		set(login) {
			sql.exec(
				'INSERT INTO pending_login (slot, device_auth_id, user_code, interval_ms, deadline, response_url) VALUES (0, ?, ?, ?, ?, ?) ON CONFLICT (slot) DO UPDATE SET device_auth_id = excluded.device_auth_id, user_code = excluded.user_code, interval_ms = excluded.interval_ms, deadline = excluded.deadline, response_url = excluded.response_url',
				login.deviceAuthId,
				login.userCode,
				login.intervalMs,
				login.deadline,
				login.responseUrl,
			);
		},
		clear() {
			sql.exec('DELETE FROM pending_login');
		},
	};
}
