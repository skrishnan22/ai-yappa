import { Hono } from 'hono';
import { instrument } from '@flue/runtime';
import { createSlackChannelForEnv } from './channels/slack.ts';
import { loadServerEnv } from './env.ts';

// Capture full agent content for the single-user observability pilot.
if (process.env.NODE_ENV !== 'test') {
	const { createCloudflareTracing } = await import('@flue/runtime/cloudflare');
	instrument(createCloudflareTracing());
}

const app = new Hono();

app.post('/channels/slack/events', (c) => {
	const env = loadServerEnv(c.env ?? process.env);
	const channel = createSlackChannelForEnv(env);
	const request = new Request(new URL('/events', c.req.url), c.req.raw);

	return channel.route().fetch(request);
});

export default app;
