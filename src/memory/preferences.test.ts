import { describe, expect, test } from 'vitest';
import type { Clock } from './d1.ts';
import { createPreferenceStore, PREFERENCE_LIMIT, PREFERENCE_MAX_CHARS } from './preferences.ts';
import { openMigratedSqlite } from './testing/sqlite-d1.ts';

function testClock(): Clock {
	let seq = 0;

	return {
		now: () => new Date(Date.UTC(2026, 8, 26, 0, 0, seq)),
		newId: () => `mem_${++seq}`,
	};
}

describe('PreferenceStore', () => {
	test('saves, lists, and forgets a preference for its subject only', async () => {
		const store = createPreferenceStore(openMigratedSqlite(), testClock());

		const saved = await store.add('U_A', 'Prefers small PRs', 'conv-1');
		const subjectPreferences = await store.list('U_A');
		const otherSubjectPreferences = await store.list('U_B');

		expect(saved).toEqual({ ok: true, id: 'mem_1' });
		expect(subjectPreferences).toEqual([{ id: 'mem_1', content: 'Prefers small PRs' }]);
		expect(otherSubjectPreferences).toEqual([]);

		const forgottenByOtherSubject = await store.forget('U_B', 'mem_1');
		const forgottenBySubject = await store.forget('U_A', 'mem_1');
		const forgottenAgain = await store.forget('U_A', 'mem_1');
		const remainingPreferences = await store.list('U_A');

		expect(forgottenByOtherSubject).toBe(false);
		expect(forgottenBySubject).toBe(true);
		expect(forgottenAgain).toBe(false);
		expect(remainingPreferences).toEqual([]);
	});

	test('rejects empty and oversized content', async () => {
		const store = createPreferenceStore(openMigratedSqlite(), testClock());

		const emptyResult = await store.add('U_A', '   ', 'conv-1');
		const oversizedResult = await store.add('U_A', 'x'.repeat(PREFERENCE_MAX_CHARS + 1), 'conv-1');

		expect(emptyResult).toEqual({ ok: false, reason: 'empty' });
		expect(oversizedResult).toEqual({
			ok: false,
			reason: 'too_long',
		});
	});

	test('enforces the per-person limit', async () => {
		const store = createPreferenceStore(openMigratedSqlite(), testClock());

		for (let i = 0; i < PREFERENCE_LIMIT; i++) {
			const result = await store.add('U_A', `pref ${i}`, 'conv-1');

			expect(result.ok).toBe(true);
		}

		const overLimitResult = await store.add('U_A', 'one too many', 'conv-1');
		const otherSubjectResult = await store.add('U_B', 'someone else', 'conv-1');

		expect(overLimitResult).toEqual({
			ok: false,
			reason: 'limit',
		});
		expect(otherSubjectResult.ok).toBe(true);
	});

	test('counts Unicode code points toward the content limit', async () => {
		const store = createPreferenceStore(openMigratedSqlite(), testClock());

		const atLimit = await store.add('U_A', '😀'.repeat(PREFERENCE_MAX_CHARS), 'conv-1');
		const overLimit = await store.add('U_A', '😀'.repeat(PREFERENCE_MAX_CHARS + 1), 'conv-1');

		expect(atLimit.ok).toBe(true);
		expect(overLimit).toEqual({ ok: false, reason: 'too_long' });
	});

	test('concurrent identical saves reuse one id and preserve original provenance', async () => {
		const db = openMigratedSqlite();
		const store = createPreferenceStore(db, testClock());

		const [first, second] = await Promise.all([
			store.add('U_A', 'Prefers small PRs', 'conv-1'),
			store.add('U_A', '  Prefers small PRs ', 'conv-2'),
		]);

		const preferences = await store.list('U_A');

		const { results } = await db
			.prepare('SELECT source_conversation_id, created_at, updated_at FROM memories')
			.all();

		expect(first.ok).toBe(true);
		expect(second).toEqual(first);
		expect(preferences).toHaveLength(1);
		expect(results).toEqual([
			{
				source_conversation_id: 'conv-1',
				created_at: '2026-09-26T00:00:01.000Z',
				updated_at: '2026-09-26T00:00:01.000Z',
			},
		]);
	});

	test('concurrent distinct saves cannot exceed the per-person limit', async () => {
		const store = createPreferenceStore(openMigratedSqlite(), testClock());

		const results = await Promise.all(
			Array.from({ length: PREFERENCE_LIMIT + 1 }, (_, i) =>
				store.add('U_A', `pref ${i}`, 'conv-1'),
			),
		);

		const preferences = await store.list('U_A');

		expect(results.filter((result) => result.ok)).toHaveLength(PREFERENCE_LIMIT);
		expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: 'limit' }]);
		expect(preferences).toHaveLength(PREFERENCE_LIMIT);
	});

	test('forgotten content can be saved again with a new id', async () => {
		const store = createPreferenceStore(openMigratedSqlite(), testClock());

		const first = await store.add('U_A', 'Prefers small PRs', 'conv-1');

		await store.forget('U_A', 'mem_1');

		const second = await store.add('U_A', 'Prefers small PRs', 'conv-2');
		const otherSubject = await store.add('U_B', 'Prefers small PRs', 'conv-3');
		const preferences = await store.list('U_A');

		expect(second.ok).toBe(true);
		expect(second).not.toEqual(first);
		expect(otherSubject.ok).toBe(true);
		expect(preferences).toHaveLength(1);
	});

	test('saving the same preference twice returns the existing id', async () => {
		const store = createPreferenceStore(openMigratedSqlite(), testClock());

		const first = await store.add('U_A', 'Prefers small PRs', 'conv-1');
		const second = await store.add('U_A', '  Prefers small PRs ', 'conv-2');
		const preferences = await store.list('U_A');

		expect(second).toEqual(first);
		expect(preferences).toHaveLength(1);
	});

	test('re-saving an existing preference at the cap returns the existing id', async () => {
		const store = createPreferenceStore(openMigratedSqlite(), testClock());

		let firstId: string | undefined;

		for (let i = 0; i < PREFERENCE_LIMIT; i++) {
			const result = await store.add('U_A', `pref ${i}`, 'conv-1');

			expect(result.ok).toBe(true);

			if (i === 0 && result.ok) firstId = result.id;
		}

		const result = await store.add('U_A', `  pref 0 `, 'conv-1');
		const preferences = await store.list('U_A');

		expect(result).toEqual({ ok: true, id: firstId });
		expect(preferences).toHaveLength(PREFERENCE_LIMIT);
	});

	test('forgetting erases the content but keeps a tombstone', async () => {
		const db = openMigratedSqlite();
		const store = createPreferenceStore(db, testClock());

		await store.add('U_A', 'secret-ish detail', 'conv-1');
		await store.forget('U_A', 'mem_1');

		const { results } = await db
			.prepare('SELECT content, deleted_at FROM memories WHERE id = ?1')
			.bind('mem_1')
			.all();

		expect(results).toEqual([{ content: null, deleted_at: expect.any(String) }]);
	});
});
