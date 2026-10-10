import type { KnownBlock } from '@slack/web-api';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
	answerText,
	decideModal,
	parseDecideSubmission,
	renderCard,
	renderSummary,
} from './card-blocks.ts';
import type { Card, CardRevision, Decision } from './decision-log.ts';

const decision: Decision = {
	choiceId: 'pg',
	reasoning: 'We already run it',
	decidedBy: 'U1',
	decidedByName: 'Maya',
	decidedAt: '2026-10-10T12:00:00.000Z',
};

function revision(overrides: Partial<CardRevision> = {}): CardRevision {
	return {
		cardId: 'card-1',
		revision: 1,
		conversationId: 'conv',
		channelId: 'C1',
		threadTs: '1.1',
		createdAt: '2026-10-10T11:00:00.000Z',
		question: 'Which database?',
		context: 'Needs transactions',
		recommendation: 'Postgres',
		choices: [
			{ id: 'pg', label: 'Postgres' },
			{ id: 'my', label: 'MySQL' },
		],
		...overrides,
	};
}

function card(latest: CardRevision, history: CardRevision[] = [], label = 'D2'): Card {
	return { label, latest, history };
}

function allText(blocks: KnownBlock[]): string {
	return JSON.stringify(blocks);
}

function buttons(blocks: KnownBlock[]) {
	return blocks.flatMap((b) => (b.type === 'actions' ? b.elements : []));
}

describe('renderCard', () => {
	it('renders an open card with choices, recommendation and a Decide button', () => {
		const { text, blocks } = renderCard(card(revision()));

		expect(text).toContain('D2');
		expect(text).toContain('Which database?');
		const body = allText(blocks);

		expect(body).toContain('Needs transactions');
		expect(body).toContain('A) Postgres');
		expect(body).toContain('B) MySQL');
		expect(body).toContain('Recommended:');
		expect(buttons(blocks)).toMatchObject([
			{
				type: 'button',
				action_id: 'planning_decide',
				value: 'card-1',
				text: { text: 'Decide…' },
			},
		]);
	});

	it('renders a decided card with answer, reasoning, decider and a Reopen button only', () => {
		const { blocks } = renderCard(card(revision({ decision })));
		const body = allText(blocks);

		expect(body).toContain('✅');
		expect(body).toContain('Postgres');
		expect(body).toContain('We already run it');
		expect(body).toContain('Decided by <@U1>');
		expect(body).toContain('<!date^');
		expect(buttons(blocks).map((b) => ('action_id' in b ? b.action_id : ''))).toEqual([
			'planning_reopen',
		]);
	});

	it('shows a custom answer on a decided card', () => {
		const { blocks } = renderCard(
			card(revision({ decision: { ...decision, choiceId: undefined, customAnswer: 'SQLite' } })),
		);

		expect(allText(blocks)).toContain('SQLite');
	});

	it('shows the previous answer on a reopened card', () => {
		const first = revision({ decision });
		const reopened = revision({ revision: 2 });
		const { blocks } = renderCard(card(reopened, [first]));
		const body = allText(blocks);

		expect(body).toContain('Previously: Postgres — <@U1>');
		expect(body).toContain('planning_decide');
		expect(body).not.toContain('planning_reopen');
	});

	it('escapes user text in mrkdwn fields', () => {
		const { blocks } = renderCard(
			card(
				revision({
					question: 'a <b> & c',
					context: '<ctx>',
					recommendation: '<rec>',
					choices: [
						{ id: 'x', label: '<x>' },
						{ id: 'y', label: 'y&' },
					],
				}),
			),
		);

		const body = allText(blocks);

		expect(body).toContain('a &lt;b&gt; &amp; c');
		expect(body).toContain('&lt;ctx&gt;');
		expect(body).toContain('&lt;rec&gt;');
		expect(body).toContain('A) &lt;x&gt;');
		expect(body).toContain('B) y&amp;');
		expect(body).not.toContain('<b>');
	});

	it('escapes reasoning and custom answers on a decided card', () => {
		const { blocks } = renderCard(
			card(
				revision({
					decision: { ...decision, choiceId: undefined, customAnswer: '<a>', reasoning: '<r>&' },
				}),
			),
		);

		const body = allText(blocks);

		expect(body).toContain('&lt;a&gt;');
		expect(body).toContain('&lt;r&gt;&amp;');
	});
});

describe('answerText', () => {
	it('returns the choice label, the custom answer, or nothing', () => {
		expect(answerText(revision({ decision }))).toBe('Postgres');
		expect(
			answerText(
				revision({ decision: { ...decision, choiceId: undefined, customAnswer: 'SQLite' } }),
			),
		).toBe('SQLite');
		expect(answerText(revision())).toBeUndefined();
	});
});

const inputBlockSchema = v.object({
	optional: v.optional(v.boolean()),
	element: v.object({
		type: v.string(),
		multiline: v.optional(v.boolean()),
		options: v.optional(v.array(v.unknown())),
	}),
});

const optionsSchema = v.array(v.object({ text: v.object({ text: v.string() }) }));

