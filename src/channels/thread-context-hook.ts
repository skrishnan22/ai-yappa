import { useAgentStart, useDelivery } from '@flue/runtime';
import { getSlackClient } from './slack-reply.ts';
import { loadThreadContext } from './thread-context.ts';

type SlackConversation = {
	channelId: string;
	threadTs: string;
};

export function useSlackThreadContext(data: SlackConversation, token?: string): void {
	const delivery = useDelivery();
	useAgentStart(async ({ append, log }) => {
		if (delivery.kind !== 'signal' || !delivery.type.startsWith('slack.')) return;
		if (token === undefined) return;
		try {
			const threadContext = await loadThreadContext(getSlackClient(token), data);
			if (threadContext === undefined) return;
			append({
				kind: 'signal',
				type: 'slack.thread_context',
				body: threadContext,
				attributes:
					delivery.attributes?.eventId === undefined
						? {}
						: { eventId: delivery.attributes.eventId },
			});
		} catch {
			log.warn('Slack thread context unavailable.');
		}
	});
}
