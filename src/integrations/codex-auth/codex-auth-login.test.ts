import { afterEach, describe, expect, test, vi } from 'vitest';
import { CodexAuthService } from './codex-auth.ts';
import { UnreadableCredentialError } from './durable-credential-store.ts';
import { type MemoryStorage, memoryStorage } from './memory-storage.ts';
import type { PendingLogin } from './pending-login.ts';

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const USER_CODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';

const DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';

const TOKEN_URL = 'https://auth.openai.com/oauth/token';

const REVOKE_URL = 'https://auth.openai.com/oauth/revoke';

const RESPONSE_URL = 'https://hooks.slack.com/commands/T1/1/abc';

const OTHER_RESPONSE_URL = 'https://hooks.slack.com/commands/T1/2/def';

function randomKey(): string {
	return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

const credentialKey = randomKey();

type SentRequest = { url: string; body: string };

// Replaces the network only. Each URL answers from its own queue of
// responses; the last response repeats.
function stubFetch(routes: Map<string, (() => Response | Promise<Response>)[]>): SentRequest[] {
	const requests: SentRequest[] = [];

	vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const queue = routes.get(url);

		requests.push({ url, body: await new Request(url, init).text() });

		if (queue === undefined || queue.length === 0) throw new Error(`Unexpected request to ${url}`);
		const respond = queue.length > 1 ? queue.shift() : queue[0];

		if (respond === undefined) throw new Error(`Unexpected request to ${url}`);

		return respond();
	});

	return requests;
}

function slackOk(): Response {
	return new Response('ok');
}

function accessToken(accountId: string): string {
	const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: accountId } };

	return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

function pendingLogin(overrides: Partial<PendingLogin> = {}): PendingLogin {
	return {
		deviceAuthId: 'device-1',
		userCode: 'ABCD-EFGH',
		intervalMs: 5000,
		deadline: Date.now() + 10 * 60 * 1000,
		responseUrl: RESPONSE_URL,
		...overrides,
	};
}

type LoginFixture = { service: CodexAuthService; storage: MemoryStorage };

function serviceWithPendingLogin(login = pendingLogin()): LoginFixture {
	const storage = memoryStorage();

	storage.pendingLogin.set(login);

	return { service: new CodexAuthService(storage, credentialKey), storage };
}

