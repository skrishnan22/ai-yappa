import type { SqlStorage } from 'cloudflare:workers';
import * as v from 'valibot';
import type { CredentialRecords } from './durable-credential-store.ts';

const credentialInfosSchema = v.array(
	v.object({ providerId: v.string(), type: v.picklist(['oauth', 'api_key']) }),
);

// `CredentialRecords` over a Durable Object's SQLite storage. Kept apart from
// `CodexAuth` so tests can run it against Node's SQLite.
export function sqlCredentialRecords(sql: SqlStorage): CredentialRecords {
	sql.exec(
		'CREATE TABLE IF NOT EXISTS credentials (provider_id TEXT PRIMARY KEY, type TEXT NOT NULL, record TEXT NOT NULL)',
	);

	return {
		get(providerId) {
			const [row] = sql
				.exec('SELECT record FROM credentials WHERE provider_id = ?', providerId)
				.toArray();

			return row === undefined ? undefined : v.parse(v.string(), row.record);
		},
		set(providerId, type, record) {
			sql.exec(
				'INSERT INTO credentials (provider_id, type, record) VALUES (?, ?, ?) ON CONFLICT (provider_id) DO UPDATE SET type = excluded.type, record = excluded.record',
				providerId,
				type,
				record,
			);
		},
		delete(providerId) {
			sql.exec('DELETE FROM credentials WHERE provider_id = ?', providerId);
		},
		list() {
			return v.parse(
				credentialInfosSchema,
				sql.exec('SELECT provider_id AS providerId, type FROM credentials').toArray(),
			);
		},
	};
}
