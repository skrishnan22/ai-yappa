import { afterAll, expect, test, vi } from 'vitest';
import { createWalkthroughPublisher } from './publish.ts';
import { walkthroughRoutes } from './routes.ts';
import { walkthroughExample as example, memoryBucket } from '../testing/walkthrough.ts';
import { accessTestIdentity, TEST_ACCESS_ENV } from '../testing/access.ts';

const identity = await accessTestIdentity();

vi.stubGlobal('fetch', async () => Response.json(identity.jwks));

afterAll(() => vi.unstubAllGlobals());

test('rejects anonymous page and image requests before reading any stored content', async () => {
	const bucket = memoryBucket();
	const get = vi.spyOn(bucket, 'get');
	const app = walkthroughRoutes();

	for (const path of [`/${'1'.repeat(32)}`, `/${'1'.repeat(32)}/preview.png`]) {
		const response = await app.request(path, {}, { ARTIFACTS: bucket, ...TEST_ACCESS_ENV });
		expect(response.status).toBe(401);
	}

	expect(get).not.toHaveBeenCalled();
});

test('serves a published scene with safe data, source provenance and its preview', async () => {
	const bucket = memoryBucket();

	const publish = createWalkthroughPublisher({
		bucket,
		origin: 'https://agent.example',
		render: async () => ({
			png: new Uint8Array([137, 80]),
			preview: new Uint8Array([255, 216]),
			width: 1280,
			height: 900,
		}),
	});

	const result = await publish({
		conversationId: 'one',
		input: { ...example, title: '</script><img src=x onerror=alert(1)>' },
	});

	const app = walkthroughRoutes();
	const url = new URL(result.url);
	const token = await identity.token();
	const authorized = { headers: { 'Cf-Access-Jwt-Assertion': token } };
	const bindings = { ARTIFACTS: bucket, ...TEST_ACCESS_ENV };

	const response = await app.request(
		url.pathname.replace('/walkthroughs', ''),
		authorized,
		bindings,
	);

	const html = await response.text();
	expect(response.status).toBe(200);
	expect(response.headers.get('cache-control')).toBe('private, no-store');
	expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'");
	expect(response.headers.get('referrer-policy')).toBe('no-referrer');
	expect(response.headers.get('x-robots-tag')).toContain('noindex');
	expect(html).not.toContain('</script><img');
	expect(html).toContain('\\u003c/script>');
	expect(html).toContain('/render/build/walkthrough-player.js');

	const preview = await app.request(
		`${url.pathname.replace('/walkthroughs', '')}/preview.png`,
		authorized,
		bindings,
	);

	expect(preview.headers.get('content-type')).toBe('image/png');
	expect(preview.headers.get('cache-control')).toBe('private, no-store');
	const previewBytes = await preview.arrayBuffer();
	expect(new Uint8Array(previewBytes)).toEqual(new Uint8Array([137, 80]));

	for (const path of ['/bad', `/${'0'.repeat(32)}`, `/${'0'.repeat(32)}/preview.png`]) {
		const missing = await app.request(path, authorized, bindings);
		expect(missing.status).toBe(404);
	}
});
