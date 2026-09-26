import type { Credential } from '@earendil-works/pi-ai';
import { CompactEncrypt, compactDecrypt } from 'jose';
import * as v from 'valibot';
import type { JsonValue } from '../../json.ts';

const KEY_BYTES = 32;

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

export function credentialKey(secret: string | undefined): Uint8Array {
	const bytes = secret ? base64Bytes(secret.trim()) : undefined;

	if (bytes?.byteLength !== KEY_BYTES) {
		throw new Error('CODEX_CREDENTIAL_KEY must be 32 random bytes, base64-encoded');
	}

	return bytes;
}

function base64Bytes(value: string): Uint8Array | undefined {
	try {
		return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
	} catch {
		return undefined;
	}
}

// A compact JWE (direct AES-256-GCM). The provider id is in the authenticated
// header, so a record cannot be replayed under another provider's row.
export function encryptCredential(
	key: Uint8Array,
	providerId: string,
	credential: Credential,
): Promise<string> {
	return new CompactEncrypt(new TextEncoder().encode(JSON.stringify(credential)))
		.setProtectedHeader({ alg: 'dir', enc: 'A256GCM', provider: providerId })
		.encrypt(key);
}

export async function decryptCredential(
	key: Uint8Array,
	providerId: string,
	record: string,
): Promise<Credential> {
	const { plaintext, protectedHeader } = await compactDecrypt(record, key, {
		keyManagementAlgorithms: ['dir'],
		contentEncryptionAlgorithms: ['A256GCM'],
	});

	if (protectedHeader.provider !== providerId) {
		throw new Error(`Credential record is not for provider ${providerId}`);
	}

	const parsed: JsonValue = JSON.parse(new TextDecoder().decode(plaintext));

	return v.parse(credentialSchema, parsed);
}
