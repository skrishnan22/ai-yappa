import type { SqlStorage } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';

// Test support: Node's SQLite behind the Durable Object `SqlStorage` type.

// `CodexAuth` tables hold only text and integers, so values pass straight through.
const sqlValueSchema = v.union([v.string(), v.number(), v.null()]);

export function nodeSqlStorage(db: DatabaseSync): SqlStorage {
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
