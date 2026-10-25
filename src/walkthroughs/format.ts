import * as v from 'valibot';

const text = (length: number) => v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(length));

const identifier = v.pipe(text(32), v.regex(/^[a-z][a-z0-9-]*$/));

const sha = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/));

export const walkthroughFieldsSchema = v.strictObject({
	title: text(120),
	repository: v.pipe(text(200), v.regex(/^[\w.-]+\/[\w.-]+$/)),
	baseSha: sha,
	headSha: sha,
	nodes: v.pipe(
		v.array(v.strictObject({ id: identifier, label: text(24) })),
		v.minLength(1),
		v.maxLength(4),
	),
	edges: v.pipe(v.array(v.strictObject({ from: identifier, to: identifier })), v.maxLength(6)),
	steps: v.pipe(
		v.array(
			v.strictObject({
				name: identifier,
				caption: text(600),
				activeNodes: v.pipe(v.array(identifier), v.maxLength(4)),
				code: v.pipe(
					v.array(
						v.pipe(
							v.string(),
							v.maxLength(100),
							v.check((line) => !/[\r\n]/.test(line), 'Code entries must be individual lines.'),
						),
					),
					v.minLength(1),
					v.maxLength(8),
				),
				highlight: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
				source: v.optional(
					v.strictObject({
						path: v.pipe(
							text(240),
							v.check(
								(path) =>
									!path.startsWith('/') &&
									!path.split('/').includes('..') &&
									!/[\\?#\r\n]/.test(path),
								'Use a repository-relative source path.',
							),
						),
						line: v.pipe(v.number(), v.integer(), v.minValue(1)),
					}),
				),
			}),
		),
		v.minLength(1),
		v.maxLength(6),
	),
});

export const walkthroughSchema = v.pipe(
	walkthroughFieldsSchema,
	v.check(
		(doc) => new Set(doc.nodes.map((node) => node.id)).size === doc.nodes.length,
		'Node IDs must be unique.',
	),
	v.check(
		(doc) => new Set(doc.steps.map((step) => step.name)).size === doc.steps.length,
		'Step names must be unique.',
	),
	v.check((doc) => {
		const ids = new Set(doc.nodes.map((node) => node.id));

		return (
			doc.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to) &&
			doc.steps.every((step) => step.activeNodes.every((id) => ids.has(id)))
		);
	}, 'Edges and activeNodes must reference existing nodes; self edges are unsupported.'),
	v.check(
		(doc) =>
			doc.steps.every((step) => step.highlight === undefined || step.highlight < step.code.length),
		'highlight must address a code line (starting at zero).',
	),
);

export type Walkthrough = v.InferOutput<typeof walkthroughSchema>;

export function sourceUrl({
	repository,
	headSha,
	source,
}: Pick<Walkthrough, 'repository' | 'headSha'> & {
	source: NonNullable<Walkthrough['steps'][number]['source']>;
}): string {
	const path = source.path.split('/').map(encodeURIComponent).join('/');

	return `https://github.com/${repository}/blob/${headSha}/${path}#L${source.line}`;
}
