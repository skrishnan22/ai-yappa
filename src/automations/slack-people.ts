import type { SlackBotClient } from '../channels/slack-reply.ts';

// The bot's DM with a user (needs `im:write`).
export async function openDirectMessage({
	slack,
	userId,
}: {
	slack: SlackBotClient;
	userId: string;
}): Promise<string> {
	const opened = await slack.conversations.open({ users: userId });
	const id = opened.channel?.id;

	if (!id) throw new Error(`Slack opened no DM with ${userId}.`);

	return id;
}
