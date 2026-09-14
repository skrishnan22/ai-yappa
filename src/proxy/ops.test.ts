import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import {
	digestParams,
	executeProxy,
	type AuditRecord,
	type OperationContext,
	type ProxyHandler,
} from './ops.ts';
import type { ProxyOp } from './policy.ts';

const CODE_CHANGE_CONTEXT: OperationContext = {
	conversationId: 'c1',
	submissionId: 's1',
	submissionType: 'code-change',
	repo: 'skrishnan22/codevil',
};

function stubHandlers(
	overrides?: Partial<Record<ProxyOp, ProxyHandler>>,
): Record<ProxyOp, ProxyHandler> {
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
	test('is a stable sha-256 hex of canonical operation params without an implicit repo', () => {
		expect(digestParams({ labels: ['bug'], number: 1 })).toBe(
			createHash('sha256').update('{"labels":["bug"],"number":1}').digest('hex'),
		);
	});
});

describe('executeProxy', () => {
	test('runs a code-change read and audits the canonical repo', async () => {
		const audit: AuditRecord[] = [];
		const result = await executeProxy({
			context: CODE_CHANGE_CONTEXT,
			op: 'readIssue',
			params: { number: 3 },
			now: 1_000_000,
			handlers: stubHandlers({ readIssue: async () => ({ title: 'Bug' }) }),
			audit: { append: (record) => audit.push(record) },
		});

		expect(result).toEqual({ ok: true, data: { title: 'Bug' } });
		expect(audit).toEqual([
			{
				ts: 1_000_000,
				conversationId: 'c1',
				submissionId: 's1',
				repo: 'skrishnan22/codevil',
				op: 'readIssue',
				paramsDigest: digestParams({ number: 3 }),
				outcome: 'ok',
				latencyMs: expect.any(Number),
			},
		]);
	});

	test('allows an investigation read', async () => {
		const result = await executeProxy({
			context: { ...CODE_CHANGE_CONTEXT, submissionType: 'investigation' },
			op: 'readRepoMetadata',
			params: {},
			now: 1_000_000,
			handlers: stubHandlers({ readRepoMetadata: async () => ({ fullName: 'org/repo' }) }),
			audit: { append: () => {} },
		});

		expect(result).toEqual({ ok: true, data: { fullName: 'org/repo' } });
	});

	test.each(['createBranch', 'vendPushToken'] as const)(
		'refuses an investigation %s before handler execution',
		async (op) => {
			const handler = vi.fn<ProxyHandler>();
			const audit: AuditRecord[] = [];
			const result = await executeProxy({
				context: { ...CODE_CHANGE_CONTEXT, submissionType: 'investigation' },
				op,
				params: {},
				now: 1_000_000,
				handlers: stubHandlers({ [op]: handler }),
				audit: { append: (record) => audit.push(record) },
			});

			expect(result).toEqual({
				ok: false,
				error: { kind: 'unauthorized', message: expect.stringMatching(/investigation/i) },
			});
			expect(handler).not.toHaveBeenCalled();
			expect(audit[0]?.outcome).toBe('unauthorized');
		},
	);

	test('canonicalizes a GitHub URL before handler execution', async () => {
		let received: OperationContext | undefined;
		await executeProxy({
			context: { ...CODE_CHANGE_CONTEXT, repo: 'https://github.com/skrishnan22/codevil.git' },
			op: 'readIssue',
			params: { number: 1 },
			now: 1_000_000,
			handlers: stubHandlers({
				readIssue: async ({ context }) => {
					received = context;
					return {};
				},
			}),
			audit: { append: () => {} },
		});

		expect(received?.repo).toBe('skrishnan22/codevil');
	});

	test('returns invalid and audits repo null for a malformed context repo', async () => {
		const audit: AuditRecord[] = [];
		const result = await executeProxy({
			context: { ...CODE_CHANGE_CONTEXT, repo: 'not a repo' },
			op: 'readIssue',
			params: { number: 1 },
			now: 1_000_000,
			handlers: stubHandlers(),
			audit: { append: (record) => audit.push(record) },
		});

		expect(result).toEqual({
			ok: false,
			error: { kind: 'invalid', message: expect.stringMatching(/repo/i) },
		});
		expect(audit[0]).toMatchObject({ outcome: 'invalid', repo: null });
	});

	test('audits upstream when the handler throws', async () => {
		const audit: AuditRecord[] = [];
		const result = await executeProxy({
			context: CODE_CHANGE_CONTEXT,
			op: 'readIssue',
			params: { number: 1 },
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
		expect(audit[0]).toMatchObject({ outcome: 'upstream', repo: 'skrishnan22/codevil' });
	});

	test('passes authoritative context and operation-specific params to the handler', async () => {
		const handler = vi.fn<ProxyHandler>().mockResolvedValue({ title: 'Bug' });
		await executeProxy({
			context: CODE_CHANGE_CONTEXT,
			op: 'readIssue',
			params: { number: 7 },
			now: 1_000_000,
			handlers: stubHandlers({ readIssue: handler }),
			audit: { append: () => {} },
		});

		expect(handler).toHaveBeenCalledWith({ context: CODE_CHANGE_CONTEXT, params: { number: 7 } });
		expect(handler.mock.calls[0]?.[0].params).not.toHaveProperty('repo');
	});
});
