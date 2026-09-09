import { describe, expect, test } from 'vitest';
import { generateCapabilityKeyPair, type ProxyOp } from '../proxy/capabilities.ts';
import type { ProxyHandler } from '../proxy/ops.ts';
import {
	performCheckpoint,
	performCreateWorkingBranch,
	performOpenPullRequest,
	performReadIssue,
	type OwnerProxyCtx,
} from './github-tools.ts';

function refuse(): ProxyHandler {
	return async () => {
		throw new Error('handler not stubbed');
	};
}

function baseHandlers(overrides?: Partial<Record<ProxyOp, ProxyHandler>>): Record<ProxyOp, ProxyHandler> {
	return {
		readIssue: refuse(),
		readRepoMetadata: refuse(),
		readRef: refuse(),
		createBranch: refuse(),
		createPullRequest: refuse(),
		vendPushToken: refuse(),
		...overrides,
	};
}

function ctx(handlers: Record<ProxyOp, ProxyHandler>): OwnerProxyCtx {
	return {
		conversationId: 'c1',
		submissionId: 'active',
		submissionType: 'code-change',
		repo: 'https://github.com/skrishnan22/codevil.git',
		keys: generateCapabilityKeyPair(),
		now: 1_000_000,
		handlers,
		audit: { append: () => {} },
	};
}

describe('performReadIssue', () => {
	test('mints a readIssue-only token and forces the conversation repo', async () => {
		const seen: Array<{ allowedOps: ProxyOp[]; params: unknown }> = [];
		const result = await performReadIssue(
			ctx(
				baseHandlers({
					readIssue: async ({ claims, params }) => {
						seen.push({ allowedOps: claims.allowedOps, params });
						return {
							number: 3,
							title: 'Bug',
							state: 'open',
							htmlUrl: 'https://github.com/skrishnan22/codevil/issues/3',
							body: 'x',
						};
					},
				}),
			),
			{ number: 3 },
		);
		expect(seen).toEqual([
			{
				allowedOps: ['readIssue'],
				params: { repo: 'skrishnan22/codevil', number: 3 },
			},
		]);
		expect(result).toEqual({
			number: 3,
			title: 'Bug',
			state: 'open',
			htmlUrl: 'https://github.com/skrishnan22/codevil/issues/3',
			body: 'x',
		});
	});
});

describe('performOpenPullRequest', () => {
	test('returns htmlUrl and no token, with a deterministic head branch', async () => {
		const result = await performOpenPullRequest(
			ctx(
				baseHandlers({
					createPullRequest: async ({ params }) => ({
						number: 9,
						htmlUrl: 'https://github.com/skrishnan22/codevil/pull/9',
						head: isRecord(params) ? params.head : '',
						base: 'main',
						token: 'ghs_leaked',
					}),
				}),
			),
			{ title: 'Fix', body: 'n', base: 'main' },
		);
		expect(result).toEqual({
			number: 9,
			htmlUrl: 'https://github.com/skrishnan22/codevil/pull/9',
			head: 'agent/c1',
			base: 'main',
		});
		expect(result).not.toHaveProperty('token');
	});
});

describe('performCreateWorkingBranch', () => {
	test('ignores a model-supplied name and uses workingBranchName', async () => {
		let name: unknown;
		await performCreateWorkingBranch(
			ctx(
				baseHandlers({
					createBranch: async ({ params }) => {
						name = isRecord(params) ? params.name : undefined;
						return { ref: 'refs/heads/agent/c1', sha: 'abc' };
					},
				}),
			),
			{ fromSha: 'abc' },
		);
		expect(name).toBe('agent/c1');
	});
});

describe('performCheckpoint', () => {
	test('does not return a token', async () => {
		const result = await performCheckpoint(
			ctx(
				baseHandlers({
					readRef: async () => ({ ref: 'refs/heads/agent/c1', sha: 'abc123' }),
					vendPushToken: async () => ({
						token: 'ghs_test',
						expiresAt: '2099-01-01T00:00:00.000Z',
					}),
				}),
			),
			{ expectedSha: 'abc123' },
			{
				exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
				revoke: async () => {},
			},
		);
		expect(result).toEqual({
			branch: 'agent/c1',
			sha: 'abc123',
			htmlUrl: 'https://github.com/skrishnan22/codevil/tree/agent/c1',
		});
		expect(result).not.toHaveProperty('token');
	});
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
