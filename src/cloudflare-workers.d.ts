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
		setAlarm(scheduledTime: number): Promise<void>;
		deleteAlarm(): Promise<void>;
	}

	export interface DurableObjectState {
		readonly storage: DurableObjectStorage;
	}

	export abstract class DurableObject<Env = undefined> {
		protected readonly ctx: DurableObjectState;
		protected readonly env: Env;
		constructor(ctx: DurableObjectState, env: Env);
		alarm?(): Promise<void>;
	}

	// RPC stub: every public method of the object, awaited across the boundary.
	// The real stub's own `fetch` and `connect` shadow RPC methods of those
	// names, so they are left out.
	export type DurableObjectStub<T> = {
		[K in Exclude<keyof T, 'fetch' | 'connect'>]: T[K] extends (...args: infer A) => infer R
			? (...args: A) => Promise<Awaited<R>>
			: never;
	};

	export interface DurableObjectNamespace<T> {
		getByName(name: string): DurableObjectStub<T>;
	}

	// The Worker's bindings, as declared in wrangler.jsonc.
	export const env: import('./integrations/codex-auth/codex-auth-binding.ts').CodexAuthBinding;
}
