import type { DeliveredMessage } from '@flue/runtime';
import * as v from 'valibot';
import type { CodexAuthStatus } from '../integrations/codex-auth/codex-auth.ts';

const modelRouteSchema = v.picklist(['chatgpt', 'opencode-go']);

const SLACK_USER_ENVELOPE_PREFIX = '<yappa-slack-delivery>';

const SLACK_USER_ENVELOPE_SUFFIX = '</yappa-slack-delivery>';

const slackUserEnvelopeSchema = v.object({
	modelRoute: modelRouteSchema,
	userId: v.optional(v.string()),
	threadContext: v.optional(v.string()),
});

type SlackUserEnvelope = v.InferOutput<typeof slackUserEnvelopeSchema>;

export type ModelRoute = v.InferOutput<typeof modelRouteSchema>;

/**
 * Whether the ChatGPT subscription is usable for this event: `chatgpt` while
 * `CodexAuth` holds a credential, otherwise `opencode-go`. Slack ingress
 * decides per event and sends it as the signal's `modelRoute` attribute, or
 * in the trusted envelope used for an image-bearing user delivery.
 */
export function modelRouteFor(status: CodexAuthStatus): ModelRoute {
	return status.state === 'connected' ? 'chatgpt' : 'opencode-go';
}

export function slackUserDeliveryBody(
	body: string,
	{ modelRoute, userId, threadContext }: SlackUserEnvelope,
): string {
	const envelope: SlackUserEnvelope = { modelRoute };

	if (userId) envelope.userId = userId;

	if (threadContext) envelope.threadContext = threadContext;

	return `${SLACK_USER_ENVELOPE_PREFIX}${JSON.stringify(envelope)}${SLACK_USER_ENVELOPE_SUFFIX}\n${body}`;
}

export function parseSlackUserDeliveryBody(
	body: string,
): { body: string; envelope: SlackUserEnvelope } | undefined {
	if (!body.startsWith(SLACK_USER_ENVELOPE_PREFIX)) return undefined;

	const end = body.indexOf(SLACK_USER_ENVELOPE_SUFFIX, SLACK_USER_ENVELOPE_PREFIX.length);

	if (end < 0) return undefined;

	const encoded = body.slice(SLACK_USER_ENVELOPE_PREFIX.length, end);
	let parsed: unknown;

	try {
		parsed = JSON.parse(encoded);
	} catch {
		return undefined;
	}

	if (!v.is(slackUserEnvelopeSchema, parsed)) return undefined;

	const separator = end + SLACK_USER_ENVELOPE_SUFFIX.length;
	const content = body.slice(separator).replace(/^\n/, '');

	return { body: content, envelope: parsed };
}

/**
 * The route a delivery carries. Flue latches `useModel` from the render that
 * sees the delivery that woke the submission. Text Slack events carry the
 * route as signal metadata; image-bearing Slack user deliveries carry it in
 * the handler-authored envelope because user messages have no attributes.
 */
export function deliveredModelRoute(delivery: DeliveredMessage): ModelRoute | undefined {
	if (delivery.kind === 'signal') {
		const route = delivery.attributes?.modelRoute;

		return v.is(modelRouteSchema, route) ? route : undefined;
	}

	return parseSlackUserDeliveryBody(delivery.body)?.envelope.modelRoute;
}
