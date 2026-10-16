import type { KnownBlock, ModalView } from '@slack/web-api';
import * as v from 'valibot';
import {
	actions,
	blocks,
	button,
	clip,
	context,
	escapeMrkdwn,
	input,
	plain,
	section,
} from '../channels/block-kit.ts';
import type { Card, CardRevision } from './decision-log.ts';

export const DECIDE_ACTION = 'planning_decide';

export const REOPEN_ACTION = 'planning_reopen';

export const DECIDE_CALLBACK = 'planning_decide_modal';

const OPTION_TEXT_MAX = 75;

// One summary message; Slack truncates message text past 40,000 characters.
const SUMMARY_MESSAGE_MAX = 3500;

// Buttons carry what they showed: Reopen names its revision, so a stale button
// cannot reopen a later decision; Decide carries the label for the modal title.
const shownRevisionSchema = v.pipe(
	v.string(),
	v.parseJson(),
	v.object({ cardId: v.string(), revision: v.number() }),
);

const decideValueSchema = v.pipe(
	v.string(),
	v.parseJson(),
	v.object({ cardId: v.string(), label: v.string() }),
);

export function parseReopenValue(value: string): { cardId: string; revision: number } | undefined {
	return parsed(shownRevisionSchema, value);
}

export function parseDecideValue(value: string): { cardId: string; label: string } | undefined {
	return parsed(decideValueSchema, value);
}

// Choice label, or the custom answer, of a decided revision.
export function answerText(revision: CardRevision): string | undefined {
	const decision = revision.decision;

	if (!decision) return undefined;

	if (decision.customAnswer) return decision.customAnswer;

	return revision.choices?.find((choice) => choice.id === decision.choiceId)?.label;
}

export type CardRender = { text: string; blocks: KnownBlock[] };

export function renderCard(card: Card): CardRender {
	const { label, latest } = card;
	const text = fallbackText(card);

	const previous = previousAnswer(card);
	const choices = latest.choices ?? [];
	const decision = latest.decision;

	return {
		text,
		blocks: blocks(
			section(`*${label}* ${escapeMrkdwn(latest.question)}`),
			previous &&
				context(`Previously: ${escapeMrkdwn(previous.answer)} — <@${previous.decidedBy}>`),
			latest.context && context(escapeMrkdwn(latest.context)),
			choices.length > 0 &&
				section(
					choices
						.map((choice, index) => `${choiceLetter(index)}) ${escapeMrkdwn(choice.label)}`)
						.join('\n'),
				),
			section(`*Recommended:* ${escapeMrkdwn(latest.recommendation)}`),
			decision &&
				section(
					[
						`✅ *${escapeMrkdwn(answerText(latest) ?? '')}*`,
						decision.reasoning && escapeMrkdwn(decision.reasoning),
						`Decided by <@${decision.decidedBy}> ${slackDate(decision.decidedAt)}`,
					]
						.filter(Boolean)
						.join('\n'),
				),
			decision
				? actions(
						button({
							actionId: REOPEN_ACTION,
							text: 'Reopen',
							value: JSON.stringify({ cardId: latest.cardId, revision: latest.revision }),
						}),
					)
				: actions(
						button({
							actionId: DECIDE_ACTION,
							text: 'Decide…',
							value: JSON.stringify({ cardId: latest.cardId, label }),
							style: 'primary',
						}),
					),
		),
	};
}

export function decideModal({ latest, label }: Pick<Card, 'latest' | 'label'>): ModalView {
	const choices = latest.choices ?? [];

	return {
		type: 'modal',
		callback_id: DECIDE_CALLBACK,
		private_metadata: JSON.stringify({ cardId: latest.cardId, revision: latest.revision }),
		title: plain(clip(`Decide ${label}`, 24)),
		submit: plain('Decide'),
		close: plain('Cancel'),
		blocks: blocks(
			section(`*${escapeMrkdwn(latest.question)}*`),
			context(`*Recommended:* ${escapeMrkdwn(latest.recommendation)}`),
			choices.length > 0 &&
				input({
					id: 'choice',
					label: 'Choose an option',
					optional: true,
					element: {
						type: 'radio_buttons',
						// Lettered as on the card, so labels cut to the same prefix stay distinct.
						options: choices.map((choice, index) => ({
							value: choice.id,
							text: plain(clip(`${choiceLetter(index)}) ${choice.label}`, OPTION_TEXT_MAX)),
						})),
					},
				}),
			input({
				id: 'custom',
				label: choices.length > 0 ? 'Or write your own answer' : 'Answer',
				optional: choices.length > 0,
				element: { type: 'plain_text_input', max_length: 500 },
			}),
			input({
				id: 'reasoning',
				label: 'Reasoning',
				optional: true,
				element: { type: 'plain_text_input', multiline: true, max_length: 1500 },
			}),
		),
	};
}

export type DecideSubmission = {
	cardId: string;
	revision: number;
	choiceId?: string;
	customAnswer?: string;
	reasoning?: string;
};

const inputValueSchema = v.object({
	value: v.nullish(v.string()),
	selected_option: v.nullish(v.object({ value: v.string() })),
});

