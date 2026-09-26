import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { jsonObjectSchema } from '../../json.ts';
import type { D1Database, D1Statement, D1Value } from '../d1.ts';

const MIGRATIONS = new URL('../../../migrations/', import.meta.url);

// Runs every migration in order against an in-memory SQLite database and
// exposes it through the same D1 contract production code uses.
export function openMigratedSqlite(): D1Database {
	const db = new DatabaseSync(':memory:');

	const files = readdirSync(MIGRATIONS)
		.filter((file) => file.endsWith('.sql'))
		.toSorted();

	for (const file of files) db.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));

	return { prepare: (sql) => statement(db, sql, []) };
}

function statement(db: DatabaseSync, sql: string, values: D1Value[]): D1Statement {
	return {
		bind: (...next) => statement(db, sql, next),
		async all() {
			const rows = db
				.prepare(sql)
				.all(...values)
				.map((row) => ({ ...row }));

			return { results: v.parse(v.array(jsonObjectSchema), rows) };
		},
		async run() {
			const result = db.prepare(sql).run(...values);

			return { meta: { changes: Number(result.changes) } };
		},
	};
}
