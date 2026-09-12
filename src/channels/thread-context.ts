export type ThreadMessage = {
	user?: string;
	bot_id?: string;
	text?: string;
};

export type ThreadRepliesClient = {
	conversations: {
		replies(args: {
			channel: string;
			ts: string;
			limit: number;
		}): Promise<{ messages?: ThreadMessage[] }>;
	};
};

export const THREAD_CONTEXT_CHAR_CAP = 8_000;

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
	const result = await client.conversations.replies({
		channel: thread.channelId,
		ts: thread.threadTs,
		limit: 100,
	});
	const formatted = formatThreadContext(result.messages ?? []);
	return formatted.length > 0 ? formatted : undefined;
}
