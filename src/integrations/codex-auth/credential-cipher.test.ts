import type { Credential } from '@earendil-works/pi-ai';
import { describe, expect, test } from 'vitest';
import { decryptCredential, encryptCredential, importCredentialKey } from './credential-cipher.ts';

function randomKeySecret(): string {
	return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

const credential: Credential = {
	type: 'oauth',
	access: 'access-secret',
	refresh: 'refresh-secret',
	expires: 1_800_000_000_000,
	accountId: 'account-1',
};

describe('credential cipher', () => {
	test('round-trips a credential', async () => {
		const key = await importCredentialKey(randomKeySecret());
		const record = await encryptCredential(key, 'openai-codex', credential);

		await expect(decryptCredential(key, 'openai-codex', record)).resolves.toEqual(credential);
	});

	test('stores bytes that are not plaintext JSON', async () => {
		const key = await importCredentialKey(randomKeySecret());
		const text = new TextDecoder().decode(await encryptCredential(key, 'openai-codex', credential));

		expect(text).not.toContain('refresh-secret');
		expect(text).not.toContain('access-secret');
		expect(() => JSON.parse(text)).toThrow(SyntaxError);
	});

	test('uses a fresh IV for every write', async () => {
		const key = await importCredentialKey(randomKeySecret());
		const first = new Uint8Array(await encryptCredential(key, 'openai-codex', credential));
		const second = new Uint8Array(await encryptCredential(key, 'openai-codex', credential));

		expect(first.subarray(0, 12)).not.toEqual(second.subarray(0, 12));
	});

	test('rejects a record read with another key or under another provider id', async () => {
		const key = await importCredentialKey(randomKeySecret());
		const record = await encryptCredential(key, 'openai-codex', credential);

		await expect(
			decryptCredential(await importCredentialKey(randomKeySecret()), 'openai-codex', record),
		).rejects.toMatchObject({ name: 'OperationError' });
		await expect(decryptCredential(key, 'anthropic', record)).rejects.toMatchObject({
			name: 'OperationError',
		});
	});

	test('requires a base64-encoded 32-byte key', async () => {
		await expect(importCredentialKey(undefined)).rejects.toThrow(/CODEX_CREDENTIAL_KEY/);
		await expect(importCredentialKey(btoa('too short'))).rejects.toThrow(/CODEX_CREDENTIAL_KEY/);
		await expect(importCredentialKey('%%%not base64%%%')).rejects.toThrow(/CODEX_CREDENTIAL_KEY/);
	});
});
