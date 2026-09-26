import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import {
	type CredentialKey,
	decryptCredential,
	encryptCredential,
	importCredentialKey,
} from './credential-cipher.ts';

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
//
// Abort signals are ignored. pi's `getAuth` already stops waiting when its
// caller aborts, and a write must still land once a refresh has spent the old
// single-use refresh token.
export class DurableCredentialStore implements CredentialStore {
	readonly #records: CredentialRecords;

	readonly #secret: string | undefined;

	#key: Promise<CredentialKey> | undefined;

	readonly #chains = new Map<string, Promise<void>>();

	constructor(records: CredentialRecords, secret: string | undefined) {
		this.#records = records;
		this.#secret = secret;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		const record = this.#records.get(providerId);

		if (record === undefined) return undefined;

		return decryptCredential(await this.#cryptoKey(), providerId, record);
	}

	async list(): Promise<readonly CredentialInfo[]> {
		const infos: CredentialInfo[] = [];

		for (const providerId of this.#records.providerIds()) {
			const credential = await this.read(providerId);

			if (credential) infos.push({ providerId, type: credential.type });
		}

		return infos;
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.#enqueue(providerId, async () => {
			const current = await this.read(providerId);
			const next = await fn(current);

			if (next === undefined) return current;

			this.#records.set(
				providerId,
				await encryptCredential(await this.#cryptoKey(), providerId, next),
			);

			return next;
		});
	}

	delete(providerId: string): Promise<void> {
		return this.#enqueue(providerId, async () => {
			this.#records.delete(providerId);
		});
	}

	#cryptoKey(): Promise<CredentialKey> {
		this.#key ??= importCredentialKey(this.#secret);

		return this.#key;
	}

	#enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
		const queued = (this.#chains.get(providerId) ?? Promise.resolve()).then(task);

		this.#chains.set(
			providerId,
			queued.then(
				() => undefined,
				() => undefined,
			),
		);

		return queued;
	}
}
