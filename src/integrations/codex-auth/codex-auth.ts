import { createModels, type Models } from '@earendil-works/pi-ai';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import * as v from 'valibot';
import { type CredentialKey, importCredentialKey } from './credential-cipher.ts';
import { type CredentialRecords, DurableCredentialStore } from './durable-credential-store.ts';

// pi otherwise loads OAuth flows through a variable-path dynamic import that
// the Worker bundle cannot follow, so refresh would fail at runtime.
registerBunOAuthFlows();

const CODEX_PROVIDER_ID = 'openai-codex';

const nonEmpty = v.pipe(v.string(), v.minLength(1));

const seedSchema = v.object({
	access: nonEmpty,
	refresh: nonEmpty,
	expires: v.number(),
	accountId: nonEmpty,
});

const storedCodexCredentialSchema = v.looseObject({
	type: v.literal('oauth'),
	expires: v.number(),
	accountId: v.string(),
});

export type CodexCredentialSeed = v.InferInput<typeof seedSchema>;

export type CodexAuthStatus =
	| { state: 'connected'; expires: number; accountId: string }
	| { state: 'disconnected' };

// Everything `CodexAuth` does, minus the Durable Object shell, so it runs
// under Node in tests. Only access tokens leave this class.
export class CodexAuthService {
	readonly #store: DurableCredentialStore;

	readonly #models: Models;

	constructor(records: CredentialRecords, credentialKey: string | undefined) {
		let key: Promise<CredentialKey> | undefined;

		this.#store = new DurableCredentialStore(records, () => {
			key ??= importCredentialKey(credentialKey);

			return key;
		});

		const models = createModels({ credentials: this.#store });

		models.setProvider(openaiCodexProvider());
		this.#models = models;
	}

	async accessToken(): Promise<string | undefined> {
		const result = await this.#models.getAuth(CODEX_PROVIDER_ID);

		return result?.auth.apiKey;
	}

	async status(): Promise<CodexAuthStatus> {
		const credential = await this.#store.read(CODEX_PROVIDER_ID);

		if (credential === undefined) return { state: 'disconnected' };
		const { expires, accountId } = v.parse(storedCodexCredentialSchema, credential);

		return { state: 'connected', expires, accountId };
	}

	async seed(credential: CodexCredentialSeed): Promise<CodexAuthStatus> {
		const { access, refresh, expires, accountId } = v.parse(seedSchema, credential);

		await this.#store.modify(CODEX_PROVIDER_ID, async () => ({
			type: 'oauth',
			access,
			refresh,
			expires,
			accountId,
		}));

		return this.status();
	}
}
