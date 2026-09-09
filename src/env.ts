// Single source of truth for required secrets.
//
// `process.env` works on every runtime we run because `wrangler.jsonc` sets
// `nodejs_compat` with a compatibility_date >= 2025-04-01, so workerd mirrors
// vars/secrets into `process.env` (nodejs_compat_populate_process_env).
// Flue's providers rely on the same mechanism for API-key lookup.
//
// Two entrypoints, two requirements:
//   - serve (vite dev / deployed Worker via src/app.ts): everything required.
//   - agent-only (`flue run src/agents/coworker.ts`): Slack is optional — the
//     reply tool degrades to `posted: false` without SLACK_BOT_TOKEN.
//
// Callers validate at their execution boundary and fail with the full missing
// list, instead of crashing mid-conversation on the first secret read.
import * as v from 'valibot';

const nonEmpty = v.pipe(v.string(), v.minLength(1));

const serverSchema = v.object({
	SLACK_SIGNING_SECRET: nonEmpty,
	SLACK_BOT_TOKEN: nonEmpty,
	DAYTONA_API_KEY: nonEmpty,
	OPENCODE_API_KEY: nonEmpty,
	TUNNEL_HOSTNAME: v.optional(v.string()),
});

const agentSchema = v.object({
	DAYTONA_API_KEY: nonEmpty,
	OPENCODE_API_KEY: nonEmpty,
	SLACK_SIGNING_SECRET: v.optional(v.string()),
	SLACK_BOT_TOKEN: v.optional(v.string()),
	TUNNEL_HOSTNAME: v.optional(v.string()),
	GIT_AUTHOR_NAME: v.optional(v.string()),
	GIT_AUTHOR_EMAIL: v.optional(v.string()),
});

export type ServerEnv = v.InferOutput<typeof serverSchema>;
export type AgentEnv = v.InferOutput<typeof agentSchema>;

function missingKeys(
	result:
		| v.SafeParseResult<typeof serverSchema>
		| v.SafeParseResult<typeof agentSchema>,
): string[] {
	if (result.success) return [];
	const keys = new Set<string>();
	for (const issue of result.issues) {
		const first = issue.path?.[0]?.key;
		if (typeof first === 'string') keys.add(first);
	}
	return [...keys].sort();
}

export function loadServerEnv(
	source: unknown = process.env,
): ServerEnv {
	const result = v.safeParse(serverSchema, source);
	if (!result.success) {
		throw new Error(`[boot] missing secrets: ${missingKeys(result).join(', ') || 'invalid env'}`);
	}
	return result.output;
}

export function loadAgentEnv(
	source: unknown = process.env,
): AgentEnv {
	const result = v.safeParse(agentSchema, source);
	if (!result.success) {
		throw new Error(`[boot] missing secrets: ${missingKeys(result).join(', ') || 'invalid env'}`);
	}
	return result.output;
}

export function gitAuthorFromEnv(
	env: Pick<AgentEnv, 'GIT_AUTHOR_NAME' | 'GIT_AUTHOR_EMAIL'>,
): { name: string; email: string } | undefined {
	const name = env.GIT_AUTHOR_NAME?.trim();
	const email = env.GIT_AUTHOR_EMAIL?.trim();
	if (name && email) return { name, email };
	if (name || email) {
		throw new Error('[boot] GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL must both be set, or neither');
	}
	return undefined;
}