const viewSchema = v.object({
	private_metadata: v.string(),
	blocks: v.optional(v.array(v.object({ block_id: v.optional(v.string()) }))),
	state: v.object({
		values: v.record(v.string(), v.record(v.string(), inputValueSchema)),
	}),
});

// `view` is the raw Slack payload; viewSchema parses it at this boundary.
export function parseDecideSubmission(
	// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- raw Slack view payload
	view: Record<string, unknown>,
): { ok: true; submission: DecideSubmission } | { ok: false; errors: Record<string, string> } {
	const parsedView = v.safeParse(viewSchema, view);

	const metadata = parsedView.success
		? parsed(shownRevisionSchema, parsedView.output.private_metadata)
		: undefined;

	if (!parsedView.success || !metadata) {
		return { ok: false, errors: { reasoning: 'This decision could not be read. Try again.' } };
	}

	const { values } = parsedView.output.state;
	const hasChoiceBlock = parsedView.output.blocks?.some((block) => block.block_id === 'choice');
	const choiceId = values.choice?.choice?.selected_option?.value || undefined;
	const customAnswer = values.custom?.custom?.value?.trim() || undefined;
	const reasoning = values.reasoning?.reasoning?.value?.trim() || undefined;

	if (choiceId && customAnswer) {
		return { ok: false, errors: { custom: 'Choose an option or write an answer, not both.' } };
	}

	if (!choiceId && !customAnswer) {
		return hasChoiceBlock
			? { ok: false, errors: { choice: 'Choose an option or write an answer.' } }
			: { ok: false, errors: { custom: 'Write an answer.' } };
	}

	return {
		ok: true,
		submission: { ...metadata, choiceId, customAnswer, reasoning },
	};
}

// Button values and modal metadata are JSON strings Slack hands back as-is.
function parsed<S extends v.GenericSchema<string, unknown>>(
	schema: S,
	value: string,
): v.InferOutput<S> | undefined {
	const result = v.safeParse(schema, value);

	return result.success ? result.output : undefined;
}

// One or more messages, in order; every card keeps its entry.
export function renderSummary(cards: Card[]): string[] {
	if (cards.length === 0) return ['No decisions were recorded.'];

	const decided = cards.flatMap((card) => (card.latest.decision ? [summaryEntry(card)] : []));
	const unresolved = cards.flatMap((card) => (card.latest.decision ? [] : [summaryEntry(card)]));

	return packMessages([
		...withHeading('*Decisions*', decided),
		...withHeading('*Unresolved*', unresolved),
	]);
}

function withHeading(heading: string, entries: string[]): string[] {
	const [first, ...rest] = entries;

	return first ? [`${heading}\n\n${first}`, ...rest] : [];
}

// Joins parts with blank lines into as few messages as fit; no part is split.
function packMessages(parts: string[]): string[] {
	const messages: string[] = [];

	for (const part of parts.map((entry) => clip(entry, SUMMARY_MESSAGE_MAX))) {
		const last = messages.at(-1);

		if (last && last.length + 2 + part.length <= SUMMARY_MESSAGE_MAX) {
			messages[messages.length - 1] = `${last}\n\n${part}`;
		} else {
			messages.push(part);
		}
	}

	return messages;
}

function summaryEntry(card: Card): string {
	const { latest } = card;
	const lines = [`*${card.label}* ${escapeMrkdwn(latest.question)}`];
	const answer = answerText(latest);

	if (answer && latest.decision) {
		lines.push(`Decision: ${escapeMrkdwn(answer)} — <@${latest.decision.decidedBy}>`);
	}

	for (const earlier of card.history.toReversed()) {
		const earlierAnswer = answerText(earlier);

		if (earlierAnswer && earlier.decision) {
			lines.push(`Earlier: ${escapeMrkdwn(earlierAnswer)} — <@${earlier.decision.decidedBy}>`);
		}
	}

	return lines.join('\n');
}

// The most recent decided revision before the latest, for a reopened card.
function previousAnswer(card: Card): { answer: string; decidedBy: string } | undefined {
	if (card.latest.decision) return undefined;

	for (const earlier of card.history.toReversed()) {
		const answer = answerText(earlier);

		if (answer && earlier.decision) return { answer, decidedBy: earlier.decision.decidedBy };
	}

	return undefined;
}

// Notifications and screen readers read this instead of the blocks.
function fallbackText({ label, latest }: Card): string {
	const answer = answerText(latest);

	const state =
		latest.decision && answer
			? `Decided: ${answer} (by ${latest.decision.decidedByName})`
			: 'Open: press Decide to answer';

	return clip(escapeMrkdwn(`${label}: ${latest.question} — ${state}`), 2900);
}

function choiceLetter(index: number): string {
	return String.fromCharCode(65 + index);
}

// Rendered in the viewer's time zone; the fallback is for clients without it.
function slackDate(iso: string): string {
	return `<!date^${Math.floor(Date.parse(iso) / 1000)}^{date_short_pretty} at {time}|${iso}>`;
}
