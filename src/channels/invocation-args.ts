export type InvocationArgs = { model?: string; think?: string; body: string };

export type InvocationArgsResult =
	| { ok: true; args: InvocationArgs }
	| { ok: false; error: string };

type ArgKey = 'model' | 'think';

// `key:value` with no space, not glued to a word, path, URL, or another
// `key:`. A value ends at whitespace, closing punctuation, or a sentence
// period, so `model:luna/v2` and `model:lunar-thing:x` do not match.
const ARG_PATTERN =
	/(?<![\w:/.-])(model|think):([\w-]+(?:\.[\w-]+)*)(?=$|[\s,;!?)\]]|\.(?:\s|$))/gi;

// Code spans, code blocks, and quote lines (Slack sends `>` as `&gt;`).
// Pasted logs and config land in these, so arguments there are content.
const MASKED_PATTERN = /```[\s\S]*?```|`[^`\n]*`|^(?:>|&gt;).*$/gm;

/**
 * Inline `model:` and `think:` arguments from a Slack mention. Values are
 * raw; `resolveModelChoice` decides what they mean. The returned body has the
 * matched arguments removed and is what the model reads.
 */
export function parseInvocationArgs(text: string): InvocationArgsResult {
	const masked = [...text.matchAll(MASKED_PATTERN)].map(
		(match) => [match.index, match.index + match[0].length] as const,
	);

	const values: Partial<Record<ArgKey, string>> = {};
	const spans: (readonly [number, number])[] = [];

	for (const match of text.matchAll(ARG_PATTERN)) {
		const start = match.index;

		if (masked.some(([from, to]) => start >= from && start < to)) continue;
		const key: ArgKey = match[1]?.toLowerCase() === 'think' ? 'think' : 'model';
		const value = match[2] ?? '';
		const previous = values[key];

		if (previous !== undefined && previous.toLowerCase() !== value.toLowerCase()) {
			return {
				ok: false,
				error: `Conflicting \`${key}:\` values: \`${previous}\` and \`${value}\`.`,
			};
		}

		values[key] ??= value;
		spans.push([start, start + match[0].length]);
	}

	let body = text;

	for (const [start, end] of spans.toReversed()) {
		body = joinAround(body.slice(0, start), body.slice(end));
	}

	return { ok: true, args: { ...values, body: body.trim() } };
}

function joinAround(before: string, after: string): string {
	const left = before.replace(/[ \t]+$/, '');
	const right = after.replace(/^[ \t]+/, '');

	if (left === '' || right === '' || left.endsWith('\n') || /^[\n,.;:!?)\]]/.test(right)) {
		return left + right;
	}

	return `${left} ${right}`;
}
