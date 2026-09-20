import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { parsedOutput, type JsonValue } from '../json.ts';
import { checkpointWorkingBranch, workingBranchName, type ExecEnv } from '../proxy/checkpoint.ts';
import { createGitHubPort, githubHandlers } from '../proxy/github.ts';
import {
	executeProxy,
	type AuditSink,
	type OperationContext,
	type ProxyHandler,
} from '../proxy/ops.ts';
import { canonicalRepo, type ProxyOp } from '../proxy/policy.ts';

export type OwnerProxyCtx = OperationContext & {
	now: number;
	handlers: Record<ProxyOp, ProxyHandler>;
	audit: AuditSink;
};

export async function performReadIssue(
	ctx: OwnerProxyCtx,
	input: { number: number },
): Promise<PublicIssue> {
	return publicIssue(await executeOperation(ctx, 'readIssue', { number: input.number }));
}

export async function performReadRepo(ctx: OwnerProxyCtx): Promise<PublicRepo> {
	return publicRepo(await executeOperation(ctx, 'readRepoMetadata', {}));
}

export async function performCreateWorkingBranch(
	ctx: OwnerProxyCtx,
	input: { fromSha: string },
): Promise<PublicRef> {
	return publicRef(
		await executeOperation(ctx, 'createBranch', {
			name: workingBranchName(ctx.conversationId),
			fromSha: input.fromSha,
		}),
	);
}

export async function performOpenPullRequest(
	ctx: OwnerProxyCtx,
	input: { title: string; body: string; base: string },
): Promise<PublicPull> {
	const data = await executeOperation(ctx, 'createPullRequest', {
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
			options: { env: ExecEnv },
		) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
		revoke: (token: string) => Promise<void>;
	},
): Promise<{ branch: string; sha: string; htmlUrl: string }> {
	return checkpointWorkingBranch({
		context: operationContext(ctx),
		expectedSha: input.expectedSha,
		now: ctx.now,
		handlers: ctx.handlers,
		audit: ctx.audit,
		exec: io.exec,
		revoke: io.revoke,
	});
}

const issueNumber = v.pipe(
	v.union([v.number(), v.pipe(v.string(), v.transform(Number))]),
	v.integer(),
	v.minValue(1),
);

export function githubTools(args: { conversationId: string; repo: string; audit: AuditSink }) {
	return [
		defineTool({
			name: 'read_github_issue',
			description: 'Read one GitHub issue from the conversation repository.',
			input: v.object({ number: issueNumber }),
			async run({ data }) {
				return runGithubTool(args, (ready) => performReadIssue(ready.ctx, data));
			},
		}),
		defineTool({
			name: 'read_github_repo',
			description: 'Read metadata for the conversation repository.',
			async run() {
				return runGithubTool(args, (ready) => performReadRepo(ready.ctx));
			},
		}),
		defineTool({
			name: 'create_working_branch',
			description:
				'Create the deterministic working branch for this conversation from fromSha. The branch name is not chosen by the model.',
			input: v.object({ fromSha: v.pipe(v.string(), v.minLength(1)) }),
			async run({ data }) {
				return runGithubTool(args, (ready) => performCreateWorkingBranch(ready.ctx, data));
			},
		}),
		defineTool({
			name: 'open_pull_request',
			description: 'Open a pull request from this conversation working branch. Never merge.',
			input: v.object({
				title: v.pipe(v.string(), v.minLength(1)),
				body: v.string(),
				base: v.pipe(v.string(), v.minLength(1)),
			}),
			async run({ data }) {
				return runGithubTool(args, (ready) => performOpenPullRequest(ready.ctx, data));
			},
		}),
		defineTool({
			name: 'checkpoint_working_branch',
			description:
				'Push HEAD to the conversation working branch using a short-lived GitHub token. Do not git push with a token yourself.',
			input: v.object({ expectedSha: v.pipe(v.string(), v.minLength(1)) }),
			harness: true,
			async run({ data, harness }) {
				return runGithubTool(args, (ready) =>
					performCheckpoint(ready.ctx, data, {
						exec: (command, options) => harness.sandbox.exec(command, { env: options.env }),
						revoke: (token) => ready.port.revokeInstallationToken(token),
					}),
				);
			},
		}),
	];
}

