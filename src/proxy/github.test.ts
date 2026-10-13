import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import * as v from 'valibot';
import { jsonValueSchema, type JsonValue } from '../json.ts';
import type { OperationContext } from './ops.ts';
import {
	createGitHubPort,
	githubHandlers,
	findInstallationRepository,
	listInstallationRepositories,
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
	| { kind: 'request'; method: string; path: string; body?: JsonValue; token: string };

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
		async request(input): Promise<{ status: number; json: JsonValue }> {
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
		const seen: { userAgent: string; body: JsonValue | null }[] = [];
		const original = globalThis.fetch;

		const fakeFetch: typeof fetch = async (_input, init) => {
			const rawBody = init?.body;
			let body: JsonValue | null = null;

			if (v.is(v.string(), rawBody)) {
				const parsed = JSON.parse(rawBody);
				body = v.is(jsonValueSchema, parsed) ? parsed : null;
			}

			seen.push({
				userAgent: new Headers(init?.headers).get('user-agent') ?? '',
				body,
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

describe('listInstallationRepositories', () => {
	const rsaPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
		.privateKey.export({ type: 'pkcs1', format: 'pem' })
		.toString();

	const env = {
		GITHUB_APP_ID: '1',
		GITHUB_APP_PRIVATE_KEY: rsaPem,
		GITHUB_APP_INSTALLATION_ID: '2',
	};

	test('pages through every repository with an unscoped token, then revokes it', async () => {
		const requests: { method: string; url: string; body: string | undefined }[] = [];
		const original = globalThis.fetch;
		const page1 = Array.from({ length: 100 }, (_, i) => ({ full_name: `acme/repo-${i}` }));

		const fakeFetch: typeof fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : input.toString();
			const method = init?.method ?? 'GET';
			requests.push({ method, url, body: v.is(v.string(), init?.body) ? init.body : undefined });

			if (url.endsWith('/access_tokens')) {
				return new Response(
					JSON.stringify({ token: 'ghs_list', expires_at: '2099-01-01T00:00:00Z' }),
					{ status: 201 },
				);
			}

			if (method === 'DELETE') return new Response(null, { status: 204 });

			const page = new URL(url).searchParams.get('page');
			const repositories = page === '1' ? page1 : [{ full_name: 'acme/api' }];

			return new Response(JSON.stringify({ repositories }), { status: 200 });
		};

		globalThis.fetch = fakeFetch;

		try {
			const names = await listInstallationRepositories(env);

			expect(names).toHaveLength(101);
			expect(names.at(-1)).toBe('acme/api');
			expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({ permissions: { metadata: 'read' } });
			expect(requests.map((request) => request.method)).toEqual(['POST', 'GET', 'GET', 'DELETE']);
		} finally {
			globalThis.fetch = original;
		}
	});

	test('names the missing GitHub App secrets', async () => {
		await expect(listInstallationRepositories({})).rejects.toThrow(/GITHUB_APP_ID/);
	});
});

describe('findInstallationRepository', () => {
	const rsaPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
		.privateKey.export({ type: 'pkcs1', format: 'pem' })
		.toString();

	const env = {
		GITHUB_APP_ID: '1',
		GITHUB_APP_PRIVATE_KEY: rsaPem,
		GITHUB_APP_INSTALLATION_ID: '2',
	};

	async function withMint<T>(
		mint: Response,
		body: () => Promise<T>,
	): Promise<{ result: T; requests: { method: string; body: string | undefined }[] }> {
		const requests: { method: string; body: string | undefined }[] = [];
		const original = globalThis.fetch;

		const fakeFetch: typeof fetch = async (_input, init) => {
			const method = init?.method ?? 'GET';
			requests.push({ method, body: v.is(v.string(), init?.body) ? init.body : undefined });

			return method === 'DELETE' ? new Response(null, { status: 204 }) : mint;
		};

		globalThis.fetch = fakeFetch;

		try {
			const result = await body();

			return { result, requests };
		} finally {
			globalThis.fetch = original;
		}
	}

	test('mints a token scoped to the repo and returns the installation spelling', async () => {
		const mint = new Response(
			JSON.stringify({
				token: 'ghs_check',
				expires_at: '2099-01-01T00:00:00Z',
				repositories: [{ full_name: 'Acme/API' }],
			}),
			{ status: 201 },
		);

		const { result, requests } = await withMint(mint, () =>
			findInstallationRepository('acme/api', env),
		);

		expect(result).toBe('Acme/API');

		expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
			repositories: ['api'],
			permissions: { metadata: 'read' },
		});

		expect(requests.map((request) => request.method)).toEqual(['POST', 'DELETE']);
	});

	test('returns undefined when GitHub refuses a repo outside the installation', async () => {
		const mint = new Response(JSON.stringify({ message: 'not accessible' }), { status: 422 });

		const { result, requests } = await withMint(mint, () =>
			findInstallationRepository('acme/nope', env),
		);

		expect(result).toBeUndefined();
		expect(requests.map((request) => request.method)).toEqual(['POST']);
	});

	test('returns undefined for the same name under another owner', async () => {
		const mint = new Response(
			JSON.stringify({
				token: 'ghs_check',
				expires_at: '2099-01-01T00:00:00Z',
				repositories: [{ full_name: 'acme/api' }],
			}),
			{ status: 201 },
		);

		const { result } = await withMint(mint, () => findInstallationRepository('other/api', env));

		expect(result).toBeUndefined();
	});

	test('surfaces other GitHub errors', async () => {
		const mint = new Response(JSON.stringify({ message: 'down' }), { status: 503 });
		await expect(withMint(mint, () => findInstallationRepository('acme/api', env))).rejects.toThrow(
			/503/,
		);
	});
});
