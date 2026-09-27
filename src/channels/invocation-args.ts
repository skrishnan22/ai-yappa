export type InvocationArgs = { model?: string; effort?: string; body: string };

export type InvocationArgsResult =
	| { ok: true; args: InvocationArgs }
	| { ok: false; error: string };

// `$model:luna` or `$effort:high`, with the spaces before it so removing
// it leaves no gap. The `$` keeps ordinary text, code, and logs from
// matching. A value never ends in `.`, so `$model:luna.` ends a sentence.
const ARG = /[ \t]*\$(model|effort):([\w.-]*[\w-])/gi;

/**
 * Reads `$model:` and `$effort:` from a Slack mention and removes them from
 * the text the model reads. Values are raw; `resolveModelChoice` decides
 * what they mean.
 */
export function parseInvocationArgs(text: string): InvocationArgsResult {
	const values: Omit<InvocationArgs, 'body'> = {};

	for (const [, name = '', value = ''] of text.matchAll(ARG)) {
		const key = name.toLowerCase() === 'effort' ? 'effort' : 'model';
		const first = values[key];

		if (first !== undefined && first.toLowerCase() !== value.toLowerCase()) {
			return {
				ok: false,
				error: `Conflicting \`$${key}:\` values: \`${first}\` and \`${value}\`.`,
			};
		}

		values[key] = first ?? value;
	}

	return { ok: true, args: { ...values, body: text.replace(ARG, '').trim() } };
}
