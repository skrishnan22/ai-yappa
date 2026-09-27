export type InvocationArgs = { model?: string; think?: string; body: string };

export type InvocationArgsResult =
	| { ok: true; args: InvocationArgs }
	| { ok: false; error: string };

type ArgKey = 'model' | 'think';

type Arg = { key: ArgKey; value: string };

// Code spans, code blocks, and quoted lines (Slack sends `>` as `&gt;`).
// Pasted logs and config live there, so nothing inside is an argument. The
// capture group makes `split` keep these parts at odd indexes.
const VERBATIM = /(```[\s\S]*?```|`[^`\n]*`|^(?:>|&gt;).*$)/m;

// A whole word like `model:luna`, `think:high,` or `model:gpt-5.6-luna.`.
// Anything else in the word (`config.model:x`, `model:luna/v2`) makes it prose.
const ARG_WORD = /^(?<key>model|think):(?<value>[\w-]+(?:\.[\w-]+)*)(?<punctuation>[,.;!?)\]]*)$/i;

// A word with the spaces before it, so an argument can leave with its space.
const WORD = /[ \t]*(\S+)/g;

/**
 * Inline `model:` and `think:` arguments from a Slack mention. Values are
 * raw; `resolveModelChoice` decides what they mean. The returned body, with
 * the arguments removed, is what the model reads.
 */
export function parseInvocationArgs(text: string): InvocationArgsResult {
	const found: Arg[] = [];

	const body = text
		.split(VERBATIM)
		.map((part, index) => (index % 2 === 1 ? part : takeArgs(part, found)))
		.join('')
		.trim();

	const values: Partial<Record<ArgKey, string>> = {};

	for (const { key, value } of found) {
		const first = values[key];

		if (first === undefined) {
			values[key] = value;
		} else if (first.toLowerCase() !== value.toLowerCase()) {
			return { ok: false, error: `Conflicting \`${key}:\` values: \`${first}\` and \`${value}\`.` };
		}
	}

	return { ok: true, args: { ...values, body } };
}

// Removes argument words from prose and collects them. Trailing punctuation
// stays, so `use model:kimi, then` becomes `use, then`.
function takeArgs(prose: string, found: Arg[]): string {
	return prose.replace(WORD, (word: string, token: string) => {
		const groups = ARG_WORD.exec(token)?.groups;

		if (groups?.key === undefined || groups.value === undefined) return word;
		found.push({
			key: groups.key.toLowerCase() === 'think' ? 'think' : 'model',
			value: groups.value,
		});

		return groups.punctuation ?? '';
	});
}
