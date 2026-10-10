import { defineTool } from '@flue/runtime';
import { WebClient } from '@slack/web-api';
import * as v from 'valibot';
import { jsonObjectSchema } from '../json.ts';
import { replyBlocksSchema } from './slack-blocks.ts';
import { ensureParagraphBreaks } from './slack-text.ts';

export function slackFetch(url: string | URL, init?: RequestInit): Promise<Response> {
	return fetch(url, init?.redirect === 'error' ? { ...init, redirect: 'manual' } : init);
}

export type SlackBotClient = {
	chat: {
		postMessage: WebClient['chat']['postMessage'];
		update: WebClient['chat']['update'];
	};
	conversations: {
		replies: WebClient['conversations']['replies'];
	};
};

// Lazily constructed: importing this module (e.g. from `flue run`, which has
// no Slack token) must not build a client with an `undefined` token. The
// caller supplies the value validated at its execution boundary.
let cachedForToken: string | undefined;

let cached: SlackBotClient | undefined;

export function getSlackClient(token: string): SlackBotClient {
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
		description: [
			'Reply in the Slack thread bound to this conversation.',
			'By default `text` is the whole reply, written in Markdown.',
			'Add `blocks` (native Slack Block Kit) only when a chart, table, or composed layout helps the reader; then `text` is the notification and screen-reader fallback and must state the substantive takeaway, including a verbal summary of any chart.',
			'Allowed blocks: markdown, header, divider, text-only section and context, data_visualization, and data_table. Cells may be raw_text, raw_number, a string, or a number. Header text may be plain_text or a string. Images, accessories, and interactive elements are rejected.',
			'Compute chart and table values from the repo or tools; never estimate them.',
			'Include full exact operational identifiers; never abbreviate trace IDs, request IDs, commit hashes, or similar values with ... or ….',
			'A text-only reply with no line breaks is automatically split into paragraphs at sentence boundaries before posting.',
		].join(' '),
		input: v.object({
			text: v.pipe(v.string(), v.minLength(1)),
			blocks: v.optional(replyBlocksSchema),
		}),
		async run({ data }) {
			// Slack mrkdwn only breaks lines where the payload has newlines;
			// enforce paragraph breaks so the layout never depends on the
			// model's formatting.
			const text = ensureParagraphBreaks(data.text);

			if (!slackBotToken) {
				return {
					output: {
						posted: false,
						text,
						blocks: data.blocks ? v.parse(v.array(jsonObjectSchema), data.blocks) : null,
						channel: null,
						ts: null,
					},
				};
			}

			const result = await getSlackClient(slackBotToken).chat.postMessage({
				channel: ref.channelId,
				thread_ts: ref.threadTs,
				...(data.blocks ? { text, blocks: data.blocks } : { markdown_text: text }),
				unfurl_links: false,
				unfurl_media: false,
			});

			return {
				output: {
					posted: true,
					text,
					blocks: null,
					channel: result.channel ?? null,
					ts: result.ts ?? null,
				},
			};
		},
	});
}
