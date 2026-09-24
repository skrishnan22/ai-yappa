import { defineTool } from '@flue/runtime';
import { WebClient } from '@slack/web-api';
import * as v from 'valibot';
import { errorMessage, jsonObjectSchema } from '../json.ts';
import { replyBlocksSchema } from './slack-blocks.ts';

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

export type SlackClientFactory = (token: string) => SlackBotClient;

function defaultSlackClient(token: string): SlackBotClient {
	return new WebClient(token, {
		// workerd's fetch is a method. WebClient stores globalThis.fetch and calls it
		// unbound, which throws Illegal invocation. It also sets redirect: 'error',
		// which workerd does not implement.
		fetch: slackFetch,
	});
}

let createSlackClient: SlackClientFactory = defaultSlackClient;

// Lazily constructed: importing this module (e.g. from `flue run`, which has
// no Slack token) must not build a client with an `undefined` token. The
// caller supplies the value validated at its execution boundary.
let cachedForToken: string | undefined;

let cached: SlackBotClient | undefined;

export function getSlackClient(token: string): SlackBotClient {
	if (!cached || cachedForToken !== token) {
		cached = createSlackClient(token);
		cachedForToken = token;
	}

	return cached;
}

/** Test-only: drop the cached client so token stubs take effect. */
export function __resetSlackClientForTests(): void {
	cached = undefined;
	cachedForToken = undefined;
}

/** Test-only: replace the Slack client constructor. */
export function __setSlackClientFactoryForTests(factory?: SlackClientFactory): void {
	createSlackClient = factory ?? defaultSlackClient;
	__resetSlackClientForTests();
}

const SLACK_ERROR_LIMIT = 500;

const slackPlatformErrorSchema = v.looseObject({
	data: v.looseObject({
		error: v.pipe(v.string(), v.minLength(1)),
	}),
});

function slackErrorCode(cause: unknown): string {
	const message = v.is(slackPlatformErrorSchema, cause) ? cause.data.error : errorMessage(cause);

	return message.slice(0, SLACK_ERROR_LIMIT);
}

function logReplyPost(fields: Record<string, string | number | boolean>): void {
	try {
		const line = JSON.stringify({
			event: 'slack.reply_post',
			service: 'slack-agent',
			timestamp: new Date().toISOString(),
			...fields,
		});

		if ('error' in fields) console.warn(line);
		else console.log(line);
	} catch {
		// A log failure must not turn a delivered reply into a failed tool call the model retries.
	}
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
		].join(' '),
		input: v.object({
			text: v.pipe(v.string(), v.minLength(1)),
			blocks: v.optional(replyBlocksSchema),
		}),
		async run({ data, toolCallId }) {
			if (!slackBotToken) {
				return {
					output: {
						posted: false,
						text: data.text,
						blocks: data.blocks ? v.parse(v.array(jsonObjectSchema), data.blocks) : null,
						channel: null,
						ts: null,
					},
				};
			}

			const payload = {
				channel: ref.channelId,
				thread_ts: ref.threadTs,
				...(data.blocks ? { text: data.text, blocks: data.blocks } : { markdown_text: data.text }),
				unfurl_links: false,
				unfurl_media: false,
			};

			const startedAt = Date.now();

			const postLog = {
				toolCallId,
				channel: ref.channelId,
				blocks: data.blocks !== undefined,
				blockCount: data.blocks?.length ?? 0,
				payloadBytes: new TextEncoder().encode(JSON.stringify(payload)).length,
			};

			let result: Awaited<ReturnType<SlackBotClient['chat']['postMessage']>>;

			try {
				result = await getSlackClient(slackBotToken).chat.postMessage(payload);
			} catch (cause) {
				logReplyPost({
					...postLog,
					durationMs: Date.now() - startedAt,
					ok: false,
					error: slackErrorCode(cause),
				});
				throw cause;
			}

			logReplyPost({ ...postLog, durationMs: Date.now() - startedAt, ok: true });

			return {
				output: {
					posted: true,
					text: data.text,
					blocks: null,
					channel: result.channel ?? null,
					ts: result.ts ?? null,
				},
			};
		},
	});
}
