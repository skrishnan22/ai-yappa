import { toJsonSchema, type JsonSchema } from '@valibot/to-json-schema';
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

type SchemaDefinition = JsonSchema | boolean;

function eachSchema(
	definition: SchemaDefinition | SchemaDefinition[] | undefined,
	visit: (schema: JsonSchema) => void,
) {
	if (definition === undefined || definition === true || definition === false) return;

	if (Array.isArray(definition)) {
		for (const item of definition) eachSchema(item, visit);

		return;
	}

	visit(definition);
	eachSchema(definition.anyOf, visit);
	eachSchema(definition.oneOf, visit);
	eachSchema(definition.items, visit);
	eachSchema(definition.additionalProperties, visit);

	if (definition.properties === undefined) return;

	for (const property of Object.values(definition.properties)) eachSchema(property, visit);
}

function directTypes(schema: JsonSchema): string[] {
	const types: string[] = [];

	for (const option of schema.anyOf ?? []) {
		if (option === true || option === false) continue;

		const type = option.type;

		if (type === undefined || Array.isArray(type)) continue;

		types.push(type);
	}

	return types;
}

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
		).toContain(
			'series[0].data label "Wed" is not in axis_config.categories; change the label or add "Wed" to axis_config.categories',
		);
	});

	test('rejects duplicate axis categories', () => {
		expect(
			issues([barChart([{ name: 'A', data: [{ label: 'Mon', value: 1 }] }], ['Mon', 'Mon'])]),
		).toContain('axis_config.categories lists "Mon" more than once; remove the duplicate');
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
		expect(issues([table([[text('N')], [Number.NaN]])])).not.toEqual([]);
		expect(issues([table([[text('N')], [Number.POSITIVE_INFINITY]])])).not.toEqual([]);
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
			'row_header_column_index 1 is not a column index; use an integer from 0 to 0, or omit it',
		);
	});

	test('rejects oversized tables instead of truncating them', () => {
		const long = text('x'.repeat(10_001));

		expect(issues([table([[text('A')], [long]]), table([[text('B')], [long]])])).toEqual([
			expect.stringMatching(/data_table cells total 20004 characters/),
		]);
	});

	test('normalizes bare table cells and header text', () => {
		const result = v.safeParse(replyBlocksSchema, [
			{ type: 'header', text: 'Weekly build health' },
			{
				type: 'header',
				text: { type: 'plain_text', text: 'Unchanged', emoji: false },
			},
			table([
				['Job', { type: 'raw_text', text: 'Minutes' }],
				['lint', { type: 'raw_number', value: 1.5, text: '1.5' }],
				['fmt', 2],
			]),
		]);

		expect(result).toMatchObject({
			success: true,
			output: [
				{ type: 'header', text: { type: 'plain_text', text: 'Weekly build health' } },
				{ type: 'header', text: { type: 'plain_text', text: 'Unchanged', emoji: false } },
				{
					type: 'data_table',
					caption: 'Results',
					rows: [
						[
							{ type: 'raw_text', text: 'Job' },
							{ type: 'raw_text', text: 'Minutes' },
						],
						[
							{ type: 'raw_text', text: 'lint' },
							{ type: 'raw_number', value: 1.5, text: '1.5' },
						],
						[
							{ type: 'raw_text', text: 'fmt' },
							{ type: 'raw_number', value: 2 },
						],
					],
				},
			],
		});
	});

	test('counts coerced table cell strings toward the message character limit', () => {
		const long = 'x'.repeat(10_001);

		expect(issues([table([['A'], [long]]), table([['B'], [long]])])).toEqual([
			expect.stringMatching(/data_table cells total 20004 characters/),
		]);
	});

	test('rejects empty cells and bare text where the object type is ambiguous', () => {
		expect(issues([table([[''], ['a']])])).not.toEqual([]);
		expect(issues([{ type: 'header', text: '' }])).not.toEqual([]);
		expect(issues([{ type: 'header', text: { type: 'mrkdwn', text: 'Weekly' } }])).not.toEqual([]);
		expect(issues([{ type: 'section', text: 'hello' }])).not.toEqual([]);
		expect(issues([{ type: 'context', elements: ['source'] }])).not.toEqual([]);
	});

	test('rejects markdown text over the message character limit', () => {
		expect(issues([{ type: 'markdown', text: 'x'.repeat(12_001) }])).toContain(
			'markdown blocks total 12001 characters; shorten them to at most 12000',
		);
	});

	test('tool json schema admits string and number table cells', () => {
		const schema = toJsonSchema(replyBlocksSchema, { errorMode: 'ignore' });
		const cells: JsonSchema[] = [];
		const headers: JsonSchema[] = [];

		eachSchema(schema, (node) => {
			const types = directTypes(node);

			if (types.includes('string') && types.includes('number')) cells.push(node);

			const options = node.anyOf ?? [];

			const headerText = options.some((option) => {
				if (option === true || option === false) return false;

				const typeSchema = option.properties?.type;

				if (typeSchema === undefined || typeSchema === true || typeSchema === false) return false;

				return typeSchema.const === 'plain_text';
			});

			if (types.includes('string') && headerText) headers.push(node);
		});

		expect(cells).toHaveLength(1);
		expect(cells[0]).toMatchObject({
			anyOf: expect.arrayContaining([
				expect.objectContaining({ type: 'string', minLength: 1 }),
				expect.objectContaining({ type: 'number' }),
				expect.objectContaining({
					oneOf: expect.arrayContaining([
						expect.objectContaining({
							properties: expect.objectContaining({
								type: expect.objectContaining({ const: 'raw_text' }),
							}),
						}),
						expect.objectContaining({
							properties: expect.objectContaining({
								type: expect.objectContaining({ const: 'raw_number' }),
							}),
						}),
					]),
				}),
			]),
		});
		expect(headers).toEqual([
			expect.objectContaining({
				anyOf: expect.arrayContaining([
					expect.objectContaining({ type: 'string', minLength: 1, maxLength: 150 }),
				]),
			}),
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
