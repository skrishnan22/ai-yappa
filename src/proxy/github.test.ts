import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
	githubHandlers,
	normalizeGithubAppPrivateKey,
	createGitHubPort,
	type GitHubPort,
} from './github.ts';

type FakeCall = {
	kind: 'createInstallationToken' | 'revoke' | 'request';
	permissions?: { contents: string; pull_requests: string };
	method?: string;
	path?: string;
	body?: unknown;
};

function fakePort(): GitHubPort & { calls: FakeCall[]; createCount: number } {
	const calls: FakeCall[] = [];
	let createCount = 0;
	const port: GitHubPort & { calls: FakeCall[]; createCount: number } = {
		calls,
		get createCount() {
			return createCount;
		},
		async createInstallationToken(args) {
			createCount += 1;
			calls.push({ kind: 'createInstallationToken', permissions: args.permissions });
			return { token: `ghs_${createCount}`, expiresAt: '2099-01-01T00:00:00.000Z' };
		},
		async revokeInstallationToken() {
			calls.push({ kind: 'revoke' });
		},
		async request(args) {
			calls.push({ kind: 'request', method: args.method, path: args.path, body: args.body });
			if (args.path.includes('/issues/')) {
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
			if (args.path.endsWith('/pulls')) {
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
			if (args.path.endsWith('/git/refs')) {
				return {
					status: 201,
					json: { ref: 'refs/heads/agent/c1', object: { sha: 'abc' } },
				};
			}
			return {
				status: 200,
				json: {
					full_name: 'skrishnan22/codevil',
					default_branch: 'main',
					html_url: 'https://github.com/skrishnan22/codevil',
				},
			};
		},
	};
	return port;
}

const claims = {
	conversationId: 'c1',
	submissionId: 's1',
	submissionType: 'code-change' as const,
	repo: 'skrishnan22/codevil',
	allowedOps: ['readIssue' as const],
	exp: 1,
	kid: 'k',
};

describe('githubHandlers', () => {
	test('readIssue maps GitHub fields and uses a read token', async () => {
		const port = fakePort();
		const data = await githubHandlers(port).readIssue({
			claims,
			params: { repo: 'skrishnan22/codevil', number: 3 },
		});
		expect(data).toEqual({
			number: 3,
			title: 'Bug',
			state: 'open',
			htmlUrl: 'https://github.com/skrishnan22/codevil/issues/3',
			body: 'x',
		});
		expect(port.calls[0]).toEqual({
			kind: 'createInstallationToken',
			permissions: { contents: 'read', pull_requests: 'read' },
		});
		expect(port.calls[1]).toEqual({
			kind: 'request',
			method: 'GET',
			path: '/repos/skrishnan22/codevil/issues/3',
			body: undefined,
		});
	});

	test('createPullRequest returns htmlUrl and no token', async () => {
		const port = fakePort();
		const data = await githubHandlers(port).createPullRequest({
			claims,
			params: {
				repo: 'skrishnan22/codevil',
				head: 'agent/c1',
				base: 'main',
				title: 'Fix',
				body: 'n',
			},
		});
		expect(data).toEqual({
			number: 9,
			htmlUrl: 'https://github.com/skrishnan22/codevil/pull/9',
			head: 'agent/c1',
			base: 'main',
		});
		expect(data).not.toHaveProperty('token');
		expect(port.calls.some((call) => call.path === '/repos/skrishnan22/codevil/pulls')).toBe(true);
	});

	test('vendPushToken returns a write token and is not cached across calls', async () => {
		const port = fakePort();
		const handlers = githubHandlers(port);
		const first = await handlers.vendPushToken({
			claims,
			params: { repo: 'skrishnan22/codevil' },
		});
		const second = await handlers.vendPushToken({
			claims,
			params: { repo: 'skrishnan22/codevil' },
		});
		expect(first).toEqual({ token: 'ghs_1', expiresAt: '2099-01-01T00:00:00.000Z' });
		expect(second).toEqual({ token: 'ghs_2', expiresAt: '2099-01-01T00:00:00.000Z' });
		expect(port.createCount).toBe(2);
		expect(
			port.calls
				.filter((call) => call.kind === 'createInstallationToken')
				.every((call) => {
					return (
						call.permissions?.contents === 'write' && call.permissions.pull_requests === 'write'
					);
				}),
		).toBe(true);
	});

	test('readIssue reuses a cached installation token', async () => {
		const port = fakePort();
		const handlers = githubHandlers(port);
		await handlers.readIssue({ claims, params: { repo: 'skrishnan22/codevil', number: 3 } });
		await handlers.readIssue({ claims, params: { repo: 'skrishnan22/codevil', number: 3 } });
		expect(port.createCount).toBe(1);
	});

	test('non-2xx GitHub responses throw with the status', async () => {
		const port = fakePort();
		port.request = async () => ({ status: 404, json: { message: 'Not Found' } });
		await expect(
			githubHandlers(port).readRepoMetadata({ claims, params: { repo: 'skrishnan22/codevil' } }),
		).rejects.toThrow(/GitHub 404: Not Found/);
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

	test('rejects an Ed25519 capability key', () => {
		const ed = generateKeyPairSync('ed25519')
			.privateKey.export({ type: 'pkcs8', format: 'pem' })
			.toString();
		expect(() => normalizeGithubAppPrivateKey(ed)).toThrow(
			/Ed25519 belongs in CAPABILITY_PRIVATE_KEY/i,
		);
	});

	test('rejects garbage', () => {
		expect(() => normalizeGithubAppPrivateKey('not-a-key')).toThrow(/not a PEM/);
	});
});

describe('createGitHubPort', () => {
	const rsaPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
		.privateKey.export({ type: 'pkcs1', format: 'pem' })
		.toString();

	test('sends a User-Agent so GitHub does not 403 workerd fetch', async () => {
		const seen: string[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (_input, init) => {
			seen.push(new Headers(init?.headers).get('user-agent') ?? '');
			return new Response(JSON.stringify({ token: 'ghs_x', expires_at: '2099-01-01T00:00:00Z' }), {
				status: 201,
			});
		}) as typeof fetch;
		try {
			const port = createGitHubPort({
				GITHUB_APP_ID: '1',
				GITHUB_APP_PRIVATE_KEY: rsaPem,
				GITHUB_APP_INSTALLATION_ID: '2',
			});
			await port.createInstallationToken({
				repo: 'skrishnan22/codevil',
				permissions: { contents: 'write', pull_requests: 'write' },
			});
			expect(seen).toEqual(['slack-agent']);
		} finally {
			globalThis.fetch = original;
		}
	});
});
