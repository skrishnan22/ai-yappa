import type {
	ActionsBlock,
	Button,
	ContextBlock,
	InputBlock,
	InputBlockElement,
	KnownBlock,
	PlainTextElement,
	SectionBlock,
} from '@slack/web-api';

// Block Kit builders shared by planning cards, run cards, and automation messages.
// `blocks()` drops absent entries, so a message reads as one list with its
// conditions inline: `blocks(section(a), note && context(note), actions(...))`.

type Maybe<T> = T | false | '' | null | undefined;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export function blocks(...entries: Maybe<KnownBlock>[]): KnownBlock[] {
	return entries.filter((entry): entry is KnownBlock => Boolean(entry));
}

export function plain(text: string): PlainTextElement {
	return { type: 'plain_text', text };
}

// Slack rejects section text over 3000 chars and context text over 2000; clip so a
// long title or prompt never fails a post.
export function section(text: string): SectionBlock {
	return { type: 'section', text: { type: 'mrkdwn', text: clip(text, 2900) } };
}

export function context(text: string): ContextBlock {
	return { type: 'context', elements: [{ type: 'mrkdwn', text: clip(text, 1900) }] };
}

export function button({
	actionId,
	text,
	value,
	style,
}: {
	actionId: string;
	text: string;
	value: string;
	style?: 'primary' | 'danger';
}): Button {
	return { type: 'button', action_id: actionId, text: plain(text), value, ...(style && { style }) };
}

// No block when no button is shown; Slack rejects an empty actions block.
export function actions(...buttons: Maybe<Button>[]): ActionsBlock | undefined {
	const elements = buttons.filter((entry): entry is Button => Boolean(entry));

	return elements.length > 0 ? { type: 'actions', elements } : undefined;
}

// One id names both the block and its element, so a submission reads
// `state.values[id][id]`.
export function input({
	id,
	label,
	optional,
	element,
}: {
	id: string;
	label: string;
	optional?: boolean;
	element: DistributiveOmit<InputBlockElement, 'action_id'>;
}): InputBlock {
	return {
		type: 'input',
		block_id: id,
		label: plain(label),
		...(optional && { optional }),
		element: { ...element, action_id: id },
	};
}

export function escapeMrkdwn(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function clip(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