function slackText(request: SentRequest | undefined): string {
	const body: { replace_original: boolean; response_type: string; text: string } = JSON.parse(
		request?.body ?? '',
	);

	expect(body).toMatchObject({ replace_original: true, response_type: 'ephemeral' });

	return body.text;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('CodexAuthService device-code login', () => {
	test('startLogin requests a device code, stores the pending login, and schedules the first poll', async () => {
		const requests = stubFetch(
			new Map([
				[
					USER_CODE_URL,
					[
						() =>
							Response.json({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH', interval: '3' }),
					],
				],
			]),
		);

		const storage = memoryStorage();
		const service = new CodexAuthService(storage, credentialKey);
		const before = Date.now();

		const result = await service.startLogin(RESPONSE_URL);

		expect(result).toEqual({
			state: 'pending_login',
			expires: expect.any(Number),
			userCode: 'ABCD-EFGH',
			verificationUrl: 'https://auth.openai.com/codex/device',
		});
		expect(result.expires).toBeGreaterThanOrEqual(before + 15 * 60 * 1000);
		expect(JSON.parse(requests[0]?.body ?? '')).toEqual({ client_id: CODEX_CLIENT_ID });
		expect(storage.pendingLogin.get()).toEqual({
			deviceAuthId: 'device-1',
			userCode: 'ABCD-EFGH',
			intervalMs: 3000,
			deadline: result.expires,
			responseUrl: RESPONSE_URL,
		});
		expect(storage.alarm.at).toBeGreaterThanOrEqual(before + 3000);
		expect(storage.alarm.at).toBeLessThanOrEqual(Date.now() + 3000);

		const status = await service.status();

		expect(status).toEqual({ state: 'pending_login', expires: result.expires });
		expect(JSON.stringify(status)).not.toContain('ABCD-EFGH');
	});

	test('an approved poll exchanges the code, stores the credential, and edits the Slack message', async () => {
		const requests = stubFetch(
			new Map([
				[
					DEVICE_TOKEN_URL,
					[() => Response.json({ authorization_code: 'auth-code', code_verifier: 'verifier' })],
				],
				[
					TOKEN_URL,
					[
						() =>
							Response.json({
								access_token: accessToken('account-1'),
								refresh_token: 'refresh-1',
								expires_in: 3600,
							}),
					],
				],
				[RESPONSE_URL, [slackOk]],
			]),
		);

		const { service, storage } = serviceWithPendingLogin();

		await service.pollLogin();

		expect(requests.map((request) => request.url)).toEqual([
			DEVICE_TOKEN_URL,
			TOKEN_URL,
			RESPONSE_URL,
		]);
		expect(JSON.parse(requests[0]?.body ?? '')).toEqual({
			device_auth_id: 'device-1',
			user_code: 'ABCD-EFGH',
		});
		expect(requests[1]?.body).toBe(
			new URLSearchParams({
				grant_type: 'authorization_code',
				client_id: CODEX_CLIENT_ID,
				code: 'auth-code',
				code_verifier: 'verifier',
				redirect_uri: 'https://auth.openai.com/deviceauth/callback',
			}).toString(),
		);
		await expect(service.status()).resolves.toMatchObject({
			state: 'connected',
			accountId: 'account-1',
		});
		await expect(service.accessToken()).resolves.toBe(accessToken('account-1'));
		expect(storage.pendingLogin.get()).toBeUndefined();
		expect(slackText(requests[2])).toContain('account-1');
	});

	test('pending polls reschedule at the interval, and slow_down adds five seconds', async () => {
		stubFetch(
			new Map([
				[
					DEVICE_TOKEN_URL,
					[
						() => new Response(null, { status: 403 }),
						() =>
							Response.json(
								{ error: { code: 'deviceauth_authorization_pending' } },
								{ status: 400 },
							),
						() => Response.json({ error: 'slow_down' }, { status: 400 }),
						() => new Response(null, { status: 503 }),
					],
				],
			]),
		);
		const { service, storage } = serviceWithPendingLogin();

		for (const expectedIntervalMs of [5000, 5000, 10_000, 10_000]) {
			const before = Date.now();

			await service.pollLogin();

			expect(storage.pendingLogin.get()?.intervalMs).toBe(expectedIntervalMs);
			expect(storage.alarm.at).toBeGreaterThanOrEqual(before + expectedIntervalMs);
		}
	});

	test('the last poll is scheduled at the deadline, where the login expires without calling OpenAI', async () => {
		const requests = stubFetch(
			new Map([
				[DEVICE_TOKEN_URL, [() => new Response(null, { status: 403 })]],
				[RESPONSE_URL, [slackOk]],
			]),
		);

		const deadline = Date.now() + 1000;
		const { service, storage } = serviceWithPendingLogin(pendingLogin({ deadline }));

		await service.pollLogin();

		expect(storage.alarm.at).toBe(deadline);

		storage.pendingLogin.set(pendingLogin({ deadline: Date.now() - 1 }));
		await service.pollLogin();

		expect(requests.map((request) => request.url)).toEqual([DEVICE_TOKEN_URL, RESPONSE_URL]);
		expect(slackText(requests[1])).toContain('expired');
		expect(storage.pendingLogin.get()).toBeUndefined();
	});

	test('an unexpected poll error ends the login and reports it', async () => {
		const requests = stubFetch(
			new Map([
				[
					DEVICE_TOKEN_URL,
					[() => Response.json({ error: { code: 'expired_token' } }, { status: 400 })],
				],
				[RESPONSE_URL, [slackOk]],
			]),
		);

		const { service, storage } = serviceWithPendingLogin();

		await service.pollLogin();

		expect(storage.pendingLogin.get()).toBeUndefined();
		expect(storage.alarm.at).toBeUndefined();
		expect(slackText(requests[1])).toMatch(/ChatGPT login failed: .*HTTP 400.*expired_token/);
		await expect(service.status()).resolves.toEqual({ state: 'disconnected' });
	});

	test('a disconnect during the token exchange waits for it, then revokes the new credential', async () => {
		const exchange = Promise.withResolvers<Response>();

		const requests = stubFetch(
			new Map([
				[
					DEVICE_TOKEN_URL,
					[() => Response.json({ authorization_code: 'auth-code', code_verifier: 'verifier' })],
				],
				[TOKEN_URL, [() => exchange.promise]],
				[REVOKE_URL, [() => new Response(null, { status: 200 })]],
				[RESPONSE_URL, [slackOk]],
			]),
		);

		const { service } = serviceWithPendingLogin();
		const polling = service.pollLogin();

		await vi.waitFor(() => {
			expect(requests.map((request) => request.url)).toContain(TOKEN_URL);
		});
		const disconnecting = service.disconnect();

		exchange.resolve(
			Response.json({
				access_token: accessToken('account-1'),
				refresh_token: 'refresh-1',
				expires_in: 3600,
			}),
		);

		await expect(disconnecting).resolves.toEqual({ revocation: 'revoked', cancelledLogin: false });
		await polling;

		expect(requests.find((request) => request.url === REVOKE_URL)?.body).toContain(
			'token=refresh-1',
		);
		await expect(service.status()).resolves.toEqual({ state: 'disconnected' });
	});

	test('a disconnect while the device code request is in flight cancels that login once it lands', async () => {
		const userCode = Promise.withResolvers<Response>();

		const requests = stubFetch(
			new Map([
				[USER_CODE_URL, [() => userCode.promise]],
				[RESPONSE_URL, [slackOk]],
			]),
		);

		const storage = memoryStorage();
		const service = new CodexAuthService(storage, credentialKey);
		const connecting = service.startLogin(RESPONSE_URL);

		await vi.waitFor(() => {
			expect(requests.map((request) => request.url)).toContain(USER_CODE_URL);
		});
		const disconnecting = service.disconnect();

		userCode.resolve(
			Response.json({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH', interval: 5 }),
		);

		await expect(connecting).resolves.toMatchObject({ state: 'pending_login' });
		await expect(disconnecting).resolves.toEqual({ revocation: 'none', cancelledLogin: true });
		expect(storage.pendingLogin.get()).toBeUndefined();
		expect(storage.alarm.at).toBeUndefined();
		expect(slackText(requests.at(-1))).toContain('cancelled');
	});

	test('a connect during the token exchange waits for it, then reports the new connection', async () => {
		const exchange = Promise.withResolvers<Response>();

		const requests = stubFetch(
			new Map([
				[
					DEVICE_TOKEN_URL,
					[() => Response.json({ authorization_code: 'auth-code', code_verifier: 'verifier' })],
				],
				[TOKEN_URL, [() => exchange.promise]],
				[RESPONSE_URL, [slackOk]],
			]),
		);

		const { service, storage } = serviceWithPendingLogin();
		const polling = service.pollLogin();

		await vi.waitFor(() => {
			expect(requests.map((request) => request.url)).toContain(TOKEN_URL);
		});
		const connecting = service.startLogin(OTHER_RESPONSE_URL);

		exchange.resolve(
			Response.json({
				access_token: accessToken('account-1'),
				refresh_token: 'refresh-1',
				expires_in: 3600,
			}),
		);

		await expect(connecting).resolves.toMatchObject({
			state: 'connected',
			accountId: 'account-1',
		});
		await polling;

		expect(storage.pendingLogin.get()).toBeUndefined();
		expect(requests.map((request) => request.url)).not.toContain(USER_CODE_URL);
	});

	test('startLogin keeps an existing credential and requests nothing', async () => {
		const requests = stubFetch(new Map());
		const service = new CodexAuthService(memoryStorage(), credentialKey);

		await service.seed({
			access: accessToken('account-1'),
			refresh: 'refresh-1',
			expires: Date.now() + 60 * 60 * 1000,
			accountId: 'account-1',
		});

		await expect(service.startLogin(RESPONSE_URL)).resolves.toMatchObject({
			state: 'connected',
			accountId: 'account-1',
		});
		expect(requests).toHaveLength(0);
	});

	test('startLogin reports that device code login is not enabled', async () => {
		stubFetch(new Map([[USER_CODE_URL, [() => new Response(null, { status: 404 })]]]));
		const storage = memoryStorage();
		const service = new CodexAuthService(storage, credentialKey);

		await expect(service.startLogin(RESPONSE_URL)).rejects.toThrow(/not enabled device code login/);
		expect(storage.pendingLogin.get()).toBeUndefined();
		expect(storage.alarm.at).toBeUndefined();
	});

	test('startLogin fails before any request without a credential key', async () => {
		const requests = stubFetch(new Map());
		const service = new CodexAuthService(memoryStorage(), undefined);

		await expect(service.startLogin(RESPONSE_URL)).rejects.toThrow(/CODEX_CREDENTIAL_KEY/);
		expect(requests).toHaveLength(0);
	});
});

describe('CodexAuthService disconnect', () => {
	async function connectedService(): Promise<CodexAuthService> {
		const service = new CodexAuthService(memoryStorage(), credentialKey);

		await service.seed({
			access: accessToken('account-1'),
			refresh: 'refresh-1',
			expires: Date.now() + 60 * 60 * 1000,
			accountId: 'account-1',
		});

		return service;
	}

	test('revokes the refresh token (RFC 7009), then deletes the credential', async () => {
		const requests = stubFetch(
			new Map([[REVOKE_URL, [() => new Response(null, { status: 200 })]]]),
		);

		const service = await connectedService();

		await expect(service.disconnect()).resolves.toEqual({
			revocation: 'revoked',
			cancelledLogin: false,
		});
		expect(requests[0]?.body).toBe(
			new URLSearchParams({
				token: 'refresh-1',
				token_type_hint: 'refresh_token',
				client_id: CODEX_CLIENT_ID,
			}).toString(),
		);
		await expect(service.status()).resolves.toEqual({ state: 'disconnected' });
		await expect(service.accessToken()).resolves.toBeUndefined();
	});

	test('deletes the credential even when revocation fails', async () => {
		stubFetch(new Map([[REVOKE_URL, [() => new Response(null, { status: 500 })]]]));
		const service = await connectedService();

		await expect(service.disconnect()).resolves.toEqual({
			revocation: 'failed',
			cancelledLogin: false,
		});
		await expect(service.status()).resolves.toEqual({ state: 'disconnected' });
	});

	test('deletes a credential that no longer decrypts, without revoking it', async () => {
		const requests = stubFetch(new Map());
		const storage = memoryStorage();

		await new CodexAuthService(storage, credentialKey).seed({
			access: accessToken('account-1'),
			refresh: 'refresh-1',
			expires: Date.now() + 60 * 60 * 1000,
			accountId: 'account-1',
		});

		const rekeyed = new CodexAuthService(storage, randomKey());

		await expect(rekeyed.status()).rejects.toThrow(UnreadableCredentialError);
		await expect(rekeyed.disconnect()).resolves.toEqual({
			revocation: 'unreadable',
			cancelledLogin: false,
		});
		await expect(rekeyed.status()).resolves.toEqual({ state: 'disconnected' });
		expect(requests).toHaveLength(0);
	});

	test('deletes nothing without a credential key', async () => {
		const requests = stubFetch(new Map());
		const storage = memoryStorage();
		const service = new CodexAuthService(storage, credentialKey);

		await service.seed({
			access: accessToken('account-1'),
			refresh: 'refresh-1',
			expires: Date.now() + 60 * 60 * 1000,
			accountId: 'account-1',
		});

		const keyless = new CodexAuthService(storage, undefined);

		await expect(keyless.disconnect()).rejects.toThrow(/CODEX_CREDENTIAL_KEY/);
		await expect(service.status()).resolves.toMatchObject({ state: 'connected' });
		expect(requests).toHaveLength(0);
	});

	test('cancels a pending login and its alarm', async () => {
		const requests = stubFetch(new Map([[RESPONSE_URL, [slackOk]]]));
		const { service, storage } = serviceWithPendingLogin();

		await storage.alarm.set(Date.now() + 5000);

		await expect(service.disconnect()).resolves.toEqual({
			revocation: 'none',
			cancelledLogin: true,
		});
		expect(storage.pendingLogin.get()).toBeUndefined();
		expect(storage.alarm.at).toBeUndefined();
		expect(slackText(requests[0])).toContain('cancelled');
	});
});
