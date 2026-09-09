import { createSign } from 'node:crypto';
import type { ProxyHandler } from './ops.ts';
import type { ProxyOp } from './capabilities.ts';

export type GitHubPort = {
	createInstallationToken(args: {
		repo: string;
		permissions: { contents: 'read' | 'write'; pull_requests: 'read' | 'write' };
	}): Promise<{ token: string; expiresAt: string }>;
	revokeInstallationToken(token: string): Promise<void>;
	request(args: {
		method: 'GET' | 'POST';
		path: string;
		body?: unknown;
		token: string;
	}): Promise<{ status: number; json: unknown }>;
};

const READ_PERMISSIONS = { contents: 'read', pull_requests: 'read' } as const;
const WRITE_PERMISSIONS = { contents: 'write', pull_requests: 'write' } as const;
const READ_CACHE_SKEW_MS = 5 * 60 * 1000;

export function githubHandlers(port: GitHubPort): Record<ProxyOp, ProxyHandler> {
	const reads = createReadTokenCache(port);
	return {
		readIssue: async ({ params }) => {
			const parsed = parseIssueParams(params);
			const token = await reads.get(parsed.repo);
			const json = await githubOk(
				await port.request({
					method: 'GET',
					path: `/repos/${parsed.repo}/issues/${parsed.number}`,
					token,
				}),
			);
			return mapIssue(json);
		},
		readRepoMetadata: async ({ params }) => {
			const repo = requireRepo(params);
			const token = await reads.get(repo);
			const json = await githubOk(
				await port.request({ method: 'GET', path: `/repos/${repo}`, token }),
			);
			return mapRepo(json);
		},
		readRef: async ({ params }) => {
			const parsed = parseRefParams(params);
			const token = await reads.get(parsed.repo);
			const json = await githubOk(
				await port.request({
					method: 'GET',
					path: `/repos/${parsed.repo}/git/ref/${parsed.gitRef}`,
					token,
				}),
			);
			return mapRef(json);
		},
		createBranch: async ({ params }) => {
			const parsed = parseBranchParams(params);
			const { token } = await port.createInstallationToken({
				repo: parsed.repo,
				permissions: WRITE_PERMISSIONS,
			});
			const json = await githubOk(
				await port.request({
					method: 'POST',
					path: `/repos/${parsed.repo}/git/refs`,
					token,
					body: { ref: `refs/heads/${parsed.name}`, sha: parsed.fromSha },
				}),
			);
			return mapRef(json);
		},
		createPullRequest: async ({ params }) => {
			const parsed = parsePullParams(params);
			const { token } = await port.createInstallationToken({
				repo: parsed.repo,
				permissions: WRITE_PERMISSIONS,
			});
			const json = await githubOk(
				await port.request({
					method: 'POST',
					path: `/repos/${parsed.repo}/pulls`,
					token,
					body: {
						head: parsed.head,
						base: parsed.base,
						title: parsed.title,
						body: parsed.body,
					},
				}),
			);
			return mapPull(json);
		},
		vendPushToken: async ({ params }) => {
			const repo = requireRepo(params);
			return port.createInstallationToken({ repo, permissions: WRITE_PERMISSIONS });
		},
	};
}

export function createGitHubPort(env: NodeJS.ProcessEnv = process.env): GitHubPort {
	const appId = env.GITHUB_APP_ID;
	const pem = env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
	const installationId = env.GITHUB_APP_INSTALLATION_ID;
	if (!appId || !pem || !installationId) {
		throw new Error(
			'GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID are required.',
		);
	}

	return {
		async createInstallationToken(args) {
			const name = args.repo.split('/')[1];
			if (name === undefined) throw new Error(`invalid repo ${args.repo}`);
			const jwt = signAppJwt({ appId, privateKeyPem: pem, now: Math.floor(Date.now() / 1000) });
			const response = await githubFetch({
				method: 'POST',
				path: `/app/installations/${installationId}/access_tokens`,
				token: jwt,
				tokenType: 'Bearer',
				body: { repositories: [name], permissions: args.permissions },
			});
			const json = await githubOk(response);
			return mapToken(json);
		},
		async revokeInstallationToken(token) {
			const response = await githubFetch({
				method: 'DELETE',
				path: '/installation/token',
				token,
				tokenType: 'Bearer',
			});
			if (response.status !== 204 && response.status !== 200) {
				throw new Error(`GitHub ${response.status} while revoking installation token`);
			}
		},
		async request(args) {
			return githubFetch({
				method: args.method,
				path: args.path,
				token: args.token,
				tokenType: 'Bearer',
				body: args.body,
			});
		},
	};
}

function createReadTokenCache(port: GitHubPort) {
	let cached: { repo: string; token: string; expiresAtMs: number } | undefined;
	return {
		async get(repo: string): Promise<string> {
			if (
				cached !== undefined &&
				cached.repo === repo &&
				cached.expiresAtMs - READ_CACHE_SKEW_MS > Date.now()
			) {
				return cached.token;
			}
			const minted = await port.createInstallationToken({ repo, permissions: READ_PERMISSIONS });
			cached = {
				repo,
				token: minted.token,
				expiresAtMs: Date.parse(minted.expiresAt),
			};
			return minted.token;
		},
	};
}

