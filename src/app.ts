import { Hono } from 'hono';
import { createSlackChannelForEnv } from './channels/slack.ts';
import { loadServerEnv } from './env.ts';

const app = new Hono();

app.post('/channels/slack/events', (c) => {
	const env = loadServerEnv(c.env ?? process.env);
	const channel = createSlackChannelForEnv(env);
	const request = new Request(new URL('/events', c.req.url), c.req.raw);
	return channel.route().fetch(request);
});

export default app;
