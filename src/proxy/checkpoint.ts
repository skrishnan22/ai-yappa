import {
	assertOpAllowed,
	canonicalRepo,
	mintCapability,
	type CapabilityKeys,
	type ProxyOp,
	type SubmissionType,
} from './capabilities.ts';
import { executeProxy, type AuditSink, type ProxyHandler } from './ops.ts';

export type CheckpointExec = (
	command: string,
	options: { env: Record<string, string> },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export function workingBranchName(conversationId: string): string {
	const slug = conversationId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
	return `agent/${slug.length > 0 ? slug : 'thread'}`;
}

export async function checkpointWorkingBranch(args: {
	conversationId: string;
	submissionId: string;
	submissionType: SubmissionType;
	repo: string;
	expectedSha: string;
	keys: CapabilityKeys;
	now: number;
	handlers: Record<ProxyOp, ProxyHandler>;
	audit: AuditSink;
	exec: CheckpointExec;
	revoke: (token: string) => Promise<void>;
}): Promise<{ branch: string; sha: string; htmlUrl: string }> {
	assertOpAllowed({ submissionType: args.submissionType, op: 'vendPushToken' });
	const repo = canonicalRepo(args.repo);
	const branch = workingBranchName(args.conversationId);
	const minted = await executeProxy({
		token: mintCapability({
			keys: args.keys,
			now: args.now,
			claims: {
				conversationId: args.conversationId,
				submissionId: args.submissionId,
				submissionType: args.submissionType,
				repo,
				allowedOps: ['vendPushToken'],
			},
		}),
		keys: args.keys,
		op: 'vendPushToken',
		params: { repo },
		now: args.now,
		handlers: args.handlers,
		audit: args.audit,
	});
	if (!minted.ok) {
		throw new Error(minted.error.message);
	}
	const push = parseVend(minted.data);
	try {
		const pushed = await args.exec(`git push origin HEAD:refs/heads/${branch}`, {
			env: {
				GIT_CONFIG_COUNT: '1',
				GIT_CONFIG_KEY_0: 'http.extraHeader',
				GIT_CONFIG_VALUE_0: `AUTHORIZATION: bearer ${push.token}`,
			},
		});
		if (pushed.exitCode !== 0) {
			throw new Error(pushed.stderr || `git push exited ${pushed.exitCode}`);
		}
		const confirmed = await executeProxy({
			token: mintCapability({
				keys: args.keys,
				now: args.now,
				claims: {
					conversationId: args.conversationId,
					submissionId: args.submissionId,
					submissionType: args.submissionType,
					repo,
					allowedOps: ['readRef'],
				},
			}),
			keys: args.keys,
			op: 'readRef',
			params: { repo, ref: `refs/heads/${branch}` },
			now: args.now,
			handlers: args.handlers,
			audit: args.audit,
		});
		if (!confirmed.ok) {
			throw new Error(confirmed.error.message);
		}
		const remote = parseRef(confirmed.data);
		if (remote.sha !== args.expectedSha) {
			throw new Error(`remote sha ${remote.sha} does not match expected ${args.expectedSha}`);
		}
		return {
			branch,
			sha: args.expectedSha,
			htmlUrl: `https://github.com/${repo}/tree/${branch}`,
		};
	} finally {
		await args.revoke(push.token);
	}
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
