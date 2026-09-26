import type { OAuthCredential } from '@earendil-works/pi-ai';
import { decodeJwt } from 'jose';
import * as v from 'valibot';
import type { JsonValue } from '../../json.ts';

// OpenAI's device-code login for the Codex CLI's public client, as pi 0.86
// implements it in `auth/oauth/openai-codex.js` and `device-code.js`. pi keeps
// those helpers module-private and polls in-process, so `CodexAuth` drives the
// same requests one poll per Durable Object alarm.

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const AUTH_BASE_URL = 'https://auth.openai.com';

export const DEVICE_VERIFICATION_URL = `${AUTH_BASE_URL}/codex/device`;

export const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

const MINIMUM_INTERVAL_MS = 1000;

// RFC 8628 §3.2: without an `interval`, poll every 5 seconds.
const DEFAULT_INTERVAL_MS = 5000;

// RFC 8628 §3.5: `slow_down` adds 5 seconds to the interval.
export const SLOW_DOWN_INCREMENT_MS = 5000;

const REQUEST_TIMEOUT_MS = 10_000;

const nonEmpty = v.pipe(v.string(), v.minLength(1));

const deviceCodeSchema = v.looseObject({
	device_auth_id: nonEmpty,
	user_code: nonEmpty,
	interval: v.optional(v.union([v.number(), v.string()])),
});

const approvalSchema = v.looseObject({ authorization_code: nonEmpty, code_verifier: nonEmpty });

const errorCodeSchema = v.looseObject({
	error: v.union([v.string(), v.looseObject({ code: v.string() })]),
});

const tokenSchema = v.looseObject({
	access_token: nonEmpty,
	refresh_token: nonEmpty,
	expires_in: v.number(),
});

const accessClaimsSchema = v.looseObject({
	'https://api.openai.com/auth': v.looseObject({ chatgpt_account_id: nonEmpty }),
});

export type DeviceCode = { deviceAuthId: string; userCode: string; intervalMs: number };

export type DevicePoll =
	| { kind: 'approved'; authorizationCode: string; codeVerifier: string }
	| { kind: 'pending' }
	| { kind: 'slow_down' }
	| { kind: 'failed'; message: string };

export type CodexOAuthCredential = OAuthCredential & { accountId: string };

export async function requestDeviceCode(): Promise<DeviceCode> {
	const response = await fetch(`${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});

	if (response.status === 404) {
		throw new Error('OpenAI has not enabled device code login for the Codex client (HTTP 404)');
	}

	if (!response.ok) throw new Error(await failureMessage('Device code request', response));
	const parsed = v.safeParse(deviceCodeSchema, await response.json());

	if (!parsed.success) throw new Error('OpenAI returned an unexpected device code response');

	return {
		deviceAuthId: parsed.output.device_auth_id,
		userCode: parsed.output.user_code,
		intervalMs: pollIntervalMs(parsed.output.interval),
	};
}

// `interval` is seconds, and OpenAI sometimes sends it as a string.
function pollIntervalMs(interval: number | string | undefined): number {
	const seconds = Number(interval ?? Number.NaN);

	if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_INTERVAL_MS;

	return Math.max(MINIMUM_INTERVAL_MS, Math.floor(seconds * 1000));
}

// One poll. A network failure, 429, or 5xx reads as pending: the next alarm
// retries, and the login deadline bounds the retries.
export async function pollDeviceCode(code: DeviceCode): Promise<DevicePoll> {
	let response: Response;

	try {
		response = await fetch(`${AUTH_BASE_URL}/api/accounts/deviceauth/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ device_auth_id: code.deviceAuthId, user_code: code.userCode }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch {
		return { kind: 'pending' };
	}

	if (response.ok) {
		const parsed = v.safeParse(approvalSchema, await response.json());

		if (!parsed.success) {
			return { kind: 'failed', message: 'OpenAI returned an unexpected device approval response' };
		}

		return {
			kind: 'approved',
			authorizationCode: parsed.output.authorization_code,
			codeVerifier: parsed.output.code_verifier,
		};
	}

	if (response.status === 403 || response.status === 404) return { kind: 'pending' };

	if (response.status === 429 || response.status >= 500) return { kind: 'pending' };
	const text = await response.text();
	const errorCode = deviceErrorCode(text);

	if (errorCode === 'deviceauth_authorization_pending') return { kind: 'pending' };

	if (errorCode === 'slow_down') return { kind: 'slow_down' };

	return { kind: 'failed', message: failureText('Device approval', response.status, text) };
}

function deviceErrorCode(text: string): string | undefined {
	try {
		const body: JsonValue = JSON.parse(text);
		const parsed = v.safeParse(errorCodeSchema, body);

		if (!parsed.success) return undefined;
		const { error } = parsed.output;

		return v.is(v.string(), error) ? error : error.code;
	} catch {
		return undefined;
	}
}

export async function exchangeDeviceCode(
	authorizationCode: string,
	codeVerifier: string,
): Promise<CodexOAuthCredential> {
	const response = await fetch(`${AUTH_BASE_URL}/oauth/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: CODEX_CLIENT_ID,
			code: authorizationCode,
			code_verifier: codeVerifier,
			redirect_uri: `${AUTH_BASE_URL}/deviceauth/callback`,
		}),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});

	if (!response.ok) throw new Error(await failureMessage('Token exchange', response));
	const parsed = v.safeParse(tokenSchema, await response.json());

	if (!parsed.success) throw new Error('OpenAI returned an unexpected token response');

	const { access_token: access, refresh_token: refresh, expires_in: expiresIn } = parsed.output;

	return {
		type: 'oauth',
		access,
		refresh,
		expires: Date.now() + expiresIn * 1000,
		accountId: accountIdFromAccessToken(access),
	};
}

// pi's `openai-codex` provider sends this claim as the `chatgpt-account-id`
// header, so a credential without it cannot make model calls.
function accountIdFromAccessToken(access: string): string {
	const claims = v.safeParse(accessClaimsSchema, decodeJwt(access));

	if (!claims.success) throw new Error('The ChatGPT access token has no account id');

	return claims.output['https://api.openai.com/auth'].chatgpt_account_id;
}

// RFC 7009 revocation for a public client. OpenAI answers 200 for a token it
// does not know, so `true` means the token is no longer usable.
export async function revokeRefreshToken(refresh: string): Promise<boolean> {
	try {
		const response = await fetch(`${AUTH_BASE_URL}/oauth/revoke`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				token: refresh,
				token_type_hint: 'refresh_token',
				client_id: CODEX_CLIENT_ID,
			}),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});

		return response.ok;
	} catch {
		return false;
	}
}

async function failureMessage(action: string, response: Response): Promise<string> {
	return failureText(action, response.status, await response.text());
}

// OpenAI error bodies carry codes and descriptions, never tokens.
function failureText(action: string, status: number, text: string): string {
	const detail = text.trim().slice(0, 200);

	return `${action} failed with HTTP ${status}${detail ? `: ${detail}` : ''}`;
}
