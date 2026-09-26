import type { DeliveredMessage } from '@flue/runtime';
import * as v from 'valibot';
import type { CodexAuthStatus } from '../integrations/codex-auth/codex-auth.ts';
import { errorMessage } from '../json.ts';
import { openAICodexModelSpecifier } from './openai-codex-route.ts';
import { openCodeGoModelSpecifier } from './opencode-go-catalog.ts';

const modelRouteSchema = v.picklist(['chatgpt', 'opencode-go']);

export type ModelRoute = v.InferOutput<typeof modelRouteSchema>;

// Why a route that could have been ChatGPT fell back to OpenCode Go. A
// deployment that never connected ChatGPT has no fallback to explain.
const modelRouteFallbackSchema = v.picklist(['needs_login', 'status_failed']);

export type ModelRouteFallback = v.InferOutput<typeof modelRouteFallbackSchema>;

export type ModelRouteDecision = { route: ModelRoute; fallback?: ModelRouteFallback };

/**
 * Deployment Model Route: the ChatGPT subscription while `CodexAuth` holds a
 * usable credential, otherwise OpenCode Go. Slack ingress decides per event
 * and sends the route as the signal's `modelRoute` attribute (and the reason
 * for a fallback as `modelRouteFallback`), because the agent render is
 * synchronous and cannot ask the Durable Object.
 */
export function modelRouteFor(status: CodexAuthStatus): ModelRouteDecision {
	if (status.state === 'connected') return { route: 'chatgpt' };

	if (status.state === 'needs_login') return { route: 'opencode-go', fallback: 'needs_login' };

	return { route: 'opencode-go' };
}

/**
 * Falls back to OpenCode Go when `CodexAuth` cannot answer, so a broken
 * ChatGPT connection never blocks Slack.
 */
export async function resolveModelRoute(
	status: () => Promise<CodexAuthStatus>,
): Promise<ModelRouteDecision> {
	try {
		const currentStatus = await status();

		return modelRouteFor(currentStatus);
	} catch (error) {
		console.warn(`[slack] CodexAuth status failed; routing to OpenCode Go: ${errorMessage(error)}`);

		return { route: 'opencode-go', fallback: 'status_failed' };
	}
}

/**
 * The route a delivery carries. Flue latches `useModel` from the render that
 * sees the delivery that woke the submission, which is always a Slack signal
 * in the Worker. `flue run` messages and appended reminders carry none.
 */
export function deliveredModelRoute(delivery: DeliveredMessage): ModelRoute | undefined {
	if (delivery.kind !== 'signal') return undefined;
	const route = delivery.attributes?.modelRoute;

	return v.is(modelRouteSchema, route) ? route : undefined;
}

export function deliveredModelRouteFallback(
	delivery: DeliveredMessage,
): ModelRouteFallback | undefined {
	if (delivery.kind !== 'signal') return undefined;
	const fallback = delivery.attributes?.modelRouteFallback;

	return v.is(modelRouteFallbackSchema, fallback) ? fallback : undefined;
}

/** Short Live Run Card note for a fallback. */
export function modelRouteFallbackNote(fallback: ModelRouteFallback): string {
	switch (fallback) {
		case 'needs_login':
			return 'ChatGPT needs a new login';
		case 'status_failed':
			return 'ChatGPT unavailable';
		default: {
			const _exhaustive: never = fallback;

			return _exhaustive;
		}
	}
}

/** Model specifier passed to `useModel`; no route means OpenCode Go. */
export function coworkerModelSpecifier(route: ModelRoute | undefined): string {
	return route === 'chatgpt' ? openAICodexModelSpecifier : openCodeGoModelSpecifier;
}

/**
 * Reasoning effort for Coworker. Flue defaults to `medium` when omitted;
 * keep this explicit so Slack display and the harness stay aligned.
 */
export const coworkerThinkingLevel = 'medium' as const;

export type CoworkerThinkingLevel = typeof coworkerThinkingLevel;
