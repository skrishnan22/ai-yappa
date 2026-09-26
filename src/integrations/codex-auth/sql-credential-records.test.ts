import type { SqlStorage } from 'cloudflare:workers';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { describe, expect, test } from 'vitest';
import { CodexAuthService } from './codex-auth.ts';
import { DurableCredentialStore } from './durable-credential-store.ts';
import { sqlCredentialRecords } from './sql-credential-records.ts';

const credentialKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

// The credentials table holds only text, so values pass straight through.
const sqlValueSchema = v.union([v.string(), v.number(), v.null()]);

// Node's SQLite behind the Durable Object `SqlStorage` shape.
function nodeSqlStorage(db: DatabaseSync): SqlStorage {
	return {
		exec(query, ...bindings) {
			const statement = db.prepare(query);
			const params = bindings.map((value) => v.parse(sqlValueSchema, value));

			if (statement.columns().length === 0) {
				statement.run(...params);

				return { toArray: () => [] };
			}

			const rows = statement
				.all(...params)
				.map((row) =>
					Object.fromEntries(
						Object.entries(row).map(([column, value]) => [column, v.parse(sqlValueSchema, value)]),
					),
				);

			return { toArray: () => rows };
		},
	};
}

describe('sqlCredentialRecords', () => {
	test('a fresh instance over the same SQLite storage reads the seeded credential', async () => {
		const db = new DatabaseSync(':memory:');
		const expires = Date.now() + 60 * 60 * 1000;

		await new CodexAuthService(sqlCredentialRecords(nodeSqlStorage(db)), credentialKey).seed({
			access: 'access-1',
			refresh: 'refresh-1',
			expires,
			accountId: 'account-1',
		});

		const records = sqlCredentialRecords(nodeSqlStorage(db));
		const store = new DurableCredentialStore(records, credentialKey);
		const service = new CodexAuthService(records, credentialKey);

		await expect(service.status()).resolves.toEqual({
			state: 'connected',
			expires,
			accountId: 'account-1',
		});
		await expect(store.read('openai-codex')).resolves.toMatchObject({
			access: 'access-1',
			refresh: 'refresh-1',
		});
		await expect(store.list()).resolves.toEqual([{ providerId: 'openai-codex', type: 'oauth' }]);
	});

	test('stores the credential encrypted and deletes it', async () => {
		const db = new DatabaseSync(':memory:');

		const store = new DurableCredentialStore(
			sqlCredentialRecords(nodeSqlStorage(db)),
			credentialKey,
		);

		await store.modify('openai-codex', async () => ({
			type: 'oauth',
			access: 'access-1',
			refresh: 'refresh-1',
			expires: 0,
		}));

		const row = db.prepare('SELECT type, record FROM credentials').get();

		expect(row?.type).toBe('oauth');
		expect(row?.record).toEqual(expect.any(String));
		expect(row?.record).not.toContain('refresh-1');

		await store.delete('openai-codex');

		await expect(store.read('openai-codex')).resolves.toBeUndefined();
		await expect(store.list()).resolves.toEqual([]);
	});
});
