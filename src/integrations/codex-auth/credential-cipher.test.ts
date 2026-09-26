import type { Credential } from '@earendil-works/pi-ai';
import { describe, expect, test } from 'vitest';
import { credentialKey, decryptCredential, encryptCredential } from './credential-cipher.ts';

function randomKey(): Uint8Array {
	return credentialKey(btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))));
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
		const key = randomKey();
		const record = await encryptCredential(key, 'openai-codex', credential);

		await expect(decryptCredential(key, 'openai-codex', record)).resolves.toEqual(credential);
	});

	test('stores a record without the plaintext tokens', async () => {
		const record = await encryptCredential(randomKey(), 'openai-codex', credential);

		expect(record).not.toContain('refresh-secret');
		expect(record).not.toContain('access-secret');
	});

	test('encrypts the same credential differently on every write', async () => {
		const key = randomKey();
		const first = await encryptCredential(key, 'openai-codex', credential);
		const second = await encryptCredential(key, 'openai-codex', credential);

		expect(first).not.toEqual(second);
	});

	test('rejects a record read with another key or under another provider id', async () => {
		const key = randomKey();
		const record = await encryptCredential(key, 'openai-codex', credential);

		await expect(decryptCredential(randomKey(), 'openai-codex', record)).rejects.toMatchObject({
			code: 'ERR_JWE_DECRYPTION_FAILED',
		});
		await expect(decryptCredential(key, 'anthropic', record)).rejects.toThrow(
			/not for provider anthropic/,
		);
	});

	test('requires a base64-encoded 32-byte key', () => {
		expect(() => credentialKey(undefined)).toThrow(/CODEX_CREDENTIAL_KEY/);
		expect(() => credentialKey(btoa('too short'))).toThrow(/CODEX_CREDENTIAL_KEY/);
		expect(() => credentialKey('%%%not base64%%%')).toThrow(/CODEX_CREDENTIAL_KEY/);
	});
});
