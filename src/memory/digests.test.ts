import { describe, expect, test } from 'vitest';
import { createDigestStore, ftsQuery, type ConversationDigest } from './digests.ts';
import { openMigratedSqlite } from './testing/sqlite-d1.ts';

function digest(overrides: Partial<ConversationDigest>): ConversationDigest {
	return {
		id: 'conv-1:Ev1',
		conversationId: 'conv-1',
		channelId: 'C_PUBLIC',
		channelVisibility: 'public',
		threadTs: '1.1',
		invokerUserIds: ['U_A'],
		requests: 'why is checkout-test flaky?',
		replies: 'It is a race in cart.ts; opened PR 412.',
		toolsUsed: 'bash×9, open_pull_request×1',
		prUrl: 'https://github.com/o/r/pull/412',
		createdAt: '2026-09-01T00:00:00.000Z',
		...overrides,
	};
}

describe('ftsQuery', () => {
	test('quotes words and drops FTS operators and punctuation', () => {
		expect(ftsQuery('c++ "crash" AND (NEAR -flaky*')).toBe(
			'"c" OR "crash" OR "AND" OR "NEAR" OR "flaky"',
		);
		expect(ftsQuery('  ?? ')).toBeUndefined();
	});
});

describe('DigestStore', () => {
	test('search finds public digests and the current private channel only', async () => {
		const store = createDigestStore(openMigratedSqlite());

		await store.upsert(digest({ id: 'a', conversationId: 'a', channelId: 'C_PUBLIC' }));
		await store.upsert(
			digest({ id: 'b', conversationId: 'b', channelId: 'C_SECRET', channelVisibility: 'private' }),
		);
		await store.upsert(
			digest({ id: 'c', conversationId: 'c', channelId: 'C_OTHER', channelVisibility: 'private' }),
		);

		const fromSecret = await store.search('flaky checkout', 'C_SECRET', 10);

		expect(fromSecret.map((hit) => hit.conversationId).toSorted()).toEqual(['a', 'b']);
		expect(fromSecret[0]?.snippet).toMatch(/flaky|checkout/);

		const fromPublic = await store.search('flaky', 'C_PUBLIC', 10);

		expect(fromPublic.map((hit) => hit.conversationId)).toEqual(['a']);
	});

	test('search tolerates operator-laden input', async () => {
		const store = createDigestStore(openMigratedSqlite());

		await store.upsert(digest({}));

		await expect(store.search('c++ "crash" AND (', 'C_PUBLIC', 5)).resolves.toEqual([]);
		await expect(store.search('checkout AND (', 'C_PUBLIC', 5)).resolves.toHaveLength(1);
		await expect(store.search('???', 'C_PUBLIC', 5)).resolves.toEqual([]);
	});

	test('upsert is idempotent and keeps the index in sync', async () => {
		const store = createDigestStore(openMigratedSqlite());

		await store.upsert(digest({ replies: 'first reply mentions pineapple' }));
		await store.upsert(digest({ replies: 'second reply mentions mango' }));

		expect(await store.search('pineapple', 'C_PUBLIC', 5)).toEqual([]);
		expect(await store.search('mango', 'C_PUBLIC', 5)).toHaveLength(1);
		expect(await store.forConversation('conv-1', 'C_PUBLIC')).toHaveLength(1);
	});

	test('forConversation applies the same channel filter and orders by time', async () => {
		const store = createDigestStore(openMigratedSqlite());

		await store.upsert(
			digest({
				id: 'x:2',
				conversationId: 'x',
				channelId: 'C_SECRET',
				channelVisibility: 'private',
				createdAt: '2026-09-02T00:00:00.000Z',
				invokerUserIds: ['U_B', 'U_C'],
			}),
		);
		await store.upsert(
			digest({
				id: 'x:1',
				conversationId: 'x',
				channelId: 'C_SECRET',
				channelVisibility: 'private',
				createdAt: '2026-09-01T00:00:00.000Z',
			}),
		);

		expect(await store.forConversation('x', 'C_PUBLIC')).toEqual([]);

		const rows = await store.forConversation('x', 'C_SECRET');

		expect(rows.map((row) => row.id)).toEqual(['x:1', 'x:2']);
		expect(rows[1]?.invokerUserIds).toEqual(['U_B', 'U_C']);
	});

	test('deleteOlderThan removes old rows and their index entries', async () => {
		const store = createDigestStore(openMigratedSqlite());

		await store.upsert(digest({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }));
		await store.upsert(
			digest({ id: 'new', conversationId: 'conv-2', createdAt: '2026-09-01T00:00:00.000Z' }),
		);

		expect(await store.deleteOlderThan(new Date('2026-06-01T00:00:00.000Z'))).toBe(1);
		expect((await store.search('flaky', 'C_PUBLIC', 5)).map((hit) => hit.conversationId)).toEqual([
			'conv-2',
		]);
	});
});
