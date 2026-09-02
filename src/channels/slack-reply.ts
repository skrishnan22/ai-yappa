import { defineTool } from '@flue/runtime';
import { WebClient } from '@slack/web-api';
import * as v from 'valibot';

function slackFetch(url: string | URL, init?: RequestInit): Promise<Response> {
	return fetch(url, init?.redirect === 'error' ? { ...init, redirect: 'manual' } : init);
}

export const client = new WebClient(process.env.SLACK_BOT_TOKEN, {
	// workerd's fetch is a method. WebClient stores globalThis.fetch and calls it
	// unbound, which throws Illegal invocation. It also sets redirect: 'error',
	// which workerd does not implement.
	fetch: slackFetch,
});

export function replyInThread(ref: { channelId: string; threadTs: string }) {
	return defineTool({
		name: 'reply_in_slack_thread',
		description: 'Reply in the Slack thread bound to this conversation.',
		input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
		async run({ data }) {
			if (!process.env.SLACK_BOT_TOKEN) {
				return {
					output: {
						posted: false,
						text: data.text,
						channel: null,
						ts: null,
					},
				};
			}
			const result = await client.chat.postMessage({
				channel: ref.channelId,
				thread_ts: ref.threadTs,
				text: data.text,
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
