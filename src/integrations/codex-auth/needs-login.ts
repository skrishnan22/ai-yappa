import type { SqlStorage } from 'cloudflare:workers';
import * as v from 'valibot';
import type { JsonValue } from '../../json.ts';

// OpenAI's refresh errors that no retry can fix (ADR 0020). The Codex CLI
// treats the same three codes as permanent.
const needsLoginReasonSchema = v.picklist([
	'refresh_token_expired',
	'refresh_token_reused',
	'refresh_token_invalidated',
]);

export type NeedsLoginReason = v.InferOutput<typeof needsLoginReasonSchema>;

// OpenAI has sent the code both as `error.code` and as a bare `error` string;
// the Codex CLI also accepts a top-level `code`.
const refreshErrorReasonSchema = v.union([
	v.pipe(
		v.looseObject({ error: v.looseObject({ code: needsLoginReasonSchema }) }),
		v.transform((body) => body.error.code),
	),
	v.pipe(
		v.looseObject({ error: needsLoginReasonSchema }),
		v.transform((body) => body.error),
	),
	v.pipe(
		v.looseObject({ code: needsLoginReasonSchema }),
		v.transform((body) => body.code),
	),
]);

// pi 0.86 throws a plain Error from `refreshAccessToken` in
// `auth/oauth/openai-codex.js`, with the response body in the message:
// `OpenAI Codex token refresh failed (401): <body>`. A network failure reads
// `OpenAI Codex token refresh error: ...` and does not match.
const REFRESH_FAILURE_PATTERN = /^OpenAI Codex token refresh failed \(\d{3}\): (.*)$/s;

/** The permanent reason in a failed pi refresh, or undefined for a transient failure. */
export function permanentRefreshFailure(error: Error): NeedsLoginReason | undefined {
	const body = REFRESH_FAILURE_PATTERN.exec(error.message)?.[1];

	if (body === undefined) return undefined;
	let json: JsonValue;

	try {
		json = JSON.parse(body);
	} catch {
		return undefined;
	}

	const parsed = v.safeParse(refreshErrorReasonSchema, json);

	return parsed.success ? parsed.output : undefined;
}

// OpenAI rejected the stored refresh token for good. The credential stays
// stored so `disconnect` can still revoke it, but nothing refreshes it.
export type NeedsLogin = { reason: NeedsLoginReason; since: number };

export interface NeedsLoginRecord {
	get(): NeedsLogin | undefined;
	set(needsLogin: NeedsLogin): void;
	clear(): void;
}

const needsLoginRowSchema = v.object({ reason: needsLoginReasonSchema, since: v.number() });

// `NeedsLoginRecord` over the Durable Object's SQLite storage, so a restart
// does not retry a dead refresh token.
export function sqlNeedsLogin(sql: SqlStorage): NeedsLoginRecord {
	sql.exec(
		'CREATE TABLE IF NOT EXISTS needs_login (slot INTEGER PRIMARY KEY CHECK (slot = 0), reason TEXT NOT NULL, since INTEGER NOT NULL)',
	);

	return {
		get() {
			const [row] = sql.exec('SELECT reason, since FROM needs_login WHERE slot = 0').toArray();

			return row === undefined ? undefined : v.parse(needsLoginRowSchema, row);
		},
		set({ reason, since }) {
			sql.exec(
				'INSERT INTO needs_login (slot, reason, since) VALUES (0, ?, ?) ON CONFLICT (slot) DO UPDATE SET reason = excluded.reason, since = excluded.since',
				reason,
				since,
			);
		},
		clear() {
			sql.exec('DELETE FROM needs_login');
		},
	};
}
