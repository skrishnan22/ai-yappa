export type InvocationArgs = { model?: string; think?: string; body: string };

export type InvocationArgsResult =
	| { ok: true; args: InvocationArgs }
	| { ok: false; error: string };

type Arg = { key: 'model' | 'think'; value: string };

const TRAILING_PUNCTUATION = ',.;!?)]';

/**
 * Reads `model:<value>` and `think:<value>` from a Slack mention and removes
 * them from the text the model reads. Values are raw; `resolveModelChoice`
 * decides what they mean.
 *
 * An argument is a whole word. Words inside code (`...`, ``` blocks) and
 * quoted lines are left alone, because pasted logs and config live there.
 */
export function parseInvocationArgs(text: string): InvocationArgsResult {
	const found: Arg[] = [];
	const lines: string[] = [];
	let inCodeBlock = false;

	for (const line of text.split('\n')) {
		const hasFence = line.includes('```');

		if (inCodeBlock || hasFence || isQuote(line)) {
			lines.push(line);
		} else {
			lines.push(takeArgsOutsideInlineCode(line, found));
		}

		if (hasFence && countFences(line) % 2 === 1) inCodeBlock = !inCodeBlock;
	}

	const values: Partial<Record<Arg['key'], string>> = {};

	for (const { key, value } of found) {
		const first = values[key];

		if (first === undefined) {
			values[key] = value;
		} else if (first.toLowerCase() !== value.toLowerCase()) {
			return { ok: false, error: `Conflicting \`${key}:\` values: \`${first}\` and \`${value}\`.` };
		}
	}

	return { ok: true, args: { ...values, body: lines.join('\n').trim() } };
}

// Slack sends `>` as `&gt;`.
function isQuote(line: string): boolean {
	return line.startsWith('>') || line.startsWith('&gt;');
}

function countFences(line: string): number {
	return line.split('```').length - 1;
}

// Splitting on backticks puts inline code at the odd positions.
function takeArgsOutsideInlineCode(line: string, found: Arg[]): string {
	return line
		.split('`')
		.map((part, index) => (index % 2 === 1 ? part : takeArgs(part, found)))
		.join('`');
}

// Drops argument words and collects them. Trailing punctuation moves onto
// the previous word, so `use model:kimi, then` becomes `use, then`.
function takeArgs(prose: string, found: Arg[]): string {
	const kept: string[] = [];

	for (const word of prose.split(' ')) {
		const { bare, punctuation } = splitTrailingPunctuation(word);
		const arg = readArg(bare);

		if (arg === undefined) {
			kept.push(word);
		} else {
			found.push(arg);

			if (punctuation !== '') kept.push(`${kept.pop() ?? ''}${punctuation}`);
		}
	}

	return kept.join(' ');
}

function splitTrailingPunctuation(word: string) {
	let end = word.length;

	while (end > 0 && TRAILING_PUNCTUATION.includes(word.charAt(end - 1))) end--;

	return { bare: word.slice(0, end), punctuation: word.slice(end) };
}

// `model:luna` → { key: 'model', value: 'luna' }. Anything else in the word,
// like `config.model:x` or `model:luna/v2`, makes it ordinary text.
function readArg(word: string): Arg | undefined {
	const colon = word.indexOf(':');
	const key = word.slice(0, colon).toLowerCase();
	const value = word.slice(colon + 1);

	if (colon === -1 || (key !== 'model' && key !== 'think')) return undefined;

	if (!/^[\w.-]+$/.test(value)) return undefined;

	return { key, value };
}
