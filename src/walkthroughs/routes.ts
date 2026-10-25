import { Hono } from 'hono';
import * as v from 'valibot';
import type { ArtifactBucket } from '../visuals/artifact-store.ts';
import { walkthroughSchema } from './format.ts';
import { requireAccess, type AccessEnv } from '../auth/access.ts';

const headers = {
	'Content-Security-Policy':
		"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	'X-Content-Type-Options': 'nosniff',
	'X-Robots-Tag': 'noindex, nofollow, noarchive',
	'Referrer-Policy': 'no-referrer',
};

export function walkthroughRoutes() {
	const app = new Hono<{ Bindings: AccessEnv & { ARTIFACTS?: ArtifactBucket } }>();
	app.use('*', requireAccess());

	app.get('/:id', async (c) => {
		const id = c.req.param('id');

		if (!/^[a-f0-9]{32}$/.test(id) || !c.env?.ARTIFACTS) return c.notFound();
		const object = await c.env.ARTIFACTS.get(`walkthroughs/${id}.json`);

		if (!object) return c.notFound();
		const bytes = await object.arrayBuffer();
		const doc = v.parse(walkthroughSchema, JSON.parse(new TextDecoder().decode(bytes)));
		const data = JSON.stringify(doc).replaceAll('<', '\\u003c');

		return new Response(
			`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PR walkthrough · ai-yappa</title><link rel="stylesheet" href="/render/walkthrough.css"><script src="/render/build/walkthrough-player.js" defer></script></head>
<body><main id="walkthrough"><p>Loading walkthrough…</p></main><script id="walkthrough-data" type="application/json">${data}</script></body></html>`,
			{ headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } },
		);
	});

	app.get('/:id/preview.png', async (c) => {
		const id = c.req.param('id');

		if (!/^[a-f0-9]{32}$/.test(id) || !c.env?.ARTIFACTS) return c.notFound();
		const object = await c.env.ARTIFACTS.get(`walkthroughs/${id}.png`);

		if (!object) return c.notFound();
		const bytes = await object.arrayBuffer();

		return new Response(bytes, { headers: { ...headers, 'Content-Type': 'image/png' } });
	});

	return app;
}
