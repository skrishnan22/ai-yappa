import { describe, expect, test } from 'vitest';
import { generateCapabilityKeyPair, type ProxyOp } from '../proxy/capabilities.ts';
import type { ProxyHandler } from '../proxy/ops.ts';
import {
	liveOwner,
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
				exec: async (command) => ({
					stdout: command === 'git rev-parse HEAD' ? 'abc123\n' : '',
					stderr: '',
					exitCode: 0,
				}),
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

describe('liveOwner', () => {
	test('reuses GitHub handlers and keeps the caller audit sink', () => {
		const keys = generateCapabilityKeyPair();
		const previous = {
			CAPABILITY_PRIVATE_KEY: process.env.CAPABILITY_PRIVATE_KEY,
			CAPABILITY_PUBLIC_KEY: process.env.CAPABILITY_PUBLIC_KEY,
			CAPABILITY_KID: process.env.CAPABILITY_KID,
			GITHUB_APP_ID: process.env.GITHUB_APP_ID,
			GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
			GITHUB_APP_INSTALLATION_ID: process.env.GITHUB_APP_INSTALLATION_ID,
		};
		process.env.CAPABILITY_PRIVATE_KEY = keys.privateKeyPem;
		process.env.CAPABILITY_PUBLIC_KEY = keys.publicKeyPem;
		process.env.CAPABILITY_KID = keys.kid;
		process.env.GITHUB_APP_ID = '1';
		process.env.GITHUB_APP_PRIVATE_KEY = 'dummy';
		process.env.GITHUB_APP_INSTALLATION_ID = '2';
		try {
			const audit = { append: () => {} };
			const first = liveOwner({
				conversationId: 'c1',
				repo: 'https://github.com/skrishnan22/codevil.git',
				audit,
			});
			const second = liveOwner({
				conversationId: 'c1',
				repo: 'https://github.com/skrishnan22/codevil.git',
				audit,
			});
			expect(first.ok).toBe(true);
			expect(second.ok).toBe(true);
			if (!first.ok || !second.ok) return;
			expect(first.port).toBe(second.port);
			expect(first.ctx.handlers).toBe(second.ctx.handlers);
			expect(first.ctx.audit).toBe(audit);
		} finally {
			restoreEnv(previous);
		}
	});
});

function restoreEnv(previous: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
