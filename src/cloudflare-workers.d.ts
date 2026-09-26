// The subset of `cloudflare:workers` this Worker uses. The full
// @cloudflare/workers-types globals conflict with @types/node in this project.
declare module 'cloudflare:workers' {
	export type SqlStorageValue = ArrayBuffer | string | number | null;

	export interface SqlStorageCursor {
		toArray(): { [column: string]: SqlStorageValue }[];
	}

	export interface SqlStorage {
		exec(query: string, ...bindings: SqlStorageValue[]): SqlStorageCursor;
	}

	export interface DurableObjectStorage {
		readonly sql: SqlStorage;
	}

	export interface DurableObjectState {
		readonly storage: DurableObjectStorage;
	}

	export abstract class DurableObject<Env = undefined> {
		protected readonly ctx: DurableObjectState;
		protected readonly env: Env;
		constructor(ctx: DurableObjectState, env: Env);
	}
}
