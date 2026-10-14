import type { KnownBlock } from '@slack/web-api';

// Slack mrkdwn helpers shared by planning cards and automation messages.

export function escapeMrkdwn(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

// Slack rejects section text over 3000 chars and context text over 2000; clip so a
// long title or prompt never fails a post.
export function sectionBlock(text: string): KnownBlock {
	return { type: 'section', text: { type: 'mrkdwn', text: clip(text, 2900) } };
}

export function contextBlock(text: string): KnownBlock {
	return { type: 'context', elements: [{ type: 'mrkdwn', text: clip(text, 1900) }] };
}

export function clip(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
