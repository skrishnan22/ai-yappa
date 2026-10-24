import { expect, test } from 'vitest';
import { createWalkthroughPublisher } from './publish.ts';
import { walkthroughRoutes } from './routes.ts';
import { walkthroughExample as example, memoryBucket } from '../testing/walkthrough.ts';

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

	const response = await app.request(
		url.pathname.replace('/walkthroughs', ''),
		{},
		{ ARTIFACTS: bucket },
	);

	const html = await response.text();
	expect(response.status).toBe(200);
	expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'");
	expect(response.headers.get('referrer-policy')).toBe('no-referrer');
	expect(response.headers.get('x-robots-tag')).toContain('noindex');
	expect(html).not.toContain('</script><img');
	expect(html).toContain('\\u003c/script>');
	expect(html).toContain('/render/build/walkthrough-player.js');

	const preview = await app.request(
		`${url.pathname.replace('/walkthroughs', '')}/preview.png`,
		{},
		{ ARTIFACTS: bucket },
	);

	expect(preview.headers.get('content-type')).toBe('image/png');
	const previewBytes = await preview.arrayBuffer();
	expect(new Uint8Array(previewBytes)).toEqual(new Uint8Array([137, 80]));

	for (const path of ['/bad', `/${'0'.repeat(32)}`, `/${'0'.repeat(32)}/preview.png`]) {
		const missing = await app.request(path, {}, { ARTIFACTS: bucket });
		expect(missing.status).toBe(404);
	}
});
