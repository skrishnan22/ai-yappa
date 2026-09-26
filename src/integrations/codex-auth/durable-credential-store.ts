import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import { credentialKey, decryptCredential, encryptCredential } from './credential-cipher.ts';

// Encrypted credential rows, keyed by pi provider id. The credential type is
// stored in plaintext beside the encrypted record so `list` needs no decrypt.
export interface CredentialRecords {
	get(providerId: string): string | undefined;
	set(providerId: string, type: Credential['type'], record: string): void;
	delete(providerId: string): void;
	list(): CredentialInfo[];
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

	readonly #chains = new Map<string, Promise<void>>();

	constructor(records: CredentialRecords, secret: string | undefined) {
		this.#records = records;
		this.#secret = secret;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		const record = this.#records.get(providerId);

		if (record === undefined) return undefined;

		return decryptCredential(credentialKey(this.#secret), providerId, record);
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return this.#records.list();
	}

	// pi's only write path. `update` receives the stored credential as it is
	// now, read inside the lock, and returns its replacement or undefined to
	// keep it. On refresh, pi's `update` returns undefined when another request
	// already refreshed while this one waited for the lock.
	modify(
		providerId: string,
		update: (stored: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.#withLock(providerId, async () => {
			const stored = await this.read(providerId);
			const replacement = await update(stored);

			if (replacement === undefined) return stored;

			const record = await encryptCredential(credentialKey(this.#secret), providerId, replacement);

			this.#records.set(providerId, replacement.type, record);

			return replacement;
		});
	}

	delete(providerId: string): Promise<void> {
		return this.#withLock(providerId, async () => {
			this.#records.delete(providerId);
		});
	}

	#withLock<T>(providerId: string, task: () => Promise<T>): Promise<T> {
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
