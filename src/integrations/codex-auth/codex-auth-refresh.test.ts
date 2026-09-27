import { ModelsError } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { codexAdminIds } from '../../config.ts';
import { CodexAuthService } from './codex-auth.ts';
import { type MemoryStorage, memoryStorage } from './memory-storage.ts';
import { permanentRefreshFailure } from './needs-login.ts';
import type { PendingLogin } from './pending-login.ts';

const TOKEN_URL = 'https://auth.openai.com/oauth/token';

const DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';

const USER_CODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';

const REVOKE_URL = 'https://auth.openai.com/oauth/revoke';

const SLACK_POST_URL = 'https://slack.com/api/chat.postMessage';

const RESPONSE_URL = 'https://hooks.slack.com/commands/T1/1/abc';

const BOT_TOKEN = 'xoxb-test';

const HOUR_MS = 60 * 60 * 1000;

const DAY_MS = 24 * HOUR_MS;

const credentialKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

type SentRequest = { url: string; body: string; authorization: string | null };

type Respond = () => Response | Promise<Response>;

// Replaces the network only; pi's real OpenAI Codex refresh code runs. Each
// URL answers from its own queue of responses; the last response repeats.
function stubFetch(routes: Map<string, Respond[]>): SentRequest[] {
	const requests: SentRequest[] = [];

	vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const request = new Request(url, init);

		requests.push({
			url,
			body: await request.text(),
			authorization: request.headers.get('Authorization'),
		});
		const queue = routes.get(url);
		const respond = queue !== undefined && queue.length > 1 ? queue.shift() : queue?.[0];

		if (respond === undefined) throw new Error(`Unexpected request to ${url}`);

		return respond();
	});

	return requests;
}

function urls(requests: SentRequest[]): string[] {
	return requests.map((request) => request.url);
}

function accessToken(label: string, lifetime?: { iat: number; exp: number }): string {
	const claims = {
		'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' },
		label,
		...lifetime,
	};

	return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

function rotated(expiresInMs = 10 * DAY_MS): Respond {
	return () =>
		Response.json({
			access_token: accessToken('new'),
			refresh_token: 'refresh-2',
			expires_in: expiresInMs / 1000,
		});
}

function slackOk(): Response {
	return Response.json({ ok: true });
}

type Fixture = { service: CodexAuthService; storage: MemoryStorage };

async function connected(
	expiresInMs: number,
	storage = memoryStorage(),
	access = accessToken('old'),
): Promise<Fixture> {
	const service = new CodexAuthService(storage, credentialKey, BOT_TOKEN);

	await service.seed({
		access,
		refresh: 'refresh-1',
		expires: Date.now() + expiresInMs,
		accountId: 'account-1',
	});

	return { service, storage };
}

