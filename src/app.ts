import { type Context, type ExecutionContext, Hono } from 'hono';
import { instrument } from '@flue/runtime';
import { createSlackChannelForEnv } from './channels/slack.ts';
import { loadServerEnv, type EnvSource } from './env.ts';
import { type CodexAuthBinding, codexAuth } from './integrations/codex-auth/codex-auth-binding.ts';
import { registerLangfuseExport } from './langfuse-export.ts';
import type { D1Database } from './memory/d1.ts';
import { createD1PlanningStore } from './planning/d1-decision-log.ts';

// Capture full agent content for the single-user observability pilot.
if (process.env.NODE_ENV !== 'test') {
	const { createCloudflareTracing } = await import('@flue/runtime/cloudflare');
	instrument(createCloudflareTracing());
	registerLangfuseExport(process.env.LANGFUSE_MCP_BASIC_AUTH);
}

const app = new Hono<{ Bindings: EnvSource & CodexAuthBinding & { APP_DB?: D1Database } }>();

app.post('/channels/slack/:route{events|commands|interactions}', (c) => {
	const env = loadServerEnv(c.env ?? process.env);
	const planning = c.env?.APP_DB ? createD1PlanningStore(c.env.APP_DB) : undefined;
	const channel = createSlackChannelForEnv(env, () => codexAuth(c.env), undefined, planning);
	const request = new Request(new URL(`/${c.req.param('route')}`, c.req.url), c.req.raw);

	// Forward the execution context so the channel can `waitUntil` work after it responds.
	return channel.route().fetch(request, c.env, executionContextOf(c));
});

// Hono throws when there is no execution context (Node, Vitest).
function executionContextOf(c: Context): ExecutionContext | undefined {
	try {
		return c.executionCtx;
	} catch {
		return undefined;
	}
}

export default app;
