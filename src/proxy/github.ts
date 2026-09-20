import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import * as v from 'valibot';
import { jsonValueSchema, parsedOutput, type JsonValue } from '../json.ts';
import type { ProxyHandler } from './ops.ts';
import type { ProxyOp } from './policy.ts';

export type GitHubInstallationPermissions = {
	contents?: 'read' | 'write';
	issues?: 'read' | 'write';
	pull_requests?: 'read' | 'write';
};

export type GitHubPort = {
	createInstallationToken(args: {
		repo: string;
		permissions: GitHubInstallationPermissions;
	}): Promise<{ token: string; expiresAt: string }>;
	revokeInstallationToken(token: string): Promise<void>;
	request(args: {
		method: 'GET' | 'POST';
		path: string;
		body?: JsonValue;
		token: string;
	}): Promise<{ status: number; json: JsonValue }>;
};

const READ_PERMISSIONS = {
	contents: 'read',
	issues: 'read',
	pull_requests: 'read',
} as const;

const TRUSTED_WRITE_PERMISSIONS = {
	contents: 'write',
	pull_requests: 'write',
} as const;

const PUSH_PERMISSIONS = { contents: 'write' } as const;

const TOKEN_CACHE_SKEW_MS = 5 * 60 * 1000;

export function githubHandlers(
	port: GitHubPort,
	now: () => number = Date.now,
): Record<ProxyOp, ProxyHandler> {
	const reads = createTokenCache(port, READ_PERMISSIONS, now);
	const writes = createTokenCache(port, TRUSTED_WRITE_PERMISSIONS, now);

	return {
		readIssue: async ({ context, params }) => {
			const parsed = parseIssueParams(params);
			const token = await reads.get(context.repo);

			const json = await githubOk(
				await port.request({
					method: 'GET',
					path: `/repos/${context.repo}/issues/${parsed.number}`,
					token,
				}),
			);

			return mapIssue(json);
		},
		readRepoMetadata: async ({ context }) => {
			const token = await reads.get(context.repo);

			const json = await githubOk(
				await port.request({ method: 'GET', path: `/repos/${context.repo}`, token }),
			);

			return mapRepo(json);
		},
		readRef: async ({ context, params }) => {
			const parsed = parseRefParams(params);
			const token = await reads.get(context.repo);

			const json = await githubOk(
				await port.request({
					method: 'GET',
					path: `/repos/${context.repo}/git/ref/${parsed.gitRef}`,
					token,
				}),
			);

			return mapRef(json);
		},
		createBranch: async ({ context, params }) => {
			const parsed = parseBranchParams(params);
			const token = await writes.get(context.repo);

			const json = await githubOk(
				await port.request({
					method: 'POST',
					path: `/repos/${context.repo}/git/refs`,
					token,
					body: { ref: `refs/heads/${parsed.name}`, sha: parsed.fromSha },
				}),
			);

			return mapRef(json);
		},
		createPullRequest: async ({ context, params }) => {
			const parsed = parsePullParams(params);
			const token = await writes.get(context.repo);

			const json = await githubOk(
				await port.request({
					method: 'POST',
					path: `/repos/${context.repo}/pulls`,
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
		vendPushToken: async ({ context }) => {
			return port.createInstallationToken({ repo: context.repo, permissions: PUSH_PERMISSIONS });
		},
	};
}

export function createGitHubPort(env: NodeJS.ProcessEnv = process.env): GitHubPort {
	const appId = env.GITHUB_APP_ID;
	const pem = normalizeGithubAppPrivateKey(env.GITHUB_APP_PRIVATE_KEY);
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

function createTokenCache(
	port: GitHubPort,
	permissions: GitHubInstallationPermissions,
	now: () => number,
) {
	const cachedByRepo = new Map<string, { token: string; expiresAtMs: number }>();

	return {
		async get(repo: string): Promise<string> {
			const cached = cachedByRepo.get(repo);

			if (cached !== undefined && cached.expiresAtMs - TOKEN_CACHE_SKEW_MS > now()) {
				return cached.token;
			}

			const minted = await port.createInstallationToken({ repo, permissions });
			cachedByRepo.set(repo, {
				token: minted.token,
				expiresAtMs: Date.parse(minted.expiresAt),
			});

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

	try {
		const signature = createSign('RSA-SHA256').update(data).sign(args.privateKeyPem);

		return `${data}.${signature.toString('base64url')}`;
	} catch (error) {
		throw new Error(
			`GITHUB_APP_PRIVATE_KEY could not be used as an RSA GitHub App key: ${error instanceof Error ? error.message : 'unknown error'}`,
			{ cause: error },
		);
	}
}

export function normalizeGithubAppPrivateKey(raw: string | undefined): string | undefined {
	if (raw === undefined || raw.trim().length === 0) return undefined;
	let pem = raw.trim();

	if ((pem.startsWith('"') && pem.endsWith('"')) || (pem.startsWith("'") && pem.endsWith("'"))) {
		pem = pem.slice(1, -1).trim();
	}

	pem = pem.replaceAll('\\n', '\n').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
	const match = pem.match(/-----BEGIN ([A-Z ]+)-----([A-Za-z0-9+/=\s]+)-----END \1-----/);

	if (match === null || match[1] === undefined || match[2] === undefined) {
		throw new Error('GITHUB_APP_PRIVATE_KEY must be the RSA .pem downloaded for the GitHub App.');
	}

	const kind = match[1];
	const body = match[2].replace(/\s+/g, '');
	const lines = body.match(/.{1,64}/g) ?? [body];
	pem = `-----BEGIN ${kind}-----\n${lines.join('\n')}\n-----END ${kind}-----\n`;
	let key: KeyObject;

	try {
		key = createPrivateKey(pem);
	} catch (error) {
		throw new Error(
			`GITHUB_APP_PRIVATE_KEY failed to parse: ${error instanceof Error ? error.message : 'unknown error'}`,
			{ cause: error },
		);
	}

	if (key.asymmetricKeyType !== 'rsa') {
		throw new Error('GITHUB_APP_PRIVATE_KEY must be the RSA .pem downloaded for the GitHub App.');
	}

	return pem;
}

async function githubFetch(args: {
	method: 'GET' | 'POST' | 'DELETE';
	path: string;
	token: string;
	tokenType: 'Bearer';
	body?: JsonValue;
}): Promise<{ status: number; json: JsonValue }> {
	const headers = new Headers({
		accept: 'application/vnd.github+json',
		authorization: `${args.tokenType} ${args.token}`,
		'user-agent': 'slack-agent',
		'x-github-api-version': '2022-11-28',
	});

	if (args.body !== undefined) headers.set('content-type', 'application/json');

	const response = await fetch(`https://api.github.com${args.path}`, {
		method: args.method,
		headers,
		body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
	});

	if (response.status === 204) return { status: 204, json: null };
	const text = await response.text();
	let json: JsonValue = null;

	if (text.length > 0) {
		try {
			const parsed = JSON.parse(text);
			json = v.is(jsonValueSchema, parsed) ? parsed : { message: text };
		} catch {
			json = { message: text };
		}
	}

	return { status: response.status, json };
}

async function githubOk(response: { status: number; json: JsonValue }): Promise<JsonValue> {
	if (response.status < 200 || response.status >= 300) {
		throw new Error(githubStatusError(response.status, response.json));
	}

	return response.json;
}

type GithubIssue = {
	number: number;
	title: string;
	state: string;
	htmlUrl: string;
	body: string | null;
};

type GithubRepo = {
	fullName: string;
	defaultBranch: string;
	htmlUrl: string;
};

type GithubRef = {
	ref: string;
	sha: string;
};

type GithubPull = {
	number: number;
	htmlUrl: string;
	head: string;
	base: string;
};

type GithubToken = {
	token: string;
	expiresAt: string;
};

type IssueParams = {
	number: number;
};

type RefParams = {
	gitRef: string;
};

type BranchParams = {
	name: string;
	fromSha: string;
};

type PullParams = {
	head: string;
	base: string;
	title: string;
	body: string;
};

const githubErrorSchema = v.looseObject({
	message: v.optional(v.string()),
	errors: v.optional(v.array(v.looseObject({ message: v.optional(v.string()) }))),
});

function githubStatusError(status: number, json: JsonValue): string {
	const parts = [`GitHub ${status}`];
	const parsed = v.safeParse(githubErrorSchema, json);

	if (!parsed.success) return parts.join(': ');

	if (parsed.output.message !== undefined && parsed.output.message.length > 0) {
		parts.push(parsed.output.message);
	}

	for (const error of parsed.output.errors ?? []) {
		if (error.message !== undefined && error.message.length > 0) parts.push(error.message);
	}

	return parts.join(': ');
}

function parseIssueParams(params: JsonValue): IssueParams {
	return parsedOutput(
		v.object({ number: v.pipe(v.number(), v.integer()) }),
		params,
		'params.number is required',
	);
}

function parseRefParams(params: JsonValue): RefParams {
	const parsed = parsedOutput(
		v.object({ ref: v.pipe(v.string(), v.minLength(1)) }),
		params,
		'params.ref is required',
	);

	const gitRef = parsed.ref.startsWith('refs/') ? parsed.ref.slice('refs/'.length) : parsed.ref;

	return { gitRef };
}

function parseBranchParams(params: JsonValue): BranchParams {
	return parsedOutput(
		v.object({
			name: v.pipe(v.string(), v.minLength(1)),
			fromSha: v.pipe(v.string(), v.minLength(1)),
		}),
		params,
		'params.name and params.fromSha are required',
	);
}

function parsePullParams(params: JsonValue): PullParams {
	return parsedOutput(
		v.object({
			head: v.string(),
			base: v.string(),
			title: v.string(),
			body: v.string(),
		}),
		params,
		'params.head, base, title, and body are required',
	);
}

function mapIssue(json: JsonValue): GithubIssue {
	const parsed = parsedOutput(
		v.looseObject({
			number: v.number(),
			title: v.string(),
			state: v.string(),
			html_url: v.string(),
			body: v.optional(v.nullable(v.string())),
		}),
		json,
		'unexpected GitHub issue payload',
	);

	return {
		number: parsed.number,
		title: parsed.title,
		state: parsed.state,
		htmlUrl: parsed.html_url,
		body: parsed.body ?? null,
	};
}

function mapRepo(json: JsonValue): GithubRepo {
	const parsed = parsedOutput(
		v.looseObject({
			full_name: v.string(),
			default_branch: v.string(),
			html_url: v.string(),
		}),
		json,
		'unexpected GitHub repo payload',
	);

	return {
		fullName: parsed.full_name,
		defaultBranch: parsed.default_branch,
		htmlUrl: parsed.html_url,
	};
}

function mapRef(json: JsonValue): GithubRef {
	const parsed = parsedOutput(
		v.looseObject({
			ref: v.string(),
			object: v.looseObject({ sha: v.string() }),
		}),
		json,
		'unexpected GitHub ref payload',
	);

	return { ref: parsed.ref, sha: parsed.object.sha };
}

function mapPull(json: JsonValue): GithubPull {
	const parsed = parsedOutput(
		v.looseObject({
			number: v.number(),
			html_url: v.string(),
			head: v.looseObject({ ref: v.string() }),
			base: v.looseObject({ ref: v.string() }),
		}),
		json,
		'unexpected GitHub pull payload',
	);

	return {
		number: parsed.number,
		htmlUrl: parsed.html_url,
		head: parsed.head.ref,
		base: parsed.base.ref,
	};
}

function mapToken(json: JsonValue): GithubToken {
	const parsed = parsedOutput(
		v.looseObject({
			token: v.string(),
			expires_at: v.string(),
		}),
		json,
		'unexpected GitHub installation token payload',
	);

	return { token: parsed.token, expiresAt: parsed.expires_at };
}