function signAppJwt(args: { appId: string; privateKeyPem: string; now: number }): string {
	const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
	const payload = Buffer.from(
		JSON.stringify({ iat: args.now - 60, exp: args.now + 540, iss: args.appId }),
	).toString('base64url');
	const data = `${header}.${payload}`;
	const signature = createSign('RSA-SHA256').update(data).sign(args.privateKeyPem);
	return `${data}.${signature.toString('base64url')}`;
}

async function githubFetch(args: {
	method: 'GET' | 'POST' | 'DELETE';
	path: string;
	token: string;
	tokenType: 'Bearer';
	body?: unknown;
}): Promise<{ status: number; json: unknown }> {
	const response = await fetch(`https://api.github.com${args.path}`, {
		method: args.method,
		headers: {
			accept: 'application/vnd.github+json',
			authorization: `${args.tokenType} ${args.token}`,
			'x-github-api-version': '2022-11-28',
			...(args.body !== undefined ? { 'content-type': 'application/json' } : {}),
		},
		body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
	});
	if (response.status === 204) return { status: 204, json: null };
	const text = await response.text();
	let json: unknown = null;
	if (text.length > 0) {
		try {
			json = JSON.parse(text) as unknown;
		} catch {
			json = { message: text };
		}
	}
	return { status: response.status, json };
}

async function githubOk(response: { status: number; json: unknown }): Promise<unknown> {
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`GitHub ${response.status}`);
	}
	return response.json;
}

function requireRepo(params: unknown): string {
	if (!isRecord(params) || typeof params.repo !== 'string') {
		throw new Error('params.repo is required');
	}
	return params.repo;
}

function parseIssueParams(params: unknown): { repo: string; number: number } {
	const repo = requireRepo(params);
	if (!isRecord(params) || typeof params.number !== 'number' || !Number.isInteger(params.number)) {
		throw new Error('params.number is required');
	}
	return { repo, number: params.number };
}

function parseRefParams(params: unknown): { repo: string; gitRef: string } {
	const repo = requireRepo(params);
	if (!isRecord(params) || typeof params.ref !== 'string' || params.ref.length === 0) {
		throw new Error('params.ref is required');
	}
	const gitRef = params.ref.startsWith('refs/') ? params.ref.slice('refs/'.length) : params.ref;
	return { repo, gitRef };
}

function parseBranchParams(params: unknown): { repo: string; name: string; fromSha: string } {
	const repo = requireRepo(params);
	if (
		!isRecord(params) ||
		typeof params.name !== 'string' ||
		typeof params.fromSha !== 'string' ||
		params.name.length === 0 ||
		params.fromSha.length === 0
	) {
		throw new Error('params.name and params.fromSha are required');
	}
	return { repo, name: params.name, fromSha: params.fromSha };
}

function parsePullParams(params: unknown): {
	repo: string;
	head: string;
	base: string;
	title: string;
	body: string;
} {
	const repo = requireRepo(params);
	if (
		!isRecord(params) ||
		typeof params.head !== 'string' ||
		typeof params.base !== 'string' ||
		typeof params.title !== 'string' ||
		typeof params.body !== 'string'
	) {
		throw new Error('params.head, base, title, and body are required');
	}
	return {
		repo,
		head: params.head,
		base: params.base,
		title: params.title,
		body: params.body,
	};
}

function mapIssue(json: unknown): {
	number: number;
	title: string;
	state: string;
	htmlUrl: string;
	body: string | null;
} {
	if (
		!isRecord(json) ||
		typeof json.number !== 'number' ||
		typeof json.title !== 'string' ||
		typeof json.state !== 'string' ||
		typeof json.html_url !== 'string'
	) {
		throw new Error('unexpected GitHub issue payload');
	}
	return {
		number: json.number,
		title: json.title,
		state: json.state,
		htmlUrl: json.html_url,
		body: typeof json.body === 'string' ? json.body : null,
	};
}

function mapRepo(json: unknown): { fullName: string; defaultBranch: string; htmlUrl: string } {
	if (
		!isRecord(json) ||
		typeof json.full_name !== 'string' ||
		typeof json.default_branch !== 'string' ||
		typeof json.html_url !== 'string'
	) {
		throw new Error('unexpected GitHub repo payload');
	}
	return { fullName: json.full_name, defaultBranch: json.default_branch, htmlUrl: json.html_url };
}

function mapRef(json: unknown): { ref: string; sha: string } {
	if (!isRecord(json) || typeof json.ref !== 'string' || !isRecord(json.object) || typeof json.object.sha !== 'string') {
		throw new Error('unexpected GitHub ref payload');
	}
	return { ref: json.ref, sha: json.object.sha };
}

function mapPull(json: unknown): { number: number; htmlUrl: string; head: string; base: string } {
	if (
		!isRecord(json) ||
		typeof json.number !== 'number' ||
		typeof json.html_url !== 'string' ||
		!isRecord(json.head) ||
		typeof json.head.ref !== 'string' ||
		!isRecord(json.base) ||
		typeof json.base.ref !== 'string'
	) {
		throw new Error('unexpected GitHub pull payload');
	}
	return { number: json.number, htmlUrl: json.html_url, head: json.head.ref, base: json.base.ref };
}

function mapToken(json: unknown): { token: string; expiresAt: string } {
	if (!isRecord(json) || typeof json.token !== 'string' || typeof json.expires_at !== 'string') {
		throw new Error('unexpected GitHub installation token payload');
	}
	return { token: json.token, expiresAt: json.expires_at };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