async function runGithubTool<T>(
	args: { conversationId: string; repo: string; audit: AuditSink },
	run: (ready: Extract<ReturnType<typeof liveOwner>, { ok: true }>) => Promise<T>,
): Promise<{ output: T | { error: string } }> {
	const ready = liveOwner(args);

	if (!ready.ok) return { output: { error: ready.error } };

	try {
		return { output: await run(ready) };
	} catch (error) {
		return { output: { error: error instanceof Error ? error.message : 'GitHub tool failed' } };
	}
}

function executeOperation(ctx: OwnerProxyCtx, op: ProxyOp, params: JsonValue): Promise<JsonValue> {
	return executeAndUnwrap(ctx, op, params);
}

async function executeAndUnwrap(
	ctx: OwnerProxyCtx,
	op: ProxyOp,
	params: JsonValue,
): Promise<JsonValue> {
	const result = await executeProxy({
		context: operationContext(ctx),
		op,
		params,
		now: ctx.now,
		handlers: ctx.handlers,
		audit: ctx.audit,
	});

	if (!result.ok) throw new Error(result.error.message);

	return result.data;
}

function operationContext(ctx: OwnerProxyCtx): OperationContext {
	return {
		conversationId: ctx.conversationId,
		submissionId: ctx.submissionId,
		submissionType: ctx.submissionType,
		repo: ctx.repo,
	};
}

type PublicIssue = {
	number: number;
	title: string;
	state: string;
	htmlUrl: string;
	body: string | null;
};

type PublicRepo = {
	fullName: string;
	defaultBranch: string;
	htmlUrl: string;
};

type PublicRef = {
	ref: string;
	sha: string;
};

type PublicPull = {
	number: number;
	htmlUrl: string;
	head: string;
	base: string;
};

function publicIssue(data: JsonValue): PublicIssue {
	const parsed = parsedOutput(
		v.object({
			number: v.number(),
			title: v.string(),
			state: v.string(),
			htmlUrl: v.string(),
			body: v.optional(v.nullable(v.string())),
		}),
		data,
		'readIssue returned an unexpected payload',
	);

	return {
		number: parsed.number,
		title: parsed.title,
		state: parsed.state,
		htmlUrl: parsed.htmlUrl,
		body: parsed.body ?? null,
	};
}

function publicRepo(data: JsonValue): PublicRepo {
	return parsedOutput(
		v.object({
			fullName: v.string(),
			defaultBranch: v.string(),
			htmlUrl: v.string(),
		}),
		data,
		'readRepoMetadata returned an unexpected payload',
	);
}

function publicRef(data: JsonValue): PublicRef {
	return parsedOutput(
		v.object({
			ref: v.string(),
			sha: v.string(),
		}),
		data,
		'createBranch returned an unexpected payload',
	);
}

function publicPull(data: JsonValue): PublicPull {
	return parsedOutput(
		v.object({
			number: v.number(),
			htmlUrl: v.string(),
			head: v.string(),
			base: v.string(),
		}),
		data,
		'createPullRequest returned an unexpected payload',
	);
}

type GitHubRuntime = {
	port: ReturnType<typeof createGitHubPort>;
	handlers: Record<ProxyOp, ProxyHandler>;
};

let cachedGithub: GitHubRuntime | undefined;

export function liveOwner(args: {
	conversationId: string;
	repo: string;
	audit: AuditSink;
}):
	| { ok: true; ctx: OwnerProxyCtx; port: ReturnType<typeof createGitHubPort> }
	| { ok: false; error: string } {
	try {
		const github = githubRuntime();

		if (!github.ok) return github;

		return {
			ok: true,
			port: github.port,
			ctx: {
				conversationId: args.conversationId,
				submissionId: 'active',
				submissionType: 'code-change',
				repo: canonicalRepo(args.repo),
				now: Math.floor(Date.now() / 1000),
				handlers: github.handlers,
				audit: args.audit,
			},
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : 'GitHub tools are not configured',
		};
	}
}

function githubRuntime(): ({ ok: true } & GitHubRuntime) | { ok: false; error: string } {
	if (cachedGithub !== undefined) return { ok: true, ...cachedGithub };

	try {
		const port = createGitHubPort();
		cachedGithub = { port, handlers: githubHandlers(port) };

		return { ok: true, ...cachedGithub };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : 'GITHUB_* secrets are not configured',
		};
	}
}
