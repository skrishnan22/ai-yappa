import { readdirSync, readFileSync } from 'node:fs';
import { onTestFinished } from 'vitest';
import { getPlatformProxy, unstable_splitSqlQuery } from 'wrangler';
import type { D1Database } from '../memory/d1.ts';

const MIGRATIONS = new URL('../../migrations/', import.meta.url);

// A fresh APP_DB for one test: the real D1 binding from wrangler.jsonc, run
// in memory by Miniflare, with every migration applied. Disposed after the test.
export async function openTestDatabase(): Promise<D1Database> {
	const proxy = await getPlatformProxy<{ APP_DB: D1Database }>({ persist: false });
	onTestFinished(() => proxy.dispose());

	const db = proxy.env.APP_DB;

	const files = readdirSync(MIGRATIONS)
		.filter((file) => file.endsWith('.sql'))
		.toSorted();

	for (const file of files) {
		const sql = readFileSync(new URL(file, MIGRATIONS), 'utf8');
		await db.batch(unstable_splitSqlQuery(sql).map((statement) => db.prepare(statement)));
	}

	return db;
}
