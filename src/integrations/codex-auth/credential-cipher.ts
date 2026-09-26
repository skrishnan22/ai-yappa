import type { Credential } from '@earendil-works/pi-ai';
import * as v from 'valibot';
import type { JsonValue } from '../../json.ts';

export type CredentialKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const KEY_BYTES = 32;

const IV_BYTES = 12;

const credentialSchema = v.variant('type', [
	v.looseObject({
		type: v.literal('oauth'),
		access: v.string(),
		refresh: v.string(),
		expires: v.number(),
	}),
	v.object({
		type: v.literal('api_key'),
		key: v.optional(v.string()),
		env: v.optional(v.record(v.string(), v.string())),
	}),
]);

export async function importCredentialKey(secret: string | undefined): Promise<CredentialKey> {
	const bytes = secret ? base64Bytes(secret.trim()) : undefined;

	if (bytes?.byteLength !== KEY_BYTES) {
		throw new Error('CODEX_CREDENTIAL_KEY must be 32 random bytes, base64-encoded');
	}

	return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> | undefined {
	try {
		return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
	} catch {
		return undefined;
	}
}

// The provider id is authenticated data, so a record cannot be replayed under
// another provider's row.
export async function encryptCredential(
	key: CredentialKey,
	providerId: string,
	credential: Credential,
): Promise<ArrayBuffer> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(providerId) },
		key,
		new TextEncoder().encode(JSON.stringify(credential)),
	);

	const record = new Uint8Array(IV_BYTES + ciphertext.byteLength);

	record.set(iv);
	record.set(new Uint8Array(ciphertext), IV_BYTES);

	return record.buffer;
}

export async function decryptCredential(
	key: CredentialKey,
	providerId: string,
	record: ArrayBuffer,
): Promise<Credential> {
	const plaintext = await crypto.subtle.decrypt(
		{
			name: 'AES-GCM',
			iv: new Uint8Array(record, 0, IV_BYTES),
			additionalData: new TextEncoder().encode(providerId),
		},
		key,
		new Uint8Array(record, IV_BYTES),
	);

	const parsed: JsonValue = JSON.parse(new TextDecoder().decode(plaintext));

	return v.parse(credentialSchema, parsed);
}
