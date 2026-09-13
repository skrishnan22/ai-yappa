import { executeProxy, type AuditSink, type OperationContext, type ProxyHandler } from './ops.ts';
import { assertOpAllowed, canonicalRepo, type ProxyOp } from './policy.ts';

export type CheckpointExec = (
	command: string,
	options: { env: Record<string, string> },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export function workingBranchName(conversationId: string): string {
	const slug = conversationId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
	return `agent/${slug.length > 0 ? slug : 'thread'}`;
}

export async function checkpointWorkingBranch(args: {
	context: OperationContext;
	expectedSha: string;
	now: number;
	handlers: Record<ProxyOp, ProxyHandler>;
	audit: AuditSink;
	exec: CheckpointExec;
	revoke: (token: string) => Promise<void>;
}): Promise<{ branch: string; sha: string; htmlUrl: string }> {
	const repo = canonicalRepo(args.context.repo);
	const context = { ...args.context, repo };
	const branch = workingBranchName(context.conversationId);
	assertOpAllowed({ submissionType: context.submissionType, op: 'vendPushToken' });
	const localSha = await readLocalHead(args.exec);
	if (localSha !== args.expectedSha) {
		throw new Error(`local HEAD ${localSha} does not match expected ${args.expectedSha}`);
	}

	const minted = await executeProxy({
		context,
		op: 'vendPushToken',
		params: {},
		now: args.now,
		handlers: args.handlers,
		audit: args.audit,
	});
	if (!minted.ok) {
		throw new Error(minted.error.message);
	}
	const push = parseVend(minted.data);

	let result: { branch: string; sha: string; htmlUrl: string } | undefined;
	let checkpointError: unknown;
	try {
		const remoteUrl = `https://github.com/${repo}.git`;
		const refspec = `HEAD:refs/heads/${branch}`;
		const pushed = await args.exec(
			`git push --no-verify ${shellQuote(remoteUrl)} ${shellQuote(refspec)}`,
			{
				env: gitPushEnv(push.token),
			},
		);
		if (pushed.exitCode !== 0) {
			throw new Error(`git push exited ${pushed.exitCode}`);
		}
		const confirmed = await executeProxy({
			context,
			op: 'readRef',
			params: { ref: `refs/heads/${branch}` },
			now: args.now,
			handlers: args.handlers,
			audit: args.audit,
		});
		if (!confirmed.ok) {
			throw new Error(confirmed.error.message);
		}
		const remoteRef = parseRef(confirmed.data);
		if (remoteRef.sha !== args.expectedSha) {
			throw new Error(`remote sha ${remoteRef.sha} does not match expected ${args.expectedSha}`);
		}
		result = {
			branch,
			sha: args.expectedSha,
			htmlUrl: `https://github.com/${repo}/tree/${branch}`,
		};
	} catch (error) {
		checkpointError = error;
	}

	try {
		await args.revoke(push.token);
	} catch {
		const revokeMessage = 'failed to revoke push token';
		if (checkpointError !== undefined) {
			throw new Error(`${errorMessage(checkpointError)}; ${revokeMessage}`);
		}
		throw new Error(revokeMessage);
	}
	if (checkpointError !== undefined) {
		throw checkpointError;
	}
	if (result === undefined) {
		throw new Error('checkpoint returned no result');
	}
	return result;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function gitPushEnv(token: string): Record<string, string> {
	// GitHub git-over-HTTPS wants Basic x-access-token, not a REST Bearer header.
	const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
	return {
		GIT_CONFIG_COUNT: '2',
		GIT_CONFIG_KEY_0: 'http.extraHeader',
		GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
		GIT_CONFIG_KEY_1: 'http.followRedirects',
		GIT_CONFIG_VALUE_1: 'false',
		GIT_TERMINAL_PROMPT: '0',
	};
}

async function readLocalHead(exec: CheckpointExec): Promise<string> {
	const head = await exec('git rev-parse HEAD', { env: {} });
	if (head.exitCode !== 0) {
		throw new Error(head.stderr || `git rev-parse HEAD exited ${head.exitCode}`);
	}
	const sha = head.stdout.trim();
	if (sha.length === 0) {
		throw new Error('git rev-parse HEAD returned an empty sha');
	}
	return sha;
}

function parseVend(data: unknown): { token: string; expiresAt: string } {
	if (!isRecord(data) || typeof data.token !== 'string' || typeof data.expiresAt !== 'string') {
		throw new Error('vendPushToken returned an unexpected payload');
	}
	return { token: data.token, expiresAt: data.expiresAt };
}

function parseRef(data: unknown): { sha: string } {
	if (!isRecord(data) || typeof data.sha !== 'string') {
		throw new Error('readRef returned an unexpected payload');
	}
	return { sha: data.sha };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'unknown error';
}
