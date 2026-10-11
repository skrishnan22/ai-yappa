import type { SlackBotClient } from '../channels/slack-reply.ts';
import { renderCard } from './card-blocks.ts';
import type { Card, CardRevision, DecisionLog } from './decision-log.ts';

const REDRAW_ATTEMPTS = 3;

// Slack updates can arrive out of order; check the saved state after each update.
export async function redrawCard(
	revision: Pick<CardRevision, 'cardId' | 'conversationId'>,
	deps: { log: DecisionLog; slack: SlackBotClient },
): Promise<Card | undefined> {
	let card: Card | undefined;

	for (let attempt = 0; attempt < REDRAW_ATTEMPTS; attempt++) {
		const cards = await deps.log.listCards(revision.conversationId);
		card = cards.find((candidate) => candidate.latest.cardId === revision.cardId);
		const messageTs = card?.latest.messageTs;

		if (!card || !messageTs) return card;

		const { text, blocks } = renderCard(card);
		await deps.slack.chat.update({ channel: card.latest.channelId, ts: messageTs, text, blocks });

		const current = await deps.log.latest(revision.cardId);

		if (!current || sameState(current, card.latest)) return card;
	}

	return card;
}

function sameState(a: CardRevision, b: CardRevision): boolean {
	return a.revision === b.revision && Boolean(a.decision) === Boolean(b.decision);
}
