import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { jsonObjectSchema } from '../../json.ts';
import type { D1Database, D1Statement, D1Value } from '../d1.ts';

const MIGRATIONS = new URL('../../../migrations/', import.meta.url);

// Runs the same SQL as D1. Batch execution stays synchronous inside one
// transaction so concurrent tests cannot interleave operations across awaits.
export function openMigratedSqlite(): D1Database & { close(): void } {
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
					if (!(statement instanceof SqliteStatement) || statement.db !== db) {
						throw new Error('Batch statement belongs to a different database');
					}

					return statement.execute();
				});

				db.exec('COMMIT');

				return results;
			} catch (error) {
				db.exec('ROLLBACK');

				throw error;
			}
		},
		close: () => db.close(),
	};
}

class SqliteStatement implements D1Statement {
	constructor(
		readonly db: DatabaseSync,
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
