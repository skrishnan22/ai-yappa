import { describe, expect, test } from 'vitest';
import { assertOpAllowed, canonicalRepo } from './policy.ts';

describe('canonicalRepo', () => {
	test('normalizes a github https url to owner/name', () => {
		expect(canonicalRepo('https://github.com/skrishnan22/codevil.git')).toBe('skrishnan22/codevil');
	});

	test('accepts owner/name', () => {
		expect(canonicalRepo('skrishnan22/codevil')).toBe('skrishnan22/codevil');
	});

	test('rejects a non-github host', () => {
		expect(() => canonicalRepo('https://gitlab.com/org/repo.git')).toThrow(/github/i);
	});
});

describe('assertOpAllowed', () => {
	test('allows investigation reads', () => {
		expect(() =>
			assertOpAllowed({ submissionType: 'investigation', op: 'readIssue' }),
		).not.toThrow();
	});

	test('refuses investigation writes', () => {
		expect(() => assertOpAllowed({ submissionType: 'investigation', op: 'createBranch' })).toThrow(
			/investigation/i,
		);
	});

	test('investigation cannot vend a push token', () => {
		expect(() => assertOpAllowed({ submissionType: 'investigation', op: 'vendPushToken' })).toThrow(
			/investigation/i,
		);
	});

	test('code-change can vend a push token', () => {
		expect(() =>
			assertOpAllowed({ submissionType: 'code-change', op: 'vendPushToken' }),
		).not.toThrow();
	});
});
