import type { DeliveredMessage } from '@flue/runtime';
import * as v from 'valibot';
import type { CodexAuthStatus } from '../integrations/codex-auth/codex-auth.ts';
import { openAICodexModelSpecifier } from './openai-codex-route.ts';
import { openCodeGoModelSpecifier } from './opencode-go-catalog.ts';

const modelRouteSchema = v.picklist(['chatgpt', 'opencode-go']);

export type ModelRoute = v.InferOutput<typeof modelRouteSchema>;

/**
 * Deployment Model Route: the ChatGPT subscription while `CodexAuth` holds a
 * credential, otherwise OpenCode Go. Slack ingress decides per event and sends
 * the route as the signal's `modelRoute` attribute, because the agent render
 * is synchronous and cannot ask the Durable Object.
 */
export function modelRouteFor(status: CodexAuthStatus): ModelRoute {
	return status.state === 'connected' ? 'chatgpt' : 'opencode-go';
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
