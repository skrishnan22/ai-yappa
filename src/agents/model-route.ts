import type { DeliveredMessage } from '@flue/runtime';
import * as v from 'valibot';
import type { CodexAuthStatus } from '../integrations/codex-auth/codex-auth.ts';

const modelRouteSchema = v.picklist(['chatgpt', 'opencode-go']);

export type ModelRoute = v.InferOutput<typeof modelRouteSchema>;

/**
 * Whether the ChatGPT subscription is usable for this event: `chatgpt` while
 * `CodexAuth` holds a credential, otherwise `opencode-go`. Slack ingress
 * decides per event and sends it as the signal's `modelRoute` attribute,
 * because the agent render is synchronous and cannot ask the Durable Object.
 * `coworkerModel` combines it with the thread's Model Choice.
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
