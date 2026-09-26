import { ModelsError } from '@earendil-works/pi-ai';
import { ValiError } from 'valibot';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CodexAuthService } from './codex-auth.ts';
import { importCredentialKey } from './credential-cipher.ts';
import { type CredentialRecords, DurableCredentialStore } from './durable-credential-store.ts';

const TOKEN_URL = 'https://auth.openai.com/oauth/token';

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const credentialKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

class MemoryRecords implements CredentialRecords {
	readonly rows = new Map<string, ArrayBuffer>();

	get(providerId: string): ArrayBuffer | undefined {
		return this.rows.get(providerId);
	}

	set(providerId: string, record: ArrayBuffer): void {
		this.rows.set(providerId, record);
	}

	delete(providerId: string): void {
		this.rows.delete(providerId);
	}

	providerIds(): string[] {
		return [...this.rows.keys()];
	}
}

function codexAccessToken(label: string): string {
	const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' }, label };

	return `header.${btoa(JSON.stringify(claims))}.signature`;
}

function storeOver(records: CredentialRecords): DurableCredentialStore {
	return new DurableCredentialStore(records, () => importCredentialKey(credentialKey));
}

type TokenRequest = { url: string; body: RequestInit['body'] };

// Replaces the network only; pi's real OpenAI Codex refresh code runs.
function stubTokenEndpoint(respond: () => Response): TokenRequest[] {
	const requests: TokenRequest[] = [];

	vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
		requests.push({ url: String(input), body: init?.body });
		await new Promise((resolve) => setTimeout(resolve, 20));

		return respond();
	});

	return requests;
}

function rotatedTokenResponse(access: string): Response {
	return Response.json({ access_token: access, refresh_token: 'refresh-2', expires_in: 3600 });
}

async function seededService(
	records: CredentialRecords,
	expiresInMs: number,
): Promise<CodexAuthService> {
	const service = new CodexAuthService(records, credentialKey);

	await service.seed({
		access: codexAccessToken('old'),
		refresh: 'refresh-1',
		expires: Date.now() + expiresInMs,
		accountId: 'account-1',
	});

	return service;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('CodexAuthService', () => {
	test('reports disconnected and returns no token before a credential is seeded', async () => {
		const service = new CodexAuthService(new MemoryRecords(), credentialKey);

		await expect(service.status()).resolves.toEqual({ state: 'disconnected' });
		await expect(service.accessToken()).resolves.toBeUndefined();
	});

	test('status reports connection metadata without tokens', async () => {
		const expires = Date.now() + 60 * 60 * 1000;
		const service = new CodexAuthService(new MemoryRecords(), credentialKey);

		const status = await service.seed({
			access: codexAccessToken('old'),
			refresh: 'refresh-1',
			expires,
			accountId: 'account-1',
		});

		expect(status).toEqual({ state: 'connected', expires, accountId: 'account-1' });
		expect(await service.status()).toEqual(status);
		expect(JSON.stringify(status)).not.toContain('refresh-1');
		expect(JSON.stringify(status)).not.toContain(codexAccessToken('old'));
	});

	test('returns the stored access token without refreshing a fresh credential', async () => {
		const requests = stubTokenEndpoint(() => rotatedTokenResponse(codexAccessToken('new')));
		const service = await seededService(new MemoryRecords(), 60 * 60 * 1000);

		await expect(service.accessToken()).resolves.toBe(codexAccessToken('old'));
		expect(requests).toHaveLength(0);
	});

	test('concurrent calls on a nearly expired credential send exactly one refresh', async () => {
		const requests = stubTokenEndpoint(() => rotatedTokenResponse(codexAccessToken('new')));
		const service = await seededService(new MemoryRecords(), 60 * 1000);

		const tokens = await Promise.all([
			service.accessToken(),
			service.accessToken(),
			service.accessToken(),
		]);

		expect(tokens).toEqual([
			codexAccessToken('new'),
			codexAccessToken('new'),
			codexAccessToken('new'),
		]);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(TOKEN_URL);
		expect(requests[0]?.body).toEqual(
			new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: 'refresh-1',
				client_id: CODEX_CLIENT_ID,
			}),
		);
	});

	test('a refresh persists both the new access token and the rotated refresh token', async () => {
		const records = new MemoryRecords();
		const requests = stubTokenEndpoint(() => rotatedTokenResponse(codexAccessToken('new')));
		const service = await seededService(records, 60 * 1000);

		await service.accessToken();

		await expect(storeOver(records).read('openai-codex')).resolves.toMatchObject({
			type: 'oauth',
			access: codexAccessToken('new'),
			refresh: 'refresh-2',
			accountId: 'account-1',
		});

		const restarted = new CodexAuthService(records, credentialKey);

		await expect(restarted.accessToken()).resolves.toBe(codexAccessToken('new'));
		expect(requests).toHaveLength(1);
	});

	test('a failed refresh keeps the stored credential and throws an oauth ModelsError', async () => {
		const records = new MemoryRecords();

		stubTokenEndpoint(() =>
			Response.json({ error: { code: 'refresh_token_reused' } }, { status: 401 }),
		);
		const service = await seededService(records, 60 * 1000);
		const failure = await service.accessToken().catch((error: Error) => error);

		expect(failure).toBeInstanceOf(ModelsError);
		expect(failure).toMatchObject({ code: 'oauth' });

		await expect(storeOver(records).read('openai-codex')).resolves.toMatchObject({
			access: codexAccessToken('old'),
			refresh: 'refresh-1',
		});
	});

	test('fails closed without a credential key', async () => {
		const service = new CodexAuthService(new MemoryRecords(), undefined);

		await expect(
			service.seed({
				access: codexAccessToken('old'),
				refresh: 'refresh-1',
				expires: Date.now() + 60 * 60 * 1000,
				accountId: 'account-1',
			}),
		).rejects.toThrow(/CODEX_CREDENTIAL_KEY/);
	});

	test('seed rejects a credential without an account id', async () => {
		const service = new CodexAuthService(new MemoryRecords(), credentialKey);

		await expect(
			service.seed({ access: 'a', refresh: 'r', expires: Date.now(), accountId: '' }),
		).rejects.toThrow(ValiError);
		await expect(service.status()).resolves.toEqual({ state: 'disconnected' });
	});
});

describe('DurableCredentialStore', () => {
	test('lists credential types and deletes under the provider lock', async () => {
		const store = storeOver(new MemoryRecords());

		await store.modify('openai-codex', async () => ({
			type: 'oauth',
			access: 'a',
			refresh: 'r',
			expires: 0,
		}));

		await expect(store.list()).resolves.toEqual([{ providerId: 'openai-codex', type: 'oauth' }]);

		await store.delete('openai-codex');

		await expect(store.read('openai-codex')).resolves.toBeUndefined();
	});

	test('persists a rotated credential even when the caller aborts mid-refresh', async () => {
		const store = storeOver(new MemoryRecords());
		const controller = new AbortController();

		const modified = store.modify(
			'openai-codex',
			async () => {
				controller.abort();

				return { type: 'oauth', access: 'a2', refresh: 'r2', expires: 0 };
			},
			{ signal: controller.signal },
		);

		await expect(modified).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(async () => {
			await expect(store.read('openai-codex')).resolves.toMatchObject({ refresh: 'r2' });
		});
	});
});
