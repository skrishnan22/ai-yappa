import * as v from 'valibot';
import { describe, expect, test } from 'vitest';
import type { JsonObject, JsonValue } from '../json.ts';
import { replyBlocksSchema } from './slack-blocks.ts';

function issues(blocks: JsonValue): string[] {
	const result = v.safeParse(replyBlocksSchema, blocks);

	return result.success ? [] : result.issues.map((issue) => issue.message);
}

function barChart(series: JsonValue, categories: string[]) {
	return {
		type: 'data_visualization',
		title: 'Builds',
		chart: { type: 'bar', series, axis_config: { categories } },
	};
}

function table(rows: JsonValue[][], extra: JsonObject = {}) {
	return { type: 'data_table', caption: 'Results', rows, ...extra };
}

const text = (value: string) => ({ type: 'raw_text', text: value });

describe('replyBlocksSchema', () => {
	test('accepts the display-only capability set', () => {
		const blocks: JsonValue = [
			{ type: 'header', text: { type: 'plain_text', text: 'Weekly build health' } },
			{ type: 'markdown', text: 'Failures dropped after [#42](https://github.com/o/r/pull/42).' },
			{ type: 'divider' },
			{
				type: 'section',
				text: { type: 'mrkdwn', text: '*Summary*' },
				fields: [{ type: 'plain_text', text: 'Passed: 40' }],
			},
			{ type: 'context', elements: [{ type: 'mrkdwn', text: 'Source: CI API' }] },
			{
				type: 'data_visualization',
				title: 'Outcome split',
				chart: {
					type: 'pie',
					segments: [
						{ label: 'Passed', value: 40 },
						{ label: 'Failed', value: 2 },
					],
				},
			},
			barChart(
				[
					{
						name: 'Failures',
						data: [
							{ label: 'Mon', value: 1 },
							{ label: 'Tue', value: 1 },
						],
					},
				],
				['Mon', 'Tue'],
			),
			table(
				[
					[text('Job'), text('Minutes')],
					[text('lint'), { type: 'raw_number', value: 1.5 }],
				],
				{ page_size: 10, row_header_column_index: 0 },
			),
		];

		expect(issues(blocks)).toEqual([]);
	});

	test.each([
		['image block', { type: 'image', image_url: 'https://example.com/a.png', alt_text: 'a' }],
		['actions block', { type: 'actions', elements: [{ type: 'button', action_id: 'go' }] }],
		[
			'section accessory',
			{
				type: 'section',
				text: { type: 'mrkdwn', text: 'hi' },
				accessory: { type: 'image', image_url: 'https://example.com/a.png', alt_text: 'a' },
			},
		],
		[
			'context image element',
			{
				type: 'context',
				elements: [{ type: 'image', image_url: 'https://example.com/a.png', alt_text: 'a' }],
			},
		],
		['rich_text table cell', table([[text('A')], [{ type: 'rich_text', elements: [] }]])],
	])('rejects %s', (_name, block) => {
		expect(issues([block])).not.toEqual([]);
	});

	test('rejects a section with neither text nor fields', () => {
		expect(issues([{ type: 'section' }])).toContain('section needs text or fields');
	});

	test('rejects series data that does not cover every category exactly once', () => {
		expect(
			issues([barChart([{ name: 'A', data: [{ label: 'Mon', value: 1 }] }], ['Mon', 'Tue'])]),
		).toContain('series[0].data is missing categories: "Tue"');
		expect(
			issues([barChart([{ name: 'A', data: [{ label: 'Wed', value: 1 }] }], ['Mon'])]),
		).toContain('series[0].data label "Wed" is not in axis_config.categories');
	});

	test('rejects duplicate series names', () => {
		const series = { name: 'A', data: [{ label: 'Mon', value: 1 }] };

		expect(issues([barChart([series, series], ['Mon'])])).toContain(
			'series[1].name "A" is not unique',
		);
	});

	test('rejects non-finite chart and table numbers', () => {
		const overflowing: unknown = JSON.parse('{"value":1e400}');
		const { value } = v.parse(v.object({ value: v.number() }), overflowing);

		expect(
			issues([
				{
					type: 'data_visualization',
					title: 'Split',
					chart: { type: 'pie', segments: [{ label: 'Overflow', value }] },
				},
			]),
		).not.toEqual([]);
		expect(
			issues([barChart([{ name: 'A', data: [{ label: 'Mon', value: Number.NaN }] }], ['Mon'])]),
		).not.toEqual([]);
		expect(
			issues([table([[text('N')], [{ type: 'raw_number', value: Number.NEGATIVE_INFINITY }]])]),
		).not.toEqual([]);
	});

	test('rejects non-positive pie segments', () => {
		expect(
			issues([
				{
					type: 'data_visualization',
					title: 'Split',
					chart: { type: 'pie', segments: [{ label: 'None', value: 0 }] },
				},
			]),
		).not.toEqual([]);
	});

	test('rejects more than two charts in one message', () => {
		const chart = barChart([{ name: 'A', data: [{ label: 'Mon', value: 1 }] }], ['Mon']);

		expect(issues([chart, chart, chart])).toContain(
			'at most 2 data_visualization blocks per message; got 3',
		);
	});

	test('rejects ragged tables and an out-of-range row header', () => {
		expect(issues([table([[text('A'), text('B')], [text('a')]])])).toContain(
			"rows[1] has 1 cells; every row must match the header's 2",
		);
		expect(issues([table([[text('A')], [text('a')]], { row_header_column_index: 1 })])).toContain(
			'row_header_column_index 1 is outside the 1 columns',
		);
	});

	test('rejects oversized tables instead of truncating them', () => {
		const long = text('x'.repeat(10_001));

		expect(issues([table([[text('A')], [long]]), table([[text('B')], [long]])])).toEqual([
			expect.stringMatching(/data_table cells total 20004 characters/),
		]);
	});

	test('rejects duplicate block ids', () => {
		expect(
			issues([
				{ type: 'divider', block_id: 'x' },
				{ type: 'divider', block_id: 'x' },
			]),
		).toContain('block_id "x" is not unique');
	});
});
