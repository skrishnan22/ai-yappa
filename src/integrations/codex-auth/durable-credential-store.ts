import type {
	AuthOperationOptions,
	Credential,
	CredentialInfo,
	CredentialStore,
} from '@earendil-works/pi-ai';
import { operationSignal, raceWithAbortSignal } from '@earendil-works/pi-ai/utils/abort';
import { type CredentialKey, decryptCredential, encryptCredential } from './credential-cipher.ts';

// Encrypted credential rows, keyed by pi provider id.
export interface CredentialRecords {
	get(providerId: string): ArrayBuffer | undefined;
	set(providerId: string, record: ArrayBuffer): void;
	delete(providerId: string): void;
	providerIds(): string[];
}

// pi's `CredentialStore` over encrypted Durable Object rows. A per-provider
// promise chain serializes `modify` and `delete`; `CodexAuth` has exactly one
// instance, so that chain is the deployment-wide refresh lock.
export class DurableCredentialStore implements CredentialStore {
	readonly #records: CredentialRecords;

	readonly #key: () => Promise<CredentialKey>;

	readonly #chains = new Map<string, Promise<void>>();

	constructor(records: CredentialRecords, key: () => Promise<CredentialKey>) {
		this.#records = records;
		this.#key = key;
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const record = this.#records.get(providerId);

		if (record === undefined) return undefined;

		return decryptCredential(await this.#key(), providerId, record);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const infos: CredentialInfo[] = [];

		for (const providerId of this.#records.providerIds()) {
			const credential = await this.read(providerId, options);

			if (credential) infos.push({ providerId, type: credential.type });
		}

		return infos;
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.#enqueue(
			providerId,
			async () => {
				const current = await this.read(providerId);
				const next = await fn(current);

				if (next === undefined) return current;

				// Persist even if the caller has aborted: a refresh has already spent
				// the old single-use refresh token.
				this.#records.set(providerId, await encryptCredential(await this.#key(), providerId, next));

				return next;
			},
			options,
		);
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.#enqueue(
			providerId,
			async () => {
				this.#records.delete(providerId);
			},
			options,
		);
	}

	#enqueue<T>(
		providerId: string,
		task: () => Promise<T>,
		options: AuthOperationOptions | undefined,
	): Promise<T> {
		const signal = operationSignal(options?.signal);
		const previous = this.#chains.get(providerId) ?? Promise.resolve();

		const queued = (async () => {
			await previous;
			signal.throwIfAborted();

			return task();
		})();

		const tail = queued.then(
			() => undefined,
			() => undefined,
		);

		this.#chains.set(providerId, tail);

		void tail.finally(() => {
			if (this.#chains.get(providerId) === tail) this.#chains.delete(providerId);
		});

		return raceWithAbortSignal(queued, signal);
	}
}
