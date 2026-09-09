import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import {
	canonicalRepo,
	mintCapability,
	type CapabilityKeys,
	type ProxyOp,
	type SubmissionType,
} from '../proxy/capabilities.ts';
import { checkpointWorkingBranch, workingBranchName } from '../proxy/checkpoint.ts';
import { createGitHubPort, githubHandlers } from '../proxy/github.ts';
import { executeProxy, type AuditSink, type ProxyHandler } from '../proxy/ops.ts';

export type OwnerProxyCtx = {
	conversationId: string;
	submissionId: string;
	submissionType: SubmissionType;
	repo: string;
	keys: CapabilityKeys;
	now: number;
	handlers: Record<ProxyOp, ProxyHandler>;
	audit: AuditSink;
};

export async function performReadIssue(
	ctx: OwnerProxyCtx,
	input: { number: number },
): Promise<{
	number: number;
	title: string;
	state: string;
	htmlUrl: string;
	body: string | null;
}> {
	return publicIssue(await mintAndExecute(ctx, 'readIssue', { number: input.number }));
}

export async function performReadRepo(ctx: OwnerProxyCtx): Promise<{
	fullName: string;
	defaultBranch: string;
	htmlUrl: string;
}> {
	return publicRepo(await mintAndExecute(ctx, 'readRepoMetadata', {}));
}

export async function performCreateWorkingBranch(
	ctx: OwnerProxyCtx,
	input: { fromSha: string },
): Promise<{ ref: string; sha: string }> {
	return publicRef(
		await mintAndExecute(ctx, 'createBranch', {
			name: workingBranchName(ctx.conversationId),
			fromSha: input.fromSha,
		}),
	);
}

export async function performOpenPullRequest(
	ctx: OwnerProxyCtx,
	input: { title: string; body: string; base: string },
): Promise<{ number: number; htmlUrl: string; head: string; base: string }> {
	const data = await mintAndExecute(ctx, 'createPullRequest', {
		head: workingBranchName(ctx.conversationId),
		base: input.base,
		title: input.title,
		body: input.body,
	});
	return publicPull(data);
}

export async function performCheckpoint(
	ctx: OwnerProxyCtx,
	input: { expectedSha: string },
	io: {
		exec: (
			command: string,
			options: { env: Record<string, string> },
		) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
		revoke: (token: string) => Promise<void>;
	},
): Promise<{ branch: string; sha: string; htmlUrl: string }> {
	return checkpointWorkingBranch({
		conversationId: ctx.conversationId,
		submissionId: ctx.submissionId,
		submissionType: ctx.submissionType,
		repo: ctx.repo,
		expectedSha: input.expectedSha,
		keys: ctx.keys,
		now: ctx.now,
		handlers: ctx.handlers,
		audit: ctx.audit,
		exec: io.exec,
		revoke: io.revoke,
	});
}

export function githubTools(args: { conversationId: string; repo: string }) {
	return [
		defineTool({
			name: 'read_github_issue',
			description: 'Read one GitHub issue from the conversation repository.',
			input: v.object({ number: v.number() }),
			async run({ data }) {
				const ready = liveOwner(args);
				if (!ready.ok) return { output: { error: ready.error } };
				return { output: await performReadIssue(ready.ctx, data) };
			},
		}),
		defineTool({
			name: 'read_github_repo',
			description: 'Read metadata for the conversation repository.',
			async run() {
				const ready = liveOwner(args);
				if (!ready.ok) return { output: { error: ready.error } };
				return { output: await performReadRepo(ready.ctx) };
			},
		}),
		defineTool({
			name: 'create_working_branch',
			description:
				'Create the deterministic working branch for this conversation from fromSha. The branch name is not chosen by the model.',
			input: v.object({ fromSha: v.pipe(v.string(), v.minLength(1)) }),
			async run({ data }) {
				const ready = liveOwner(args);
				if (!ready.ok) return { output: { error: ready.error } };
				return { output: await performCreateWorkingBranch(ready.ctx, data) };
			},
		}),
		defineTool({
			name: 'open_pull_request',
			description:
				'Open a pull request from this conversation working branch. Never merge.',
			input: v.object({
				title: v.pipe(v.string(), v.minLength(1)),
				body: v.string(),
				base: v.pipe(v.string(), v.minLength(1)),
			}),
			async run({ data }) {
				const ready = liveOwner(args);
				if (!ready.ok) return { output: { error: ready.error } };
				return { output: await performOpenPullRequest(ready.ctx, data) };
			},
		}),
		defineTool({
			name: 'checkpoint_working_branch',
			description:
				'Push HEAD to the conversation working branch using a short-lived GitHub token. Do not git push with a token yourself.',
			input: v.object({ expectedSha: v.pipe(v.string(), v.minLength(1)) }),
			harness: true,
			async run({ data, harness }) {
				const ready = liveOwner(args);
				if (!ready.ok) return { output: { error: ready.error } };
				return {
					output: await performCheckpoint(ready.ctx, data, {
						exec: (command, options) => harness.sandbox.exec(command, { env: options.env }),
						revoke: (token) => ready.port.revokeInstallationToken(token),
					}),
				};
			},
		}),
	];
}

