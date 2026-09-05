import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { generateCapabilityKeyPair, mintCapability, type ProxyOp } from './capabilities.ts';
import { digestParams, executeProxy, type AuditRecord, type ProxyHandler } from './ops.ts';

function stubHandlers(overrides?: Partial<Record<ProxyOp, ProxyHandler>>): Record<ProxyOp, ProxyHandler> {
	const refuse: ProxyHandler = async () => {
		throw new Error('handler not stubbed');
	};
	return {
		readIssue: refuse,
		readRepoMetadata: refuse,
		readRef: refuse,
		createBranch: refuse,
		createPullRequest: refuse,
		vendPushToken: refuse,
		...overrides,
	};
}

describe('digestParams', () => {
	test('is a stable sha-256 hex of canonical JSON', () => {
		expect(digestParams({ repo: 'skrishnan22/codevil', number: 1 })).toBe(
			createHash('sha256').update('{"number":1,"repo":"skrishnan22/codevil"}').digest('hex'),
		);
	});
});

describe('executeProxy', () => {
	test('runs a matching one-op token and audits ok', async () => {
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
		const audit: AuditRecord[] = [];
		const result = await executeProxy({
			token,
			keys,
			op: 'readIssue',
			params: { repo: 'https://github.com/skrishnan22/codevil.git', number: 3 },
			now: 1_000_000,
			handlers: stubHandlers({
				readIssue: async () => ({ title: 'Bug' }),
			}),
			audit: { append: (record) => audit.push(record) },
		});
		expect(result).toEqual({ ok: true, data: { title: 'Bug' } });
		expect(audit).toEqual([
			{
				ts: 1_000_000,
				conversationId: 'c1',
				submissionId: 's1',
				op: 'readIssue',
				paramsDigest: digestParams({
					repo: 'https://github.com/skrishnan22/codevil.git',
					number: 3,
				}),
				outcome: 'ok',
				latencyMs: expect.any(Number),
			},
		]);
	});

	test('refuses an op outside the token allowedOps', async () => {
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
		const audit: AuditRecord[] = [];
		const result = await executeProxy({
			token,
			keys,
			op: 'vendPushToken',
			params: { repo: 'skrishnan22/codevil' },
			now: 1_000_000,
			handlers: stubHandlers(),
			audit: { append: (record) => audit.push(record) },
		});
		expect(result).toEqual({
			ok: false,
			error: { kind: 'unauthorized', message: expect.stringMatching(/allowedOps|vendPushToken/i) },
		});
		expect(audit[0]?.outcome).toBe('unauthorized');
	});

	test('refuses a params repo that does not match the capability', async () => {
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
		const result = await executeProxy({
			token,
			keys,
			op: 'readIssue',
			params: { repo: 'other/other', number: 1 },
			now: 1_000_000,
			handlers: stubHandlers({
				readIssue: async () => ({ title: 'nope' }),
			}),
			audit: { append: () => {} },
		});
		expect(result).toEqual({
			ok: false,
			error: { kind: 'unauthorized', message: expect.stringMatching(/repo/i) },
		});
	});

	test('audits upstream when the handler throws', async () => {
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
		const audit: AuditRecord[] = [];
		const result = await executeProxy({
			token,
			keys,
			op: 'readIssue',
			params: { repo: 'skrishnan22/codevil', number: 1 },
			now: 1_000_000,
			handlers: stubHandlers({
				readIssue: async () => {
					throw new Error('GitHub 502');
				},
			}),
			audit: { append: (record) => audit.push(record) },
		});
		expect(result).toEqual({
			ok: false,
			error: { kind: 'upstream', message: 'GitHub 502' },
		});
		expect(audit[0]?.outcome).toBe('upstream');
	});
});
