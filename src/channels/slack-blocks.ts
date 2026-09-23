import * as v from 'valibot';

// Display-only Block Kit capability set for model-authored replies (ADR 0019).
// Every object is strict, so URL-bearing fields (image_url, accessory, …) and
// app-callback elements are rejected rather than stripped. Adding a block or
// element type here is a reviewed capability change.

const MAX_BLOCKS = 50;

const MAX_DATA_VISUALIZATIONS = 2;

const MAX_MARKDOWN_CHARS = 12_000;

const MAX_TABLE_CELL_CHARS = 20_000;

function boundedString(max: number) {
	return v.pipe(v.string(), v.minLength(1), v.maxLength(max));
}

const finiteNumber = v.pipe(v.number(), v.finite());

const blockId = v.optional(boundedString(255));

function plainText(max: number) {
	return v.strictObject({
		type: v.literal('plain_text'),
		text: boundedString(max),
		emoji: v.optional(v.boolean()),
	});
}

function textObject(max: number) {
	return v.variant('type', [
		plainText(max),
		v.strictObject({
			type: v.literal('mrkdwn'),
			text: boundedString(max),
			verbatim: v.optional(v.boolean()),
		}),
	]);
}

const markdownBlock = v.strictObject({
	type: v.literal('markdown'),
	block_id: blockId,
	text: v.pipe(v.string(), v.minLength(1)),
});

const headerBlock = v.strictObject({
	type: v.literal('header'),
	block_id: blockId,
	text: plainText(150),
});

const dividerBlock = v.strictObject({
	type: v.literal('divider'),
	block_id: blockId,
});

const sectionBlock = v.pipe(
	v.strictObject({
		type: v.literal('section'),
		block_id: blockId,
		text: v.optional(textObject(3000)),
		fields: v.optional(v.pipe(v.array(textObject(2000)), v.minLength(1), v.maxLength(10))),
		expand: v.optional(v.boolean()),
	}),
	v.check(
		(section) => section.text !== undefined || section.fields !== undefined,
		'section needs text or fields',
	),
);

const contextBlock = v.strictObject({
	type: v.literal('context'),
	block_id: blockId,
	elements: v.pipe(v.array(textObject(3000)), v.minLength(1), v.maxLength(10)),
});

const chartLabel = boundedString(20);

const pieChart = v.strictObject({
	type: v.literal('pie'),
	segments: v.pipe(
		v.array(v.strictObject({ label: chartLabel, value: v.pipe(finiteNumber, v.gtValue(0)) })),
		v.minLength(1),
		v.maxLength(12),
	),
});

const dataSeries = v.strictObject({
	name: chartLabel,
	data: v.pipe(
		v.array(v.strictObject({ label: chartLabel, value: finiteNumber })),
		v.minLength(1),
		v.maxLength(20),
	),
});

const axisConfig = v.strictObject({
	categories: v.pipe(v.array(chartLabel), v.minLength(1), v.maxLength(20)),
	x_label: v.optional(boundedString(50)),
	y_label: v.optional(boundedString(50)),
});

type SeriesChart = {
	series: v.InferOutput<typeof dataSeries>[];
	axis_config: v.InferOutput<typeof axisConfig>;
};

function seriesChartIssue({ series, axis_config }: SeriesChart): string | undefined {
	const categories = new Set(axis_config.categories);

	if (categories.size !== axis_config.categories.length) {
		return 'axis_config.categories must be unique';
	}

	const names = new Set<string>();

	for (const [index, entry] of series.entries()) {
		if (names.has(entry.name)) return `series[${index}].name "${entry.name}" is not unique`;
		names.add(entry.name);

		const seen = new Set<string>();

		for (const point of entry.data) {
			if (!categories.has(point.label)) {
				return `series[${index}].data label "${point.label}" is not in axis_config.categories`;
			}

			if (seen.has(point.label)) {
				return `series[${index}].data has label "${point.label}" more than once`;
			}

			seen.add(point.label);
		}

		const missing = axis_config.categories.filter((category) => !seen.has(category));

		if (missing.length > 0) {
			return `series[${index}].data is missing categories: ${missing.map((label) => `"${label}"`).join(', ')}`;
		}
	}

	return undefined;
}

