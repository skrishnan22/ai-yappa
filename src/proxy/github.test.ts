import { describe, expect, test } from 'vitest';
import { githubHandlers, type GitHubPort } from './github.ts';

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
			return { status: 200, json: { full_name: 'skrishnan22/codevil', default_branch: 'main', html_url: 'https://github.com/skrishnan22/codevil' } };
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
			port.calls.filter((call) => call.kind === 'createInstallationToken').every((call) => {
				return call.permissions?.contents === 'write' && call.permissions.pull_requests === 'write';
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
		).rejects.toThrow(/404/);
	});
});
