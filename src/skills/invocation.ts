// `/grill-me` as its own word: it must start the text or follow whitespace,
// and end at whitespace or the end, optionally after sentence punctuation.
// Paths (`/usr/bin`, `/grill-me/notes`), filenames (`/grill-me.md`), and URLs
// never match.
const SKILL_MENTION = /(?<!\S)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=[.,!?;:]*(?:\s|$))/gi;

/**
 * The registered skills a Slack mention invokes with `/<name>`, distinct and
 * in order. Unknown names stay ordinary text.
 */
export function invokedSkills(text: string, names: ReadonlySet<string>): string[] {
	const invoked = new Set<string>();

	for (const [, raw = ''] of text.matchAll(SKILL_MENTION)) {
		const name = raw.toLowerCase();

		if (names.has(name)) invoked.add(name);
	}

	return [...invoked];
}
