import type { JsonObject } from '../json.ts';

// The subset of Cloudflare D1 this app uses. Declared here so tests can run the
// real SQL on node:sqlite and so nothing depends on @cloudflare/workers-types.
export type D1Value = string | number | null;

export type D1Statement = {
	bind(...values: D1Value[]): D1Statement;
	all(): Promise<{ results: JsonObject[] }>;
	run(): Promise<{ meta: { changes: number } }>;
};

export type D1Database = {
	prepare(sql: string): D1Statement;
	batch(statements: D1Statement[]): Promise<{ meta: { changes: number } }[]>;
};

export type Clock = { now(): Date; newId(): string };

export const systemClock: Clock = {
	now: () => new Date(),
	newId: () => crypto.randomUUID(),
};
