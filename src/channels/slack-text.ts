// Slack mrkdwn renders line breaks only where the payload contains newlines.
// Model-authored replies occasionally arrive as one unbroken line, which
// Slack then shows as a single blob. Rather than rely on the model's
// formatting, split a newline-free reply into paragraphs at sentence
// boundaries before posting.

const TERMINALS = new Set(['.', '!', '?']);

// Punctuation that cannot start the next sentence.
const SENTENCE_CLOSERS = new Set([',', ';', ':', '.', '!', '?', ')', ']', '}']);

const ABBREVIATIONS = new Set([
	'e.g.',
	'i.e.',
	'vs.',
	'etc.',
	'et al.',
	'mr.',
	'mrs.',
	'ms.',
	'dr.',
	'prof.',
	'st.',
	'u.s.',
	'u.k.',
	'a.m.',
	'p.m.',
	'fig.',
	'no.',
	'vol.',
]);

// A split is only worth it for a substantial first paragraph; the guard also
// keeps initials and short fragments from fragmenting the text.
const MIN_HEAD_CHARS = 40;

function endsAbbreviation(text: string, index: number): boolean {
	if (index === 0) return false;

	const previous = text[index - 1]!;
	const beforePrevious = text[index - 2];

	// "U.S." and single initials: a lone uppercase letter before the period.
	if (
		/[A-Z]/.test(previous) &&
		(beforePrevious === undefined || !/[A-Za-z]/.test(beforePrevious))
	) {
		return true;
	}

	const token = text.slice(Math.max(0, index - 8), index + 1).toLowerCase();

	for (const abbreviation of ABBREVIATIONS) {
		if (token.endsWith(abbreviation)) return true;
	}

	return false;
}

function startsSentence(character: string): boolean {
	if (/[a-z]/.test(character)) return false;

	return !SENTENCE_CLOSERS.has(character) && character !== ' ';
}

/**
 * Give a newline-free reply a deterministic layout: split it into paragraphs
 * at sentence boundaries. Text that already contains line breaks, or that
 * holds no detectable sentence boundary, is returned unchanged.
 */
export function ensureParagraphBreaks(text: string): string {
	if (text.includes('\n')) return text;

	const paragraphs: string[] = [];
	let start = 0;
	let index = 0;

	while (index < text.length - 1) {
		const character = text[index]!;

		if (!TERMINALS.has(character)) {
			index += 1;
			continue;
		}

		// A boundary needs terminal punctuation, a space, then a sentence
		// starter. "5.27", "17:30", and "e.g." never match all three.
		if (text[index + 1] !== ' ') {
			index += 1;
			continue;
		}

		let next = index + 1;

		while (next < text.length && text[next] === ' ') next += 1;

		if (next >= text.length) break;

		if (endsAbbreviation(text, index) || !startsSentence(text[next]!)) {
			index += 1;
			continue;
		}

		const head = text.slice(start, index + 1).trim();

		if (head.length < MIN_HEAD_CHARS) {
			index += 1;
			continue;
		}

		paragraphs.push(head);
		start = next;
		index = next;
	}

	const tail = text.slice(start).trim();

	if (tail) paragraphs.push(tail);

	if (paragraphs.length <= 1) return text;

	return paragraphs.join('\n\n');
}