function seriesChart<const T extends 'bar' | 'area' | 'line'>(type: T) {
	return v.pipe(
		v.strictObject({
			type: v.literal(type),
			series: v.pipe(v.array(dataSeries), v.minLength(1), v.maxLength(12)),
			axis_config: axisConfig,
		}),
		v.rawCheck(({ dataset, addIssue }) => {
			if (!dataset.typed) return;

			const message = seriesChartIssue(dataset.value);

			if (message) addIssue({ message });
		}),
	);
}

const dataVisualizationBlock = v.strictObject({
	type: v.literal('data_visualization'),
	block_id: blockId,
	title: boundedString(50),
	chart: v.variant('type', [
		pieChart,
		seriesChart('bar'),
		seriesChart('area'),
		seriesChart('line'),
	]),
});

const tableCell = v.variant('type', [
	v.strictObject({ type: v.literal('raw_text'), text: v.pipe(v.string(), v.minLength(1)) }),
	v.strictObject({
		type: v.literal('raw_number'),
		value: finiteNumber,
		text: v.optional(v.pipe(v.string(), v.minLength(1))),
	}),
]);

type TableCell = v.InferOutput<typeof tableCell>;

const dataTableBlock = v.pipe(
	v.strictObject({
		type: v.literal('data_table'),
		block_id: blockId,
		caption: v.pipe(v.string(), v.minLength(1)),
		rows: v.pipe(
			v.array(v.pipe(v.array(tableCell), v.minLength(1), v.maxLength(20))),
			v.minLength(2),
			v.maxLength(201),
		),
		page_size: v.optional(v.pipe(finiteNumber, v.integer(), v.minValue(1), v.maxValue(100))),
		row_header_column_index: v.optional(v.pipe(finiteNumber, v.integer(), v.minValue(0))),
	}),
	v.rawCheck(({ dataset, addIssue }) => {
		if (!dataset.typed) return;
		const { rows, row_header_column_index: rowHeader } = dataset.value;
		const columns = rows[0]?.length ?? 0;
		const ragged = rows.findIndex((row) => row.length !== columns);

		if (ragged !== -1) {
			addIssue({
				message: `rows[${ragged}] has ${rows[ragged]?.length} cells; every row must match the header's ${columns}`,
			});
		}

		if (rowHeader !== undefined && rowHeader >= columns) {
			addIssue({
				message: `row_header_column_index ${rowHeader} is outside the ${columns} columns`,
			});
		}
	}),
);

const block = v.variant('type', [
	markdownBlock,
	headerBlock,
	dividerBlock,
	sectionBlock,
	contextBlock,
	dataVisualizationBlock,
	dataTableBlock,
]);

export type ReplyBlock = v.InferOutput<typeof block>;

function cellChars(cell: TableCell): number {
	return cell.type === 'raw_text' ? cell.text.length : (cell.text ?? String(cell.value)).length;
}

function messageIssues(blocks: readonly ReplyBlock[]): string[] {
	const issues: string[] = [];
	const blockIds = new Set<string>();
	let charts = 0;
	let markdownChars = 0;
	let tableChars = 0;

	for (const entry of blocks) {
		if (entry.block_id !== undefined) {
			if (blockIds.has(entry.block_id)) issues.push(`block_id "${entry.block_id}" is not unique`);
			blockIds.add(entry.block_id);
		}

		if (entry.type === 'data_visualization') charts += 1;

		if (entry.type === 'markdown') markdownChars += entry.text.length;

		if (entry.type === 'data_table') {
			for (const row of entry.rows) {
				for (const cell of row) tableChars += cellChars(cell);
			}
		}
	}

	if (charts > MAX_DATA_VISUALIZATIONS) {
		issues.push(
			`at most ${MAX_DATA_VISUALIZATIONS} data_visualization blocks per message; got ${charts}`,
		);
	}

	if (markdownChars > MAX_MARKDOWN_CHARS) {
		issues.push(
			`markdown blocks total ${markdownChars} characters; the limit is ${MAX_MARKDOWN_CHARS}`,
		);
	}

	if (tableChars > MAX_TABLE_CELL_CHARS) {
		issues.push(
			`data_table cells total ${tableChars} characters; the limit is ${MAX_TABLE_CELL_CHARS} per message. Split the table across replies`,
		);
	}

	return issues;
}

export const replyBlocksSchema = v.pipe(
	v.array(block),
	v.minLength(1),
	v.maxLength(MAX_BLOCKS),
	v.rawCheck(({ dataset, addIssue }) => {
		if (!dataset.typed) return;

		for (const message of messageIssues(dataset.value)) addIssue({ message });
	}),
);
