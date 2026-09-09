import { describe, expect, test } from 'vitest';
import {
	assertOpAllowed,
	canonicalRepo,
	generateCapabilityKeyPair,
	mintCapability,
	verifyCapability,
} from './capabilities.ts';

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

describe('capability tokens', () => {
	test('round-trips a one-op token', () => {
		const keys = generateCapabilityKeyPair();
		const token = mintCapability({
			keys,
			now: 1_000_000,
			claims: {
				conversationId: 'c1',
				submissionId: 's1',
				submissionType: 'code-change',
				repo: 'skrishnan22/codevil',
				allowedOps: ['readIssue'],
			},
		});
		const verified = verifyCapability({ token, keys, now: 1_000_000 });
		expect(verified).toEqual({
			conversationId: 'c1',
			submissionId: 's1',
			submissionType: 'code-change',
			repo: 'skrishnan22/codevil',
			allowedOps: ['readIssue'],
			exp: 1_000_000 + 600,
			kid: keys.kid,
		});
	});

	test('rejects an expired token', () => {
		const keys = generateCapabilityKeyPair();
		const token = mintCapability({
			keys,
			now: 1_000_000,
			claims: {
				conversationId: 'c1',
				submissionId: 's1',
				submissionType: 'code-change',
				repo: 'skrishnan22/codevil',
				allowedOps: ['readIssue'],
			},
		});
		expect(() => verifyCapability({ token, keys, now: 1_000_000 + 601 })).toThrow(/expir/i);
	});

	test('rejects a token signed by a different key', () => {
		const a = generateCapabilityKeyPair();
		const b = generateCapabilityKeyPair();
		const token = mintCapability({
			keys: a,
			now: 1_000_000,
			claims: {
				conversationId: 'c1',
				submissionId: 's1',
				submissionType: 'code-change',
				repo: 'skrishnan22/codevil',
				allowedOps: ['readIssue'],
			},
		});
		expect(() => verifyCapability({ token, keys: b, now: 1_000_000 })).toThrow(/signat/i);
	});
});

describe('assertOpAllowed', () => {
	test('investigation cannot vend a push token', () => {
		expect(() => assertOpAllowed({ submissionType: 'investigation', op: 'vendPushToken' })).toThrow(
			/investigation/i,
		);
	});

	test('code-change can vend a push token', () => {
		expect(() => assertOpAllowed({ submissionType: 'code-change', op: 'vendPushToken' })).not.toThrow();
	});
});