function pendingLogin(overrides: Partial<PendingLogin> = {}): PendingLogin {
	return {
		deviceAuthId: 'device-1',
		userCode: 'ABCD-EFGH',
		intervalMs: 5000,
		deadline: Date.now() + 10 * 60 * 1000,
		pollAt: Date.now(),
		responseUrl: RESPONSE_URL,
		...overrides,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('permanentRefreshFailure', () => {
	test('reads the three permanent codes from pi refresh errors in every body shape', () => {
		const failure = (body: string) => new Error(`OpenAI Codex token refresh failed (401): ${body}`);

		expect(
			permanentRefreshFailure(failure('{"error":{"code":"refresh_token_expired","message":"x"}}')),
		).toBe('refresh_token_expired');
		expect(permanentRefreshFailure(failure('{"error":"refresh_token_reused"}'))).toBe(
			'refresh_token_reused',
		);
		expect(permanentRefreshFailure(failure('{"code":"refresh_token_invalidated"}'))).toBe(
			'refresh_token_invalidated',
		);
	});

	test('treats network failures, 5xx pages, and other OAuth errors as transient', () => {
		expect(
			permanentRefreshFailure(new Error('OpenAI Codex token refresh error: fetch failed')),
		).toBeUndefined();
		expect(
			permanentRefreshFailure(
				new Error('OpenAI Codex token refresh failed (502): <html>Bad Gateway</html>'),
			),
		).toBeUndefined();
		expect(
			permanentRefreshFailure(
				new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_request"}'),
			),
		).toBeUndefined();
		expect(permanentRefreshFailure(new Error('refresh_token_expired'))).toBeUndefined();
	});
});

describe('CodexAuthService needs_login', () => {
	test.each(['refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated'])(
		'%s moves the connection to needs_login, stops refreshing, and DMs the admins once',
		async (code) => {
			const requests = stubFetch(
				new Map([
					[TOKEN_URL, [() => Response.json({ error: { code } }, { status: 401 })]],
					[SLACK_POST_URL, [slackOk]],
				]),
			);

			const { service, storage } = await connected(60 * 1000);

			await expect(service.accessToken()).resolves.toBeUndefined();

			const status = await service.status();

			expect(status).toEqual({
				state: 'needs_login',
				reason: code,
				since: expect.any(Number),
			});
			expect(storage.alarm.at).toBeUndefined();
			expect(urls(requests)).toEqual([TOKEN_URL, ...[...codexAdminIds].map(() => SLACK_POST_URL)]);

			const dm = requests[1];

			expect(dm?.authorization).toBe(`Bearer ${BOT_TOKEN}`);
			expect(JSON.parse(dm?.body ?? '')).toEqual({
				channel: [...codexAdminIds][0],
				text: expect.stringContaining('/aiyappa openai connect'),
			});

			// Later requests, and a restarted object, neither call OpenAI nor DM again.
			const restarted = new CodexAuthService(storage, credentialKey, BOT_TOKEN);

			await expect(service.accessToken()).resolves.toBeUndefined();
			await expect(restarted.accessToken()).resolves.toBeUndefined();
			await expect(restarted.status()).resolves.toMatchObject({ state: 'needs_login' });
			expect(requests).toHaveLength(1 + codexAdminIds.size);
		},
	);

	test('requests queued behind the failing refresh stop without calling OpenAI', async () => {
		const requests = stubFetch(
			new Map([
				[
					TOKEN_URL,
					[
						async () => {
							await new Promise((resolve) => setTimeout(resolve, 20));

							return Response.json({ error: 'refresh_token_reused' }, { status: 401 });
						},
					],
				],
				[SLACK_POST_URL, [slackOk]],
			]),
		);

		const { service } = await connected(60 * 1000);

		const tokens = await Promise.all([
			service.accessToken(),
			service.accessToken(),
			service.accessToken(),
		]);

		expect(tokens).toEqual([undefined, undefined, undefined]);
		expect(urls(requests).filter((url) => url === TOKEN_URL)).toHaveLength(1);
		expect(urls(requests).filter((url) => url === SLACK_POST_URL)).toHaveLength(codexAdminIds.size);
	});

	test('transient failures keep the connection and retry on the next request', async () => {
		const requests = stubFetch(
			new Map<string, Respond[]>([
				[
					TOKEN_URL,
					[
						() => new Response('<html>Bad Gateway</html>', { status: 502 }),
						() => Promise.reject(new TypeError('fetch failed')),
						rotated(),
					],
				],
			]),
		);

		const { service } = await connected(60 * 1000);

		for (let attempt = 0; attempt < 2; attempt++) {
			const failure = await service.accessToken().catch((error: Error) => error);

			expect(failure).toBeInstanceOf(ModelsError);
			await expect(service.status()).resolves.toMatchObject({ state: 'connected' });
		}

		await expect(service.accessToken()).resolves.toBe(accessToken('new'));
		expect(urls(requests)).toEqual([TOKEN_URL, TOKEN_URL, TOKEN_URL]);
	});

	test('a failed admin DM warns and the caller still gets no token', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		stubFetch(
			new Map<string, Respond[]>([
				[TOKEN_URL, [() => Response.json({ error: 'refresh_token_expired' }, { status: 401 })]],
				[SLACK_POST_URL, [() => Response.json({ ok: false, error: 'channel_not_found' })]],
			]),
		);
		const { service } = await connected(60 * 1000);

		await expect(service.accessToken()).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('channel_not_found'));
	});

	test('without a bot token the transition warns instead of DMing', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const requests = stubFetch(
			new Map([
				[TOKEN_URL, [() => Response.json({ error: 'refresh_token_expired' }, { status: 401 })]],
			]),
		);

		const service = new CodexAuthService(memoryStorage(), credentialKey);

		await service.seed({
			access: accessToken('old'),
			refresh: 'refresh-1',
			expires: Date.now() + 60 * 1000,
			accountId: 'account-1',
		});

		await expect(service.accessToken()).resolves.toBeUndefined();
		expect(urls(requests)).toEqual([TOKEN_URL]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('SLACK_BOT_TOKEN'));
	});

	test('an approved login replaces the dead credential and clears needs_login', async () => {
		const requests = stubFetch(
			new Map<string, Respond[]>([
				[
					USER_CODE_URL,
					[() => Response.json({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH' })],
				],
				[
					DEVICE_TOKEN_URL,
					[() => Response.json({ authorization_code: 'code', code_verifier: 'verifier' })],
				],
				[TOKEN_URL, [rotated()]],
				[RESPONSE_URL, [() => new Response('ok')]],
			]),
		);

		const { service, storage } = await connected(60 * 1000);

		storage.needsLogin.set({ reason: 'refresh_token_expired', since: Date.now() });

		await expect(service.startLogin(RESPONSE_URL)).resolves.toMatchObject({
			state: 'pending_login',
		});
		await expect(service.status()).resolves.toMatchObject({ state: 'pending_login' });
		// The first poll is due one interval after startLogin.
		expect(storage.alarm.at).toBe(storage.pendingLogin.get()?.pollAt);

		await service.pollLogin();

		await expect(service.status()).resolves.toMatchObject({ state: 'connected' });
		await expect(service.accessToken()).resolves.toBe(accessToken('new'));
		expect(storage.needsLogin.get()).toBeUndefined();
		// The new credential is on the proactive refresh schedule.
		expect(storage.alarm.at).toBeGreaterThan(Date.now() + 8 * DAY_MS);
		expect(urls(requests)).toEqual([USER_CODE_URL, DEVICE_TOKEN_URL, TOKEN_URL, RESPONSE_URL]);
	});

	test('disconnect clears needs_login', async () => {
		stubFetch(new Map([[REVOKE_URL, [() => new Response(null, { status: 200 })]]]));
		const { service, storage } = await connected(HOUR_MS);

		storage.needsLogin.set({ reason: 'refresh_token_reused', since: Date.now() });

		await service.disconnect();

		await expect(service.status()).resolves.toEqual({ state: 'disconnected' });
		expect(storage.needsLogin.get()).toBeUndefined();
	});
});

describe('CodexAuthService proactive refresh', () => {
	test('schedules the refresh a day before expiry', async () => {
		const expiresInMs = 10 * DAY_MS;
		const before = Date.now();
		const { storage } = await connected(expiresInMs);

		expect(storage.alarm.at).toBeGreaterThanOrEqual(before + expiresInMs - DAY_MS);
		expect(storage.alarm.at).toBeLessThanOrEqual(Date.now() + expiresInMs - DAY_MS);
	});

	test('a token that lives under two days refreshes at half-life', async () => {
		const now = Math.floor(Date.now() / 1000);
		const expires = (now + 3600) * 1000;

		const { storage } = await connected(
			expires - Date.now(),
			memoryStorage(),
			accessToken('old', { iat: now, exp: now + 3600 }),
		);

		expect(storage.alarm.at).toBeGreaterThanOrEqual(expires - HOUR_MS / 2 - 1000);
		expect(storage.alarm.at).toBeLessThanOrEqual(expires - HOUR_MS / 2 + 1000);
	});

	test('an alarm before the refresh is due sends nothing and re-arms', async () => {
		const requests = stubFetch(new Map());
		const { service, storage } = await connected(10 * DAY_MS);
		const scheduled = storage.alarm.at;

		await service.alarm();

		expect(requests).toHaveLength(0);
		expect(storage.alarm.at).toBe(scheduled);
	});

	test('a due alarm refreshes through pi and schedules the next refresh', async () => {
		const requests = stubFetch(new Map([[TOKEN_URL, [rotated()]]]));
		const { service, storage } = await connected(12 * HOUR_MS);

		await service.alarm();

		expect(urls(requests)).toEqual([TOKEN_URL]);
		expect(new URLSearchParams(requests[0]?.body).get('refresh_token')).toBe('refresh-1');
		await expect(service.accessToken()).resolves.toBe(accessToken('new'));
		expect(storage.alarm.at).toBeGreaterThan(Date.now() + 8 * DAY_MS);
		expect(requests).toHaveLength(1);
	});

	test('a request refresh racing the alarm refresh sends one refresh', async () => {
		const requests = stubFetch(
			new Map([
				[
					TOKEN_URL,
					[
						async () => {
							await new Promise((resolve) => setTimeout(resolve, 20));

							return rotated()();
						},
					],
				],
			]),
		);
		// Inside pi's five-minute window, so the request refreshes too.

		const { service } = await connected(60 * 1000);

		const [token] = await Promise.all([service.accessToken(), service.alarm()]);

		expect(token).toBe(accessToken('new'));
		expect(urls(requests)).toEqual([TOKEN_URL]);
	});

	test('a transient failure keeps the credential and retries in fifteen minutes', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const requests = stubFetch(new Map([[TOKEN_URL, [() => new Response(null, { status: 503 })]]]));
		const { service, storage } = await connected(12 * HOUR_MS);
		const before = Date.now();

		await service.alarm();

		expect(urls(requests)).toEqual([TOKEN_URL]);
		await expect(service.status()).resolves.toMatchObject({ state: 'connected' });
		expect(storage.alarm.at).toBeGreaterThanOrEqual(before + 15 * 60 * 1000);
		expect(storage.alarm.at).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000);

		// Not due again yet, even though the credential is inside the day.
		await service.alarm();

		expect(requests).toHaveLength(1);
	});

	test('a permanent failure moves to needs_login, DMs, and stops the alarm', async () => {
		const requests = stubFetch(
			new Map([
				[TOKEN_URL, [() => Response.json({ error: 'refresh_token_expired' }, { status: 401 })]],
				[SLACK_POST_URL, [slackOk]],
			]),
		);

		const { service, storage } = await connected(12 * HOUR_MS);

		await service.alarm();

		await expect(service.status()).resolves.toMatchObject({ state: 'needs_login' });
		expect(storage.alarm.at).toBeUndefined();
		expect(urls(requests)).toEqual([TOKEN_URL, ...[...codexAdminIds].map(() => SLACK_POST_URL)]);
	});

	test('scheduleAlarm arms a credential stored before the alarm existed', async () => {
		const { storage } = await connected(10 * DAY_MS);

		await storage.alarm.clear();
		await new CodexAuthService(storage, credentialKey).scheduleAlarm();

		expect(storage.alarm.at).toBeGreaterThan(Date.now() + 8 * DAY_MS);
	});
});

