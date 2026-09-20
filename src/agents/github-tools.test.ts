import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { JsonValue } from '../json.ts';
import type { ProxyHandler } from '../proxy/ops.ts';
import type { ProxyOp } from '../proxy/policy.ts';
import {
	githubTools,
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

function baseHandlers(
	overrides?: Partial<Record<ProxyOp, ProxyHandler>>,
): Record<ProxyOp, ProxyHandler> {
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
		now: 1_000_000,
		handlers,
		audit: { append: () => {} },
	};
}

describe('trusted GitHub operations', () => {
	test('passes the canonical context repo while operation params contain no repo', async () => {
		const seen: Array<{ op: ProxyOp; repo: string; params: JsonValue }> = [];

		const owner = ctx(
			baseHandlers({
				readIssue: async ({ context, params }) => {
					seen.push({ op: 'readIssue', repo: context.repo, params });

					return {
						number: 3,
						title: 'Bug',
						state: 'open',
						htmlUrl: 'https://github.com/skrishnan22/codevil/issues/3',
						body: 'x',
					};
				},
				createBranch: async ({ context, params }) => {
					seen.push({ op: 'createBranch', repo: context.repo, params });

					return { ref: 'refs/heads/agent/c1', sha: 'abc' };
				},
				createPullRequest: async ({ context, params }) => {
					seen.push({ op: 'createPullRequest', repo: context.repo, params });

					return {
						number: 9,
						htmlUrl: 'https://github.com/skrishnan22/codevil/pull/9',
						head: 'agent/c1',
						base: 'main',
					};
				},
			}),
		);

		await performReadIssue(owner, { number: 3 });
		await performCreateWorkingBranch(owner, { fromSha: 'abc' });
		await performOpenPullRequest(owner, { title: 'Fix', body: 'n', base: 'main' });

		expect(seen).toEqual([
			{ op: 'readIssue', repo: 'skrishnan22/codevil', params: { number: 3 } },
			{
				op: 'createBranch',
				repo: 'skrishnan22/codevil',
				params: { name: 'agent/c1', fromSha: 'abc' },
			},
			{
				op: 'createPullRequest',
				repo: 'skrishnan22/codevil',
				params: { head: 'agent/c1', base: 'main', title: 'Fix', body: 'n' },
			},
		]);
	});

	test('keeps normal mapped outputs free of handler-only fields', async () => {
		const issue = await performReadIssue(
			ctx(
				baseHandlers({
					readIssue: async () => ({
						number: 3,
						title: 'Bug',
						state: 'open',
						htmlUrl: 'https://github.com/skrishnan22/codevil/issues/3',
						body: 'x',
						token: 'ghs_hidden',
					}),
				}),
			),
			{ number: 3 },
		);

		expect(issue).toEqual({
			number: 3,
			title: 'Bug',
			state: 'open',
			htmlUrl: 'https://github.com/skrishnan22/codevil/issues/3',
			body: 'x',
		});
		expect(issue).not.toHaveProperty('token');
	});

	test('keeps the working branch deterministic from conversation id', async () => {
		let params: JsonValue | undefined;
		await performCreateWorkingBranch(
			ctx(
				baseHandlers({
					createBranch: async (input) => {
						params = input.params;

						return { ref: 'refs/heads/agent/c1', sha: 'abc' };
					},
				}),
			),
			{ fromSha: 'abc' },
		);

		expect(params).toEqual({ name: 'agent/c1', fromSha: 'abc' });
	});
});

describe('githubTools schemas', () => {
	test('expose only operation-specific model inputs', () => {
		const tools = githubTools({
			conversationId: 'c1',
			repo: 'skrishnan22/codevil',
			audit: { append: () => {} },
		});

		const keysByName = Object.fromEntries(
			tools.map((tool) => {
				const entries = tool.input?.entries;

				return [tool.name, entries === undefined ? [] : Object.keys(entries).toSorted()];
			}),
		);

		expect(keysByName).toEqual({
			read_github_issue: ['number'],
			read_github_repo: [],
			create_working_branch: ['fromSha'],
			open_pull_request: ['base', 'body', 'title'],
			checkpoint_working_branch: ['expectedSha'],
		});

		for (const keys of Object.values(keysByName)) {
			expect(keys).not.toEqual(
				expect.arrayContaining(['repo', 'head', 'token', 'permissions', 'url', 'headers']),
			);
		}
	});
});

describe('performCheckpoint', () => {
	test('returns no token after a confirmed checkpoint', async () => {
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

	test('does not expose a push token written by a failing process', async () => {
		const secret = 'ghs_secret';
		let message = '';

		try {
			await performCheckpoint(
				ctx(
					baseHandlers({
						vendPushToken: async () => ({
							token: secret,
							expiresAt: '2099-01-01T00:00:00.000Z',
						}),
					}),
				),
				{ expectedSha: 'abc123' },
				{
					exec: async (command) => ({
						stdout: command === 'git rev-parse HEAD' ? 'abc123\n' : secret,
						stderr: command === 'git rev-parse HEAD' ? '' : secret,
						exitCode: command === 'git rev-parse HEAD' ? 0 : 128,
					}),
					revoke: async () => {},
				},
			);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toBe('git push exited 128');
		expect(message).not.toContain(secret);
	});
});

describe('liveOwner', () => {
	test('returns a safe error when GitHub App configuration is missing', () => {
		const previous = saveEnv();
		delete process.env.GITHUB_APP_ID;
		delete process.env.GITHUB_APP_PRIVATE_KEY;
		delete process.env.GITHUB_APP_INSTALLATION_ID;

		try {
			const ready = liveOwner({
				conversationId: 'c1',
				repo: 'skrishnan22/codevil',
				audit: { append: () => {} },
			});

			expect(ready).toEqual({
				ok: false,
				error:
					'GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID are required.',
			});
		} finally {
			restoreEnv(previous);
		}
	});

	test('initializes and reuses GitHub handlers using only GitHub App configuration', () => {
		const previous = saveEnv();
		process.env.GITHUB_APP_ID = '1';
		process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
			.privateKey.export({ type: 'pkcs1', format: 'pem' })
			.toString();
		process.env.GITHUB_APP_INSTALLATION_ID = '2';

		try {
			const audit = { append: () => {} };
			const first = liveOwner({ conversationId: 'c1', repo: 'skrishnan22/codevil', audit });
			const second = liveOwner({ conversationId: 'c1', repo: 'skrishnan22/codevil', audit });
			expect(first.ok).toBe(true);
			expect(second.ok).toBe(true);

			if (!first.ok || !second.ok) return;
			expect(first.port).toBe(second.port);
			expect(first.ctx.handlers).toBe(second.ctx.handlers);
			expect(first.ctx.audit).toBe(audit);
			expect(first.ctx.repo).toBe('skrishnan22/codevil');
		} finally {
			restoreEnv(previous);
		}
	});
});

type GithubEnvSnapshot = {
	GITHUB_APP_ID: string | undefined;
	GITHUB_APP_PRIVATE_KEY: string | undefined;
	GITHUB_APP_INSTALLATION_ID: string | undefined;
};

function saveEnv(): GithubEnvSnapshot {
	return {
		GITHUB_APP_ID: process.env.GITHUB_APP_ID,
		GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
		GITHUB_APP_INSTALLATION_ID: process.env.GITHUB_APP_INSTALLATION_ID,
	};
}

function restoreEnv(previous: GithubEnvSnapshot): void {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}
