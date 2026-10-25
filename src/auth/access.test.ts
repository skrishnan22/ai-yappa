import { Hono } from 'hono';
import { generateKeyPair } from 'jose';
import { afterAll, expect, test, vi } from 'vitest';
import { accessTestIdentity, TEST_ACCESS_ENV } from '../testing/access.ts';
import { requireAccess, type AccessEnv } from './access.ts';

const identity = await accessTestIdentity();

const fetchKeys = vi.fn<typeof fetch>(async () => Response.json(identity.jwks));

vi.stubGlobal('fetch', fetchKeys);

afterAll(() => vi.unstubAllGlobals());

const app = new Hono<{ Bindings: AccessEnv }>();

app.use('/private/*', requireAccess());

app.get('/private/page', (c) => c.text('Private content'));

app.get('/slack/events', (c) => c.text('Public ingress'));

test('accepts a correctly signed token and reuses the issuer key cache', async () => {
	const token = await identity.token();

	for (let i = 0; i < 2; i++) {
		const response = await app.request(
			'/private/page',
			{ headers: { 'Cf-Access-Jwt-Assertion': token } },
			TEST_ACCESS_ENV,
		);

		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toBe('Private content');
		expect(response.headers.get('cache-control')).toBe('private, no-store');
	}

	expect(fetchKeys).toHaveBeenCalledOnce();
});

test.each(['missing', 'email-header', 'expired', 'wrong-audience', 'wrong-issuer', 'forged'])(
	'denies %s authentication',
	async (scenario) => {
		const headers = new Headers();
		let token: string | undefined;

		if (scenario === 'email-header')
			headers.set('Cf-Access-Authenticated-User-Email', 'reviewer@example.com');

		if (scenario === 'expired') token = await identity.token({ expiration: '-1s' });

		if (scenario === 'wrong-audience') token = await identity.token({ audience: 'some-other-app' });

		if (scenario === 'wrong-issuer')
			token = await identity.token({ issuer: 'https://other.cloudflareaccess.com' });

		if (scenario === 'forged') {
			const unrelated = await generateKeyPair('RS256');
			token = await identity.token({ privateKey: unrelated.privateKey });
		}

		if (token) headers.set('Cf-Access-Jwt-Assertion', token);

		const response = await app.request('/private/page', { headers }, TEST_ACCESS_ENV);
		expect(response.status).toBe(401);
		expect(response.headers.get('cache-control')).toBe('private, no-store');
	},
);

test.each([
	{},
	{ ACCESS_TEAM_DOMAIN: 'http://unsafe.example', ACCESS_AUD: 'test' },
	{ ...TEST_ACCESS_ENV, ACCESS_AUD: '' },
])('fails closed without valid configuration', async (env) => {
	const response = await app.request('/private/page', {}, env);
	expect(response.status).toBe(503);
});

test('leaves unrelated routes public', async () => {
	const response = await app.request('/slack/events', {}, {});
	expect(response.status).toBe(200);
});

test('denies access when the signing keys cannot be fetched', async () => {
	const issuer = 'https://unavailable.cloudflareaccess.com';
	const token = await identity.token({ issuer });
	fetchKeys.mockRejectedValueOnce(new Error('Key server unavailable'));

	const response = await app.request(
		'/private/page',
		{ headers: { 'Cf-Access-Jwt-Assertion': token } },
		{ ...TEST_ACCESS_ENV, ACCESS_TEAM_DOMAIN: issuer },
	);

	expect(response.status).toBe(401);
});