describe('CodexAuthService alarm with a pending login and a credential', () => {
	test('the alarm is set to the earlier of the next poll and the next refresh', async () => {
		const { service, storage } = await connected(10 * DAY_MS);
		const refreshAt = storage.alarm.at;
		const pollAt = Date.now() + 5000;

		storage.pendingLogin.set(pendingLogin({ pollAt }));
		await service.scheduleAlarm();

		expect(storage.alarm.at).toBe(pollAt);

		storage.pendingLogin.clear();
		await service.scheduleAlarm();

		expect(storage.alarm.at).toBe(refreshAt);
	});

	test('a due refresh runs without polling a login that is not due yet', async () => {
		const requests = stubFetch(new Map([[TOKEN_URL, [rotated()]]]));
		const { service, storage } = await connected(12 * HOUR_MS);
		const pollAt = Date.now() + 5000;

		storage.pendingLogin.set(pendingLogin({ pollAt }));
		await service.alarm();

		expect(urls(requests)).toEqual([TOKEN_URL]);
		expect(storage.pendingLogin.get()?.pollAt).toBe(pollAt);
		expect(storage.alarm.at).toBe(pollAt);
	});

	test('a due poll runs without refreshing, and the alarm keeps the refresh behind the poll', async () => {
		const requests = stubFetch(
			new Map([[DEVICE_TOKEN_URL, [() => new Response(null, { status: 403 })]]]),
		);

		const { service, storage } = await connected(10 * DAY_MS);
		const refreshAt = storage.alarm.at;

		storage.pendingLogin.set(pendingLogin());
		const before = Date.now();

		await service.alarm();

		expect(urls(requests)).toEqual([DEVICE_TOKEN_URL]);
		expect(storage.alarm.at).toBeGreaterThanOrEqual(before + 5000);
		expect(storage.alarm.at).toBeLessThan(refreshAt ?? 0);
	});

	test('when both are due, one alarm polls and refreshes', async () => {
		const requests = stubFetch(
			new Map<string, Respond[]>([
				[DEVICE_TOKEN_URL, [() => new Response(null, { status: 403 })]],
				[TOKEN_URL, [rotated()]],
			]),
		);

		const { service, storage } = await connected(12 * HOUR_MS);

		storage.pendingLogin.set(pendingLogin());
		const before = Date.now();

		await service.alarm();

		expect(urls(requests).toSorted()).toEqual([DEVICE_TOKEN_URL, TOKEN_URL].toSorted());
		expect(storage.alarm.at).toBeGreaterThanOrEqual(before + 5000);
		expect(storage.alarm.at).toBeLessThanOrEqual(Date.now() + 5000);
	});

	test('a login that settles hands the alarm back to the refresh schedule', async () => {
		const requests = stubFetch(
			new Map<string, Respond[]>([
				[
					DEVICE_TOKEN_URL,
					[() => Response.json({ error: { code: 'expired_token' } }, { status: 400 })],
				],
				[RESPONSE_URL, [() => new Response('ok')]],
			]),
		);

		const { service, storage } = await connected(10 * DAY_MS);
		const refreshAt = storage.alarm.at;

		storage.pendingLogin.set(pendingLogin());
		await service.alarm();

		expect(urls(requests)).toEqual([DEVICE_TOKEN_URL, RESPONSE_URL]);
		expect(storage.pendingLogin.get()).toBeUndefined();
		expect(storage.alarm.at).toBe(refreshAt);
	});

	test('a poll that throws is pushed back by its interval instead of spinning', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const storage = memoryStorage();

		stubFetch(
			new Map<string, Respond[]>([
				[
					DEVICE_TOKEN_URL,
					[() => Response.json({ authorization_code: 'code', code_verifier: 'verifier' })],
				],
				[TOKEN_URL, [rotated()]],
			]),
		);
		// Without a key the approved credential cannot be stored.
		const service = new CodexAuthService(storage, undefined);

		storage.pendingLogin.set(pendingLogin());
		const before = Date.now();

		await service.alarm();

		expect(storage.pendingLogin.get()?.pollAt).toBeGreaterThanOrEqual(before + 5000);
		expect(storage.alarm.at).toBe(storage.pendingLogin.get()?.pollAt);
	});
});
