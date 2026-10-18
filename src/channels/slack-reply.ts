import { defineTool } from '@flue/runtime';
import { WebClient } from '@slack/web-api';
import * as v from 'valibot';
import { jsonObjectSchema } from '../json.ts';
import type { StoredArtifact } from '../visuals/artifact-store.ts';
import { replyBlocksSchema } from './slack-blocks.ts';
import { type ThreadImage, uploadThreadImages } from './slack-upload.ts';

export function slackFetch(url: string | URL, init?: RequestInit): Promise<Response> {
	return fetch(url, init?.redirect === 'error' ? { ...init, redirect: 'manual' } : init);
}

export type SlackBotClient = {
	auth: { test: WebClient['auth']['test'] };
	chat: {
		postMessage: WebClient['chat']['postMessage'];
		update: WebClient['chat']['update'];
		postEphemeral: WebClient['chat']['postEphemeral'];
	};
	views: {
		open: WebClient['views']['open'];
	};
	conversations: {
		replies: WebClient['conversations']['replies'];
		open: WebClient['conversations']['open'];
	};
	users: { info: WebClient['users']['info'] };
	files: {
		getUploadURLExternal: WebClient['files']['getUploadURLExternal'];
		completeUploadExternal: WebClient['files']['completeUploadExternal'];
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

export const MAX_REPLY_IMAGES = 5;

export const MAX_ALT_TEXT_LENGTH = 1000;

const imagesSchema = v.pipe(
	v.array(
		v.object({
			artifactId: v.pipe(v.string(), v.minLength(1)),
			altText: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_ALT_TEXT_LENGTH)),
		}),
	),
	v.minLength(1),
	v.maxLength(MAX_REPLY_IMAGES),
);

/** Looks up one of this conversation's rendered artifacts. */
export type FindArtifact = (artifactId: string) => Promise<StoredArtifact | undefined>;

export function replyInThread(
	ref: { channelId: string; threadTs: string },
	slackBotToken?: string,
	findArtifact?: FindArtifact,
) {
	return defineTool({
		name: 'reply_in_slack_thread',
		description: [
			'Reply in the Slack thread bound to this conversation.',
			'By default `text` is the whole reply, written in Markdown.',
			'Add `blocks` (native Slack Block Kit) only when a chart, table, or composed layout helps the reader; then `text` is the notification and screen-reader fallback and must state the substantive takeaway, including a verbal summary of any chart.',
			'Allowed blocks: markdown, header, divider, text-only section and context, data_visualization, and data_table. Cells may be raw_text, raw_number, a string, or a number. Header text may be plain_text or a string. Images, accessories, and interactive elements are rejected.',
			`Add \`images\` (at most ${MAX_REPLY_IMAGES}) to attach visuals you rendered with render_visual or captured with browse_page: each is { artifactId, altText }. They are uploaded under the message; \`text\` must still carry the takeaway, and altText (at most ${MAX_ALT_TEXT_LENGTH} characters) describes the image for screen readers.`,
			'Compute chart and table values from the repo or tools; never estimate them.',
			'Include full exact operational identifiers; never abbreviate trace IDs, request IDs, commit hashes, or similar values with ... or ….',
		].join(' '),
		input: v.object({
			text: v.pipe(v.string(), v.minLength(1)),
			blocks: v.optional(replyBlocksSchema),
			images: v.optional(imagesSchema),
		}),
		async run({ data }) {
			// Resolve every image before posting, so a bad id posts nothing.
			let images: ThreadImage[] = [];

			if (data.images) images = await threadImages(data.images, findArtifact);

			if (!slackBotToken) {
				return {
					output: {
						posted: false,
						text: data.text,
						blocks: data.blocks ? v.parse(v.array(jsonObjectSchema), data.blocks) : null,
						channel: null,
						ts: null,
						images: images.length > 0 ? { posted: false, fileIds: [], error: null } : null,
					},
				};
			}

			const client = getSlackClient(slackBotToken);

			const result = await client.chat.postMessage({
				channel: ref.channelId,
				thread_ts: ref.threadTs,
				...(data.blocks ? { text: data.text, blocks: data.blocks } : { markdown_text: data.text }),
				unfurl_links: false,
				unfurl_media: false,
			});

			let posted: ImagePosting | null = null;

			if (images.length > 0) posted = await postImages({ client, ref, images });

			return {
				output: {
					posted: true,
					text: data.text,
					blocks: null,
					channel: result.channel ?? null,
					ts: result.ts ?? null,
					images: posted,
				},
			};
		},
	});
}

async function threadImages(
	requested: v.InferOutput<typeof imagesSchema>,
	findArtifact: FindArtifact | undefined,
): Promise<ThreadImage[]> {
	if (!findArtifact) {
		throw new Error('Images are not available in this deployment. Reply with text or blocks.');
	}

	const images = await Promise.all(
		requested.map(async ({ artifactId, altText }) => {
			const artifact = await findArtifact(artifactId);

			if (!artifact) {
				throw new Error(
					`Artifact ${artifactId} is unknown or expired. Render it again with render_visual, then reply with the new artifactId. Nothing was posted.`,
				);
			}

			return {
				filename: `${artifactId}.png`,
				title: artifact.title,
				altText,
				png: artifact.png,
			};
		}),
	);

	return images;
}

type ImagePosting = { posted: boolean; fileIds: string[]; error: string | null };

/**
 * The message already stands, so an upload failure (uploads disabled, the bot
 * not in the channel, an external guest) is reported, not thrown: throwing
 * would make the model post the message again.
 */
async function postImages({
	client,
	ref,
	images,
}: {
	client: SlackBotClient;
	ref: { channelId: string; threadTs: string };
	images: ThreadImage[];
}): Promise<ImagePosting> {
	try {
		const uploaded = await uploadThreadImages({
			client,
			channelId: ref.channelId,
			threadTs: ref.threadTs,
			images,
		});

		return { posted: true, fileIds: uploaded.fileIds, error: null };
	} catch (error) {
		return {
			posted: false,
			fileIds: [],
			error: `The message was posted, but the images were not: ${error instanceof Error ? error.message : String(error)}. Do not post the message again.`,
		};
	}
}
