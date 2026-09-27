import { Hono } from 'hono';
import { instrument } from '@flue/runtime';
import { createSlackChannelForEnv } from './channels/slack.ts';
import { loadServerEnv, type EnvSource } from './env.ts';
import { type CodexAuthBinding, codexAuth } from './integrations/codex-auth/codex-auth-binding.ts';
import { registerLangfuseExport } from './langfuse-export.ts';

// Capture full agent content for the single-user observability pilot.
if (process.env.NODE_ENV !== 'test') {
	const { createCloudflareTracing } = await import('@flue/runtime/cloudflare');
	instrument(createCloudflareTracing());
	registerLangfuseExport(process.env.LANGFUSE_MCP_BASIC_AUTH);
}

const app = new Hono<{ Bindings: EnvSource & CodexAuthBinding }>();

app.post('/channels/slack/:route{events|commands}', (c) => {
	const env = loadServerEnv(c.env ?? process.env);
	const channel = createSlackChannelForEnv(env, () => codexAuth(c.env));
	const request = new Request(new URL(`/${c.req.param('route')}`, c.req.url), c.req.raw);

	return channel.route().fetch(request);
});

export default app;
