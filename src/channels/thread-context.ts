export type ThreadMessage = {
	user?: string;
	bot_id?: string;
	text?: string;
};

export type ThreadRepliesClient = {
	conversations: {
		replies(args: { channel: string; ts: string; limit: number; cursor?: string }): Promise<{
			messages?: ThreadMessage[];
			response_metadata?: { next_cursor?: string };
		}>;
	};
};

export const THREAD_CONTEXT_CHAR_CAP = 8_000;

export const THREAD_CONTEXT_PAGE_SIZE = 100;

// ponytail: Slack replies are oldest-first; we must walk to the last page for the 8 KiB tail. 20 pages = 2000 msgs. Hitting the cap still drops newer replies — upgrade: reverse-paginate if Slack exposes it.
export const THREAD_CONTEXT_MAX_PAGES = 20;

export function formatThreadContext(
	messages: ThreadMessage[],
	cap = THREAD_CONTEXT_CHAR_CAP,
): string {
	const lines: string[] = [];

	for (const message of messages) {
		if (message.bot_id !== undefined) continue;
		const text = message.text?.trim();

		if (!text) continue;
		const who = message.user !== undefined ? `<@${message.user}>` : 'unknown';
		lines.push(`${who}: ${text}`);
	}

	let out = lines.join('\n');

	if (out.length > cap) out = out.slice(out.length - cap);

	return out;
}

export async function loadThreadContext(
	client: ThreadRepliesClient,
	thread: { channelId: string; threadTs: string },
): Promise<string | undefined> {
	const messages: ThreadMessage[] = [];
	let cursor: string | undefined;

	for (let page = 0; page < THREAD_CONTEXT_MAX_PAGES; page++) {
		const request =
			cursor === undefined
				? {
						channel: thread.channelId,
						ts: thread.threadTs,
						limit: THREAD_CONTEXT_PAGE_SIZE,
					}
				: {
						channel: thread.channelId,
						ts: thread.threadTs,
						limit: THREAD_CONTEXT_PAGE_SIZE,
						cursor,
					};

		const result = await client.conversations.replies(request);

		messages.push(...(result.messages ?? []));
		const next = result.response_metadata?.next_cursor;

		if (!next) break;
		cursor = next;
	}

	const formatted = formatThreadContext(messages);

	return formatted.length > 0 ? formatted : undefined;
}
