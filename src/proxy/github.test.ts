import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { OperationContext } from './ops.ts';
import {
	createGitHubPort,
	githubHandlers,
	normalizeGithubAppPrivateKey,
	type GitHubInstallationPermissions,
	type GitHubPort,
} from './github.ts';

type FakeCall =
	| {
			kind: 'createInstallationToken';
			repo: string;
			permissions: GitHubInstallationPermissions;
	  }
	| { kind: 'revoke' }
	| { kind: 'request'; method: string; path: string; body: unknown; token: string };

function fakePort(args?: {
	expiresAt?: (createCount: number) => string;
}): GitHubPort & { calls: FakeCall[]; readonly createCount: number } {
	const calls: FakeCall[] = [];
	let createCount = 0;
	return {
		calls,
		get createCount() {
			return createCount;
		},
		async createInstallationToken(input) {
			createCount += 1;
			calls.push({ kind: 'createInstallationToken', ...input });
			return {
				token: `ghs_${createCount}`,
				expiresAt: args?.expiresAt?.(createCount) ?? '2099-01-01T00:00:00.000Z',
			};
		},
		async revokeInstallationToken() {
			calls.push({ kind: 'revoke' });
		},
		async request(input) {
			calls.push({
				kind: 'request',
				method: input.method,
				path: input.path,
				body: input.body,
				token: input.token,
			});
			if (input.path.includes('/issues/')) {
				return {
					status: 200,
					json: {
						number: 3,
						title: 'Bug',
						state: 'open',
						html_url: 'https://github.com/skrishnan22/codevil/issues/3',
						body: 'x',
					},
				};
			}
			if (input.path.includes('/git/ref/')) {
				return {
					status: 200,
					json: { ref: 'refs/heads/agent/c1', object: { sha: 'abc' } },
				};
			}
			if (input.path.endsWith('/pulls')) {
				return {
					status: 201,
					json: {
						number: 9,
						html_url: 'https://github.com/skrishnan22/codevil/pull/9',
						head: { ref: 'agent/c1' },
						base: { ref: 'main' },
					},
				};
			}
			if (input.path.endsWith('/git/refs')) {
				return {
					status: 201,
					json: { ref: 'refs/heads/agent/c1', object: { sha: 'abc' } },
				};
			}
			return {
				status: 200,
				json: {
					full_name: input.path.replace('/repos/', ''),
					default_branch: 'main',
					html_url: `https://github.com${input.path.replace('/repos', '')}`,
				},
			};
		},
	};
}

function context(repo = 'skrishnan22/codevil'): OperationContext {
	return {
		conversationId: 'c1',
		submissionId: 's1',
		submissionType: 'code-change',
		repo,
	};
}