function mintAndExecute(
	ctx: OwnerProxyCtx,
	op: ProxyOp,
	params: Record<string, unknown>,
): Promise<unknown> {
	const repo = canonicalRepo(ctx.repo);
	return executeAndUnwrap(
		ctx,
		op,
		{ ...params, repo },
		mintCapability({
			keys: ctx.keys,
			now: ctx.now,
			claims: {
				conversationId: ctx.conversationId,
				submissionId: ctx.submissionId,
				submissionType: ctx.submissionType,
				repo,
				allowedOps: [op],
			},
		}),
	);
}

async function executeAndUnwrap(
	ctx: OwnerProxyCtx,
	op: ProxyOp,
	params: unknown,
	token: string,
): Promise<unknown> {
	const result = await executeProxy({
		token,
		keys: ctx.keys,
		op,
		params,
		now: ctx.now,
		handlers: ctx.handlers,
		audit: ctx.audit,
	});
	if (!result.ok) throw new Error(result.error.message);
	return result.data;
}

function publicIssue(data: unknown): {
	number: number;
	title: string;
	state: string;
	htmlUrl: string;
	body: string | null;
} {
	if (
		!isRecord(data) ||
		typeof data.number !== 'number' ||
		typeof data.title !== 'string' ||
		typeof data.state !== 'string' ||
		typeof data.htmlUrl !== 'string'
	) {
		throw new Error('readIssue returned an unexpected payload');
	}
	return {
		number: data.number,
		title: data.title,
		state: data.state,
		htmlUrl: data.htmlUrl,
		body: typeof data.body === 'string' ? data.body : null,
	};
}

function publicRepo(data: unknown): { fullName: string; defaultBranch: string; htmlUrl: string } {
	if (
		!isRecord(data) ||
		typeof data.fullName !== 'string' ||
		typeof data.defaultBranch !== 'string' ||
		typeof data.htmlUrl !== 'string'
	) {
		throw new Error('readRepoMetadata returned an unexpected payload');
	}
	return { fullName: data.fullName, defaultBranch: data.defaultBranch, htmlUrl: data.htmlUrl };
}

function publicRef(data: unknown): { ref: string; sha: string } {
	if (!isRecord(data) || typeof data.ref !== 'string' || typeof data.sha !== 'string') {
		throw new Error('createBranch returned an unexpected payload');
	}
	return { ref: data.ref, sha: data.sha };
}

function publicPull(data: unknown): {
	number: number;
	htmlUrl: string;
	head: string;
	base: string;
} {
	if (
		!isRecord(data) ||
		typeof data.number !== 'number' ||
		typeof data.htmlUrl !== 'string' ||
		typeof data.head !== 'string' ||
		typeof data.base !== 'string'
	) {
		throw new Error('createPullRequest returned an unexpected payload');
	}
	return { number: data.number, htmlUrl: data.htmlUrl, head: data.head, base: data.base };
}

function liveOwner(args: { conversationId: string; repo: string }):
	| { ok: true; ctx: OwnerProxyCtx; port: ReturnType<typeof createGitHubPort> }
	| { ok: false; error: string } {
	const keys = capabilityKeysFromEnv();
	if (keys === undefined) {
		return {
			ok: false,
			error: 'CAPABILITY_PRIVATE_KEY, CAPABILITY_PUBLIC_KEY, and CAPABILITY_KID are not configured.',
		};
	}
	let port: ReturnType<typeof createGitHubPort>;
	try {
		port = createGitHubPort();
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : 'GITHUB_* secrets are not configured',
		};
	}
	return {
		ok: true,
		port,
		ctx: {
			conversationId: args.conversationId,
			submissionId: 'active',
			submissionType: 'code-change',
			repo: args.repo,
			keys,
			now: Math.floor(Date.now() / 1000),
			handlers: githubHandlers(port),
			audit: { append: () => {} },
		},
	};
}

function capabilityKeysFromEnv(env: NodeJS.ProcessEnv = process.env): CapabilityKeys | undefined {
	const privateKeyPem = env.CAPABILITY_PRIVATE_KEY?.replace(/\\n/g, '\n');
	const publicKeyPem = env.CAPABILITY_PUBLIC_KEY?.replace(/\\n/g, '\n');
	const kid = env.CAPABILITY_KID;
	if (!privateKeyPem || !publicKeyPem || !kid) return undefined;
	return { kid, privateKeyPem, publicKeyPem };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
