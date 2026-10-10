import type { KnownBlock, ModalView } from '@slack/web-api';
import * as v from 'valibot';
import type { Card, CardRevision } from './decision-log.ts';

export const DECIDE_ACTION = 'planning_decide';

export const REOPEN_ACTION = 'planning_reopen';

export const DECIDE_CALLBACK = 'planning_decide_modal';

const OPTION_TEXT_MAX = 75;

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
	const text = `${label}: ${latest.question}`;

	const blocks: KnownBlock[] = [
		{
			type: 'section',
			text: { type: 'mrkdwn', text: `*${label}* ${escapeMrkdwn(latest.question)}` },
		},
	];

	const previous = previousAnswer(card);

	if (previous) {
		blocks.push({
			type: 'context',
			elements: [
				{
					type: 'mrkdwn',
					text: `Previously: ${escapeMrkdwn(previous.answer)} — <@${previous.decidedBy}>`,
				},
			],
		});
	}

	if (latest.context) {
		blocks.push({
			type: 'context',
			elements: [{ type: 'mrkdwn', text: escapeMrkdwn(latest.context) }],
		});
	}

	if (latest.choices && latest.choices.length > 0) {
		const lines = latest.choices.map(
			(choice, index) => `${choiceLetter(index)}) ${escapeMrkdwn(choice.label)}`,
		);

		blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
	}

	blocks.push({
		type: 'section',
		text: { type: 'mrkdwn', text: `*Recommended:* ${escapeMrkdwn(latest.recommendation)}` },
	});

	const decision = latest.decision;

	if (decision) {
		const lines = [`✅ *${escapeMrkdwn(answerText(latest) ?? '')}*`];

		if (decision.reasoning) lines.push(escapeMrkdwn(decision.reasoning));
		lines.push(`Decided by <@${decision.decidedBy}> ${slackDate(decision.decidedAt)}`);
		blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
		blocks.push({
			type: 'actions',
			elements: [
				{
					type: 'button',
					action_id: REOPEN_ACTION,
					value: latest.cardId,
					text: { type: 'plain_text', text: 'Reopen' },
				},
			],
		});
	} else {
		blocks.push({
			type: 'actions',
			elements: [
				{
					type: 'button',
					action_id: DECIDE_ACTION,
					value: latest.cardId,
					style: 'primary',
					text: { type: 'plain_text', text: 'Decide…' },
				},
			],
		});
	}

	return { text, blocks };
}

export function decideModal(card: Card): ModalView {
	const { latest } = card;
	const choices = latest.choices ?? [];

	const blocks: KnownBlock[] = [
		{ type: 'section', text: { type: 'mrkdwn', text: `*${escapeMrkdwn(latest.question)}*` } },
		{
			type: 'context',
			elements: [{ type: 'mrkdwn', text: `*Recommended:* ${escapeMrkdwn(latest.recommendation)}` }],
		},
	];

	if (choices.length > 0) {
		blocks.push({
			type: 'input',
			block_id: 'choice',
			optional: true,
			label: { type: 'plain_text', text: 'Choose an option' },
			element: {
				type: 'radio_buttons',
				action_id: 'choice',
				options: choices.map((choice) => ({
					value: choice.id,
					text: { type: 'plain_text', text: truncate(choice.label, OPTION_TEXT_MAX) },
				})),
			},
		});
	}

	blocks.push({
		type: 'input',
		block_id: 'custom',
		optional: choices.length > 0,
		label: { type: 'plain_text', text: choices.length > 0 ? 'Or write your own answer' : 'Answer' },
		element: { type: 'plain_text_input', action_id: 'custom' },
	});

	blocks.push({
		type: 'input',
		block_id: 'reasoning',
		optional: true,
		label: { type: 'plain_text', text: 'Reasoning' },
		element: { type: 'plain_text_input', action_id: 'reasoning', multiline: true },
	});

	return {
		type: 'modal',
		callback_id: DECIDE_CALLBACK,
		private_metadata: JSON.stringify({ cardId: latest.cardId, revision: latest.revision }),
		title: { type: 'plain_text', text: truncate(`Decide ${card.label}`, 24) },
		submit: { type: 'plain_text', text: 'Decide' },
		close: { type: 'plain_text', text: 'Cancel' },
		blocks,
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

const metadataSchema = v.object({ cardId: v.string(), revision: v.number() });

// `view` is the raw Slack payload; viewSchema parses it at this boundary.
export function parseDecideSubmission(
	// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- raw Slack view payload
	view: Record<string, unknown>,
): { ok: true; submission: DecideSubmission } | { ok: false; errors: Record<string, string> } {
	const parsedView = v.safeParse(viewSchema, view);

	const metadata = parsedView.success
		? parseMetadata(parsedView.output.private_metadata)
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

function parseMetadata(raw: string): v.InferOutput<typeof metadataSchema> | undefined {
	try {
		const parsed = v.safeParse(metadataSchema, JSON.parse(raw));

		return parsed.success ? parsed.output : undefined;
	} catch {
		return undefined;
	}
}

export function renderSummary(cards: Card[]): string {
	if (cards.length === 0) return 'No decisions were recorded.';

	const decided = cards.filter((card) => card.latest.decision);
	const unresolved = cards.filter((card) => !card.latest.decision);
	const sections: string[] = [];

	if (decided.length > 0) {
		sections.push(['*Decisions*', ...decided.map(summaryEntry)].join('\n\n'));
	}

	if (unresolved.length > 0) {
		sections.push(['*Unresolved*', ...unresolved.map(summaryEntry)].join('\n\n'));
	}

	return sections.join('\n\n');
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

function choiceLetter(index: number): string {
	return String.fromCharCode(65 + index);
}

// Rendered in the viewer's time zone; the fallback is for clients without it.
function slackDate(iso: string): string {
	return `<!date^${Math.floor(Date.parse(iso) / 1000)}^{date_short_pretty} at {time}|${iso}>`;
}

function escapeMrkdwn(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
