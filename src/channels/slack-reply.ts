import { defineTool } from '@flue/runtime';
import { WebClient } from '@slack/web-api';
import * as v from 'valibot';
import { classifyTelemetryError, emitTelemetry } from '../observability.ts';

export type SlackDeliveryContext = {
	conversationId: string;
	deliveryKind:
		| 'refusal'
		| 'missing_repo'
		| 'agent_reply'
		| 'run_card_post'
		| 'run_card_update'
		| 'terminal_notification';
	method: 'chat.postMessage' | 'chat.update';
	slackEventId?: string;
	submissionId?: string;
	toolCallId?: string;
};

function slackFetch(url: string | URL, init?: RequestInit): Promise<Response> {
	return fetch(url, init?.redirect === 'error' ? { ...init, redirect: 'manual' } : init);
}

// Lazily constructed: importing this module (e.g. from `flue run`, which has
// no Slack token) must not build a client with an `undefined` token. The
// caller supplies the value validated at its execution boundary.
let cachedForToken: string | undefined;
let cached: WebClient | undefined;

export function getSlackClient(token: string): WebClient {
	if (!cached || cachedForToken !== token) {
		cached = new WebClient(token, {
			// workerd's fetch is a method. WebClient stores globalThis.fetch and calls it
			// unbound, which throws Illegal invocation. It also sets redirect: 'error',
			// which workerd does not implement.
			fetch: slackFetch,
		});
		cachedForToken = token;
	}
	return cached;
}

/** Test-only: drop the cached client so token stubs take effect. */
export function __resetSlackClientForTests(): void {
	cached = undefined;
	cachedForToken = undefined;
}

export function replyInThread(
	ref: { channelId: string; threadTs: string; conversationId: string },
	slackBotToken?: string,
) {
	return defineTool({
		name: 'reply_in_slack_thread',
		description: 'Reply in the Slack thread bound to this conversation.',
		input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
		async run({ data, toolCallId }) {
			const delivery = {
				conversationId: ref.conversationId,
				deliveryKind: 'agent_reply',
				method: 'chat.postMessage',
				toolCallId,
			} satisfies SlackDeliveryContext;
			if (!slackBotToken) {
				emitTelemetry({
					event_name: 'slack.delivery',
					outcome: 'skipped',
					conversation_id: delivery.conversationId,
					tool_call_id: delivery.toolCallId,
					delivery_kind: delivery.deliveryKind,
					slack_method: delivery.method,
					posted: false,
					duration_ms: 0,
				});
				return {
					output: {
						posted: false,
						text: data.text,
						channel: null,
						ts: null,
					},
				};
			}
			const result = await observeSlackDelivery(delivery, () =>
				getSlackClient(slackBotToken).chat.postMessage({
					channel: ref.channelId,
					thread_ts: ref.threadTs,
					text: data.text,
				}),
			);
			return {
				output: {
					posted: true,
					text: data.text,
					channel: result.channel ?? null,
					ts: result.ts ?? null,
				},
			};
		},
	});
}

export async function observeSlackDelivery<T>(
	context: SlackDeliveryContext,
	deliver: () => Promise<T>,
): Promise<T> {
	const started = Date.now();
	try {
		const result = await deliver();
		emitTelemetry({
			event_name: 'slack.delivery',
			outcome: 'ok',
			conversation_id: context.conversationId,
			slack_event_id: context.slackEventId,
			submission_id: context.submissionId,
			tool_call_id: context.toolCallId,
			delivery_kind: context.deliveryKind,
			slack_method: context.method,
			posted: true,
			duration_ms: Math.max(0, Date.now() - started),
		});
		return result;
	} catch (error) {
		emitTelemetry({
			event_name: 'slack.delivery',
			outcome: 'failed',
			conversation_id: context.conversationId,
			slack_event_id: context.slackEventId,
			submission_id: context.submissionId,
			tool_call_id: context.toolCallId,
			delivery_kind: context.deliveryKind,
			slack_method: context.method,
			posted: false,
			duration_ms: Math.max(0, Date.now() - started),
			...classifyTelemetryError(error),
		});
		throw error;
	}
}
