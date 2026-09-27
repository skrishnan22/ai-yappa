import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import { type CodexAuthStorage, CodexAuthService } from './codex-auth.ts';
import { DurableCredentialStore } from './durable-credential-store.ts';
import { nodeSqlStorage } from './node-sql-storage.ts';
import { sqlNeedsLogin } from './needs-login.ts';
import { sqlPendingLogin } from './pending-login.ts';
import { sqlCredentialRecords } from './sql-credential-records.ts';

const credentialKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

function sqlStorage(db: DatabaseSync): CodexAuthStorage {
	const sql = nodeSqlStorage(db);

	return {
		credentials: sqlCredentialRecords(sql),
		pendingLogin: sqlPendingLogin(sql),
		needsLogin: sqlNeedsLogin(sql),
		alarm: { set: async () => {}, clear: async () => {} },
	};
}

describe('sqlCredentialRecords', () => {
	test('a fresh instance over the same SQLite storage reads the seeded credential', async () => {
		const db = new DatabaseSync(':memory:');
		const expires = Date.now() + 60 * 60 * 1000;

		await new CodexAuthService(sqlStorage(db), credentialKey).seed({
			access: 'access-1',
			refresh: 'refresh-1',
			expires,
			accountId: 'account-1',
		});

		const storage = sqlStorage(db);
		const store = new DurableCredentialStore(storage.credentials, credentialKey);
		const service = new CodexAuthService(storage, credentialKey);

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

describe('sqlPendingLogin', () => {
	const login = {
		deviceAuthId: 'device-1',
		userCode: 'ABCD-EFGH',
		intervalMs: 5000,
		deadline: 1_790_000_000_000,
		pollAt: 1_789_999_995_000,
		responseUrl: 'https://hooks.slack.com/commands/T1/1/abc',
	};

	test('a fresh instance over the same SQLite storage reads the pending login', () => {
		const db = new DatabaseSync(':memory:');

		sqlPendingLogin(nodeSqlStorage(db)).set(login);

		expect(sqlPendingLogin(nodeSqlStorage(db)).get()).toEqual(login);
	});

	test('keeps one pending login and clears it', () => {
		const db = new DatabaseSync(':memory:');
		const record = sqlPendingLogin(nodeSqlStorage(db));

		record.set(login);
		record.set({ ...login, deviceAuthId: 'device-2', intervalMs: 10_000 });

		expect(record.get()).toEqual({ ...login, deviceAuthId: 'device-2', intervalMs: 10_000 });
		expect(db.prepare('SELECT COUNT(*) AS count FROM pending_login').get()?.count).toBe(1);

		record.clear();

		expect(record.get()).toBeUndefined();
	});

	test('adds poll_at to a table created before it existed, so the pending row polls at once', () => {
		const db = new DatabaseSync(':memory:');

		db.exec(
			'CREATE TABLE pending_login (slot INTEGER PRIMARY KEY CHECK (slot = 0), device_auth_id TEXT NOT NULL, user_code TEXT NOT NULL, interval_ms INTEGER NOT NULL, deadline INTEGER NOT NULL, response_url TEXT NOT NULL)',
		);
		db.prepare(
			'INSERT INTO pending_login (slot, device_auth_id, user_code, interval_ms, deadline, response_url) VALUES (0, ?, ?, ?, ?, ?)',
		).run(login.deviceAuthId, login.userCode, login.intervalMs, login.deadline, login.responseUrl);

		expect(sqlPendingLogin(nodeSqlStorage(db)).get()).toEqual({ ...login, pollAt: 0 });
	});
});

describe('sqlNeedsLogin', () => {
	test('a fresh instance over the same SQLite storage reads needs_login until cleared', () => {
		const db = new DatabaseSync(':memory:');
		const needsLogin = { reason: 'refresh_token_expired', since: 1_790_000_000_000 } as const;

		sqlNeedsLogin(nodeSqlStorage(db)).set(needsLogin);

		const record = sqlNeedsLogin(nodeSqlStorage(db));

		expect(record.get()).toEqual(needsLogin);

		record.clear();

		expect(sqlNeedsLogin(nodeSqlStorage(db)).get()).toBeUndefined();
	});
});