describe('decideModal', () => {
	function blockIds(view: ReturnType<typeof decideModal>): string[] {
		return (view.blocks ?? []).flatMap((b) => ('block_id' in b && b.block_id ? [b.block_id] : []));
	}

	function input(view: ReturnType<typeof decideModal>, id: string) {
		const found = (view.blocks ?? []).find((b) => 'block_id' in b && b.block_id === id);

		return v.parse(inputBlockSchema, found);
	}

	it('offers a choice, an optional custom answer and optional reasoning', () => {
		const view = decideModal(card(revision()));

		expect(view.callback_id).toBe('planning_decide_modal');
		expect(JSON.parse(view.private_metadata ?? '')).toEqual({ cardId: 'card-1', revision: 1 });
		expect(view.title.text.length).toBeLessThanOrEqual(24);
		expect(blockIds(view)).toEqual(expect.arrayContaining(['choice', 'custom', 'reasoning']));
		expect(input(view, 'choice')).toMatchObject({
			optional: true,
			element: { type: 'radio_buttons' },
		});

		expect(input(view, 'choice').element.options).toHaveLength(2);
		expect(input(view, 'custom').optional).toBe(true);
		expect(input(view, 'reasoning')).toMatchObject({
			optional: true,
			element: { type: 'plain_text_input', multiline: true },
		});
	});

	it('requires the custom answer when there are no choices', () => {
		const view = decideModal(card(revision({ choices: undefined })));

		expect(blockIds(view)).not.toContain('choice');
		expect(input(view, 'custom').optional).toBeFalsy();
		expect(input(view, 'reasoning').optional).toBe(true);
	});

	it('truncates long option labels to 75 characters', () => {
		const view = decideModal(
			card(
				revision({
					choices: [
						{ id: 'a', label: 'x'.repeat(200) },
						{ id: 'b', label: 'short' },
					],
				}),
			),
		);

		const options = v.parse(optionsSchema, input(view, 'choice').element.options);

		expect(options[0]?.text.text.length).toBeLessThanOrEqual(75);
		expect(options[0]?.text.text.endsWith('…')).toBe(true);
	});
});

describe('parseDecideSubmission', () => {
	function view(
		values: { choice?: string; custom?: string; reasoning?: string },
		opts: { choiceBlock?: boolean; metadata?: string } = {},
	) {
		const { choiceBlock = true, metadata = JSON.stringify({ cardId: 'card-1', revision: 3 }) } =
			opts;

		return {
			private_metadata: metadata,
			blocks: [...(choiceBlock ? [{ block_id: 'choice' }] : []), { block_id: 'custom' }],
			state: {
				values: {
					choice: {
						choice: { selected_option: values.choice ? { value: values.choice } : null },
					},
					custom: { custom: { value: values.custom ?? null } },
					reasoning: { reasoning: { value: values.reasoning ?? null } },
				},
			},
		};
	}

	it('accepts a choice alone', () => {
		expect(parseDecideSubmission(view({ choice: 'pg' }))).toEqual({
			ok: true,
			submission: {
				cardId: 'card-1',
				revision: 3,
				choiceId: 'pg',
				customAnswer: undefined,
				reasoning: undefined,
			},
		});
	});

	it('accepts a trimmed custom answer alone', () => {
		const result = parseDecideSubmission(view({ custom: '  SQLite  ', reasoning: ' why ' }));

		expect(result).toMatchObject({
			ok: true,
			submission: { customAnswer: 'SQLite', reasoning: 'why', choiceId: undefined },
		});
	});

	it('rejects both a choice and a custom answer', () => {
		const result = parseDecideSubmission(view({ choice: 'pg', custom: 'x' }));

		expect(result).toMatchObject({ ok: false, errors: { custom: expect.any(String) } });
	});

	it('rejects neither, reporting on the choice block when present', () => {
		expect(parseDecideSubmission(view({ custom: '   ' }))).toMatchObject({
			ok: false,
			errors: { choice: expect.any(String) },
		});

		expect(parseDecideSubmission(view({}, { choiceBlock: false }))).toMatchObject({
			ok: false,
			errors: { custom: expect.any(String) },
		});
	});

	it('reports malformed private_metadata under reasoning', () => {
		expect(parseDecideSubmission(view({ choice: 'pg' }, { metadata: 'nope' }))).toMatchObject({
			ok: false,
			errors: { reasoning: expect.any(String) },
		});
	});

	it('treats blank reasoning as absent', () => {
		const result = parseDecideSubmission(view({ choice: 'pg', reasoning: '   ' }));

		expect(result).toMatchObject({ ok: true, submission: { reasoning: undefined } });
	});
});

describe('renderSummary', () => {
	it('lists decided, reopened and unresolved cards', () => {
		const decided = card(revision({ decision }), [], 'D1');

		const reopened = card(
			revision({
				cardId: 'card-2',
				revision: 2,
				question: 'Which cache?',
				decision: { ...decision, choiceId: undefined, customAnswer: 'Redis', decidedBy: 'U2' },
			}),
			[
				revision({
					cardId: 'card-2',
					question: 'Which cache?',
					decision: { ...decision, choiceId: 'my', decidedBy: 'U3' },
				}),
			],
			'D2',
		);

		const open = card(revision({ cardId: 'card-3', question: 'Which queue?' }), [], 'D3');
		const text = renderSummary([decided, reopened, open]);

		expect(text).toContain('D1');
		expect(text).toContain('Which database?');
		expect(text).toContain('Postgres');
		expect(text).toContain('<@U1>');
		expect(text).toContain('Redis');
		expect(text).toContain('<@U2>');
		expect(text).toContain('MySQL');
		expect(text).toContain('<@U3>');
		expect(text).toMatch(/Unresolved[\s\S]*D3[\s\S]*Which queue\?/);
	});

	it('says so when there are no cards', () => {
		expect(renderSummary([])).toBe('No decisions were recorded.');
	});
});
