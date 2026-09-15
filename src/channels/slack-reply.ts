import { defineTool } from '@flue/runtime';
import { WebClient } from '@slack/web-api';
import * as v from 'valibot';

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
	ref: { channelId: string; threadTs: string },
	slackBotToken?: string,
) {
	return defineTool({
		name: 'reply_in_slack_thread',
		description:
			'Reply in the Slack thread bound to this conversation. Use standard Markdown accepted by Slack (for example **bold**) and include full exact operational identifiers; never abbreviate trace IDs, request IDs, commit hashes, or similar values with ... or ….',
		input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
		async run({ data }) {
			if (!slackBotToken) {
				return {
					output: {
						posted: false,
						text: data.text,
						channel: null,
						ts: null,
					},
				};
			}
			const result = await getSlackClient(slackBotToken).chat.postMessage({
				channel: ref.channelId,
				thread_ts: ref.threadTs,
				markdown_text: data.text,
			});
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
