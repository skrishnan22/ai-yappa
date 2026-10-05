import { describe, expect, test } from 'vitest';
import { invokedSkills } from './invocation.ts';

const names = new Set(['grill-me', 'review']);

describe('invokedSkills', () => {
	test.each([
		['a bare invocation', '<@U1> /grill-me', ['grill-me']],
		['punctuation and case', "<@U1> let's /Grill-Me.", ['grill-me']],
		[
			'several skills and a repeat',
			'<@U1> /grill-me then /review, /grill-me',
			['grill-me', 'review'],
		],
		['paths and URLs', '<@U1> see /usr/bin, https://x.dev/grill-me and /grill-me/notes', []],
		['an unknown name', '<@U1> run /deploy now', []],
		['a code span', '<@U1> type `/grill-me` to start', []],
	])('reads %s', (_case, text, expected) => {
		expect(invokedSkills(text, names)).toEqual(expected);
	});
});
