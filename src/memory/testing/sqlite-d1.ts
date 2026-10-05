import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { jsonObjectSchema } from '../../json.ts';
import type { D1Database, D1Statement, D1Value } from '../d1.ts';

const MIGRATIONS = new URL('../../../migrations/', import.meta.url);

// Runs every migration in order against an in-memory SQLite database and
// exposes it through the same D1 contract production code uses. Like D1,
// batch() is one transaction: a failing statement rolls back the whole batch.
export function openMigratedSqlite(): D1Database {
	const db = new DatabaseSync(':memory:');
	db.exec('PRAGMA foreign_keys = ON');

	const files = readdirSync(MIGRATIONS)
		.filter((file) => file.endsWith('.sql'))
		.toSorted();

	for (const file of files) db.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));

	return {
		prepare: (sql) => new SqliteStatement(db, sql),
		async batch(statements) {
			db.exec('BEGIN');

			try {
				const results = statements.map((statement) => {
					if (!(statement instanceof SqliteStatement)) throw new Error('Not a SQLite statement');

					return statement.execute();
				});

				db.exec('COMMIT');

				return results;
			} catch (error) {
				db.exec('ROLLBACK');

				throw error;
			}
		},
	};
}

class SqliteStatement implements D1Statement {
	constructor(
		private readonly db: DatabaseSync,
		private readonly sql: string,
		private readonly values: D1Value[] = [],
	) {}

	bind(...values: D1Value[]): D1Statement {
		return new SqliteStatement(this.db, this.sql, values);
	}

	async all() {
		const rows = this.db
			.prepare(this.sql)
			.all(...this.values)
			.map((row) => ({ ...row }));

		return { results: v.parse(v.array(jsonObjectSchema), rows) };
	}

	execute() {
		const result = this.db.prepare(this.sql).run(...this.values);

		return { meta: { changes: Number(result.changes) } };
	}

	async run() {
		return this.execute();
	}
}