describe('githubHandlers', () => {
	test('maps a GitHub issue without returning its cached read token', async () => {
		const port = fakePort();
		const data = await githubHandlers(port).readIssue({
			context: context(),
			params: { number: 3 },
		});

		expect(data).toEqual({
			number: 3,
			title: 'Bug',
			state: 'open',
			htmlUrl: 'https://github.com/skrishnan22/codevil/issues/3',
			body: 'x',
		});
		expect(data).not.toHaveProperty('token');
		expect(port.calls[0]).toEqual({
			kind: 'createInstallationToken',
			repo: 'skrishnan22/codevil',
			permissions: { contents: 'read', issues: 'read', pull_requests: 'read' },
		});
	});

	test('reuses one valid read token across read operations for the same repo', async () => {
		const port = fakePort();
		const handlers = githubHandlers(port);
		await handlers.readIssue({ context: context(), params: { number: 3 } });
		await handlers.readRepoMetadata({ context: context(), params: {} });
		await handlers.readRef({ context: context(), params: { ref: 'heads/agent/c1' } });

		expect(port.createCount).toBe(1);
	});

	test('uses different cached read tokens for different repos', async () => {
		const port = fakePort();
		const handlers = githubHandlers(port);
		await handlers.readRepoMetadata({ context: context('one/repo'), params: {} });
		await handlers.readRepoMetadata({ context: context('two/repo'), params: {} });
		await handlers.readRepoMetadata({ context: context('one/repo'), params: {} });

		expect(port.createCount).toBe(2);
		expect(
			port.calls.filter((call) => call.kind === 'createInstallationToken').map((call) => call.repo),
		).toEqual(['one/repo', 'two/repo']);
	});

	test('refreshes a read token within the five-minute expiry skew', async () => {
		const now = 1_000_000;
		const port = fakePort({ expiresAt: () => new Date(now + 4 * 60 * 1000).toISOString() });
		const handlers = githubHandlers(port, () => now);
		await handlers.readRepoMetadata({ context: context(), params: {} });
		await handlers.readRepoMetadata({ context: context(), params: {} });

		expect(port.createCount).toBe(2);
	});

	test('reuses an exact trusted-write token for branch and pull-request creation', async () => {
		const port = fakePort();
		const handlers = githubHandlers(port);
		await handlers.createBranch({
			context: context(),
			params: { name: 'agent/c1', fromSha: 'abc' },
		});
		const pull = await handlers.createPullRequest({
			context: context(),
			params: { head: 'agent/c1', base: 'main', title: 'Fix', body: 'n' },
		});

		expect(port.createCount).toBe(1);
		expect(port.calls[0]).toEqual({
			kind: 'createInstallationToken',
			repo: 'skrishnan22/codevil',
			permissions: { contents: 'write', pull_requests: 'write' },
		});
		expect(pull).toEqual({
			number: 9,
			htmlUrl: 'https://github.com/skrishnan22/codevil/pull/9',
			head: 'agent/c1',
			base: 'main',
		});
		expect(pull).not.toHaveProperty('token');
	});

	test('creates a fresh exact contents-write token for every push request', async () => {
		const port = fakePort();
		const handlers = githubHandlers(port);
		const first = await handlers.vendPushToken({ context: context(), params: {} });
		const second = await handlers.vendPushToken({ context: context(), params: {} });

		expect(first).toEqual({ token: 'ghs_1', expiresAt: '2099-01-01T00:00:00.000Z' });
		expect(second).toEqual({ token: 'ghs_2', expiresAt: '2099-01-01T00:00:00.000Z' });
		expect(port.calls).toEqual([
			{
				kind: 'createInstallationToken',
				repo: 'skrishnan22/codevil',
				permissions: { contents: 'write' },
			},
			{
				kind: 'createInstallationToken',
				repo: 'skrishnan22/codevil',
				permissions: { contents: 'write' },
			},
		]);
	});

	test('uses the authoritative context repo rather than operation params', async () => {
		const port = fakePort();
		await githubHandlers(port).readIssue({
			context: context('trusted/repo'),
			params: { number: 3, repo: 'attacker/repo' },
		});

		expect(port.calls).toContainEqual({
			kind: 'request',
			method: 'GET',
			path: '/repos/trusted/repo/issues/3',
			body: undefined,
			token: 'ghs_1',
		});
	});

	test('throws mapped status errors without exposing a token', async () => {
		const port = fakePort();
		port.request = async () => ({ status: 404, json: { message: 'Not Found' } });
		await expect(
			githubHandlers(port).readRepoMetadata({ context: context(), params: {} }),
		).rejects.toThrow('GitHub 404: Not Found');
	});
});

describe('normalizeGithubAppPrivateKey', () => {
	const rsaPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
		.privateKey.export({ type: 'pkcs1', format: 'pem' })
		.toString();

	test('accepts escaped newlines and wrapping quotes', () => {
		const escaped = `"${rsaPem.replaceAll('\n', '\\n')}"`;
		const normalized = normalizeGithubAppPrivateKey(escaped);
		expect(normalized).toContain('BEGIN RSA PRIVATE KEY');
		expect(normalized).toContain('\n');
	});

	test('describes a non-RSA key only as an invalid GitHub App private key', () => {
		const otherKey = generateKeyPairSync('ed25519')
			.privateKey.export({ type: 'pkcs8', format: 'pem' })
			.toString();
		let message = '';
		try {
			normalizeGithubAppPrivateKey(otherKey);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toBe(
			'GITHUB_APP_PRIVATE_KEY must be the RSA .pem downloaded for the GitHub App.',
		);
	});

	test('rejects garbage with the GitHub App RSA guidance', () => {
		expect(() => normalizeGithubAppPrivateKey('not-a-key')).toThrow(
			/RSA \.pem downloaded for the GitHub App/i,
		);
	});
});

describe('createGitHubPort', () => {
	const rsaPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
		.privateKey.export({ type: 'pkcs1', format: 'pem' })
		.toString();

	test('requests a token for exactly one repository and sends a User-Agent', async () => {
		const seen: { userAgent: string; body: unknown }[] = [];
		const original = globalThis.fetch;
		const fakeFetch: typeof fetch = async (_input, init) => {
			seen.push({
				userAgent: new Headers(init?.headers).get('user-agent') ?? '',
				body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
			});
			return new Response(JSON.stringify({ token: 'ghs_x', expires_at: '2099-01-01T00:00:00Z' }), {
				status: 201,
			});
		};
		globalThis.fetch = fakeFetch;
		try {
			const port = createGitHubPort({
				GITHUB_APP_ID: '1',
				GITHUB_APP_PRIVATE_KEY: rsaPem,
				GITHUB_APP_INSTALLATION_ID: '2',
			});
			await port.createInstallationToken({
				repo: 'skrishnan22/codevil',
				permissions: { contents: 'write' },
			});
			expect(seen).toEqual([
				{
					userAgent: 'slack-agent',
					body: { repositories: ['codevil'], permissions: { contents: 'write' } },
				},
			]);
		} finally {
			globalThis.fetch = original;
		}
	});
});
