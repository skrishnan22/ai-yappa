import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import { getSlackClient } from '../channels/slack-reply.ts';
import { answerText, renderCard, renderSummary } from '../planning/card-blocks.ts';
import { choicesSchema } from '../planning/d1-decision-log.ts';
import type { Card, CardRevision, PlanningStore } from '../planning/decision-log.ts';

// Tools whose successful call reaches the thread, so they count as the reply.
export const PLANNING_REPLY_TOOLS: ReadonlySet<string> = new Set(['ask_decision', 'end_planning']);

const wordingEntries = {
	question: v.pipe(v.string(), v.minLength(1)),
	context: v.optional(v.string()),
	recommendation: v.pipe(v.string(), v.minLength(1)),
	choices: v.optional(choicesSchema),
};

export function planningTools(args: {
	conversationId: string;
	channelId: string;
	threadTs: string;
	token?: string;
	store: PlanningStore;
	now?: () => Date;
	newId?: () => string;
}): ToolDefinition[] {
	const { conversationId, channelId, threadTs, token, store } = args;
	const now = args.now ?? (() => new Date());
	const newId = args.newId ?? (() => crypto.randomUUID());

	async function findCard(cardId: string): Promise<Card | undefined> {
		const cards = await store.log.listCards(conversationId);

		return cards.find((card) => card.latest.cardId === cardId);
	}

	return [
		defineTool({
			name: 'ask_decision',
			description: [
				'Post one decision card. People answer only with its Decide button; never treat thread replies as answers. Ask one question at a time.',
				'Give a recommendation, and 2–5 choices with unique ids when the answer is one of a few options; omit choices for an open answer.',
				'Returns the card label (D1, D2, ...) used by reword_decision.',
			].join(' '),
			input: v.object(wordingEntries),
			async run({ data }) {
				const cardId = newId();

				await store.log.ask({
					...data,
					cardId,
					conversationId,
					channelId,
					threadTs,
					createdAt: now().toISOString(),
				});

				const card = await findCard(cardId);

				if (!card) throw new Error(`Card ${cardId} was not stored`);

				if (!token) {
					return { output: { label: card.label, cardId, posted: false, ts: null } };
				}

				const { text, blocks } = renderCard(card);

				const result = await getSlackClient(token).chat.postMessage({
					channel: channelId,
					thread_ts: threadTs,
					text,
					blocks,
					unfurl_links: false,
					unfurl_media: false,
				});

				if (result.ts) await store.log.setMessageTs(cardId, result.ts);

				return { output: { label: card.label, cardId, posted: true, ts: result.ts ?? null } };
			},
		}),
		defineTool({
			name: 'reword_decision',
			description: [
				'Reword an undecided decision card by its label (e.g. D3), replacing its question, context, recommendation and choices, and update its message.',
				'A decided card cannot be reworded: ask people to press Reopen on it instead.',
			].join(' '),
			input: v.object({ card: v.pipe(v.string(), v.regex(/^D\d+$/)), ...wordingEntries }),
			async run({ data }) {
				const { card: label, ...wording } = data;
				const cards = await store.log.listCards(conversationId);
				const target = cards.find((card) => card.label === label);

				if (!target) {
					return {
						output: {
							ok: false,
							reason: `There is no decision card ${label}. Call list_decisions to see the cards.`,
						},
					};
				}

				const decided = `${label} is already decided. Ask people to press Reopen on its card if it needs to change; do not reword it.`;

				if (target.latest.decision) return { output: { ok: false, reason: decided } };

				const reworded = await store.log.reword({
					...wording,
					cardId: target.latest.cardId,
					createdAt: now().toISOString(),
				});

				// A decision or reopen landed first.
				if (!reworded) return { output: { ok: false, reason: decided } };

				const card = await findCard(reworded.cardId);

				if (card && token && reworded.messageTs) {
					const { text, blocks } = renderCard(card);

					await getSlackClient(token).chat.update({
						channel: channelId,
						ts: reworded.messageTs,
						text,
						blocks,
					});
				}

				return { output: { ok: true, label, revision: reworded.revision } };
			},
		}),
		defineTool({
			name: 'list_decisions',
			description:
				'List every decision card in this conversation with its state, answer, who decided it, and earlier answers replaced by a Reopen.',
			input: v.object({}),
			async run() {
				const cards = await store.log.listCards(conversationId);

				return { output: { decisions: cards.map(describeCard) } };
			},
		}),
		defineTool({
			name: 'end_planning',
			description:
				'End the planning session when people ask to stop or no questions remain. Posts the decision summary and returns the thread to normal replies.',
			input: v.object({}),
			async run() {
				const cards = await store.log.listCards(conversationId);
				const summary = renderSummary(cards);

				if (token) {
					await getSlackClient(token).chat.postMessage({
						channel: channelId,
						thread_ts: threadTs,
						text: summary,
						unfurl_links: false,
						unfurl_media: false,
					});
				}

				await store.sessions.end(conversationId, now().toISOString());

				return { output: { summary, posted: Boolean(token) } };
			},
		}),
	];
}

function describeCard(card: Card) {
	const { latest } = card;
	const decision = latest.decision;

	return {
		label: card.label,
		question: latest.question,
		context: latest.context ?? null,
		recommendation: latest.recommendation,
		choices: latest.choices ?? null,
		state: decision ? 'decided' : 'open',
		answer: answerText(latest) ?? null,
		reasoning: decision?.reasoning ?? null,
		decidedBy: decision?.decidedBy ?? null,
		decidedByName: decision?.decidedByName ?? null,
		decidedAt: decision?.decidedAt ?? null,
		earlier: card.history.flatMap(earlierAnswer),
	};
}

function earlierAnswer(revision: CardRevision) {
	const decision = revision.decision;

	if (!decision) return [];

	return [
		{
			answer: answerText(revision) ?? null,
			decidedBy: decision.decidedBy,
			decidedAt: decision.decidedAt,
			reasoning: decision.reasoning ?? null,
		},
	];
}
