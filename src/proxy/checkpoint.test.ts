import { describe, expect, test } from 'vitest';
import { generateCapabilityKeyPair, type ProxyOp } from './capabilities.ts';
import { checkpointWorkingBranch, workingBranchName, type CheckpointExec } from './checkpoint.ts';
import type { ProxyHandler } from './ops.ts';

function handlers(args: {
	token?: string;
	sha?: string;
}): Record<ProxyOp, ProxyHandler> {
	const refuse: ProxyHandler = async () => {
		throw new Error('handler not stubbed');
	};
	return {
		readIssue: refuse,
		readRepoMetadata: refuse,
		createBranch: refuse,
		createPullRequest: refuse,
		readRef: async () => ({ ref: 'refs/heads/agent/c1', sha: args.sha ?? 'abc123' }),
		vendPushToken: async () => ({
			token: args.token ?? 'ghs_test',
			expiresAt: '2099-01-01T00:00:00.000Z',
		}),
	};
}

describe('workingBranchName', () => {
	test('strips illegal ref characters from the conversation id', () => {
		expect(workingBranchName('C1/123.45')).toBe('agent/C1-123.45');
	});
});

describe('checkpointWorkingBranch', () => {
	test('injects the token into exec env and keeps it out of the command', async () => {
		const keys = generateCapabilityKeyPair();
		const seen: Array<{ command: string; env: Record<string, string> }> = [];
		const exec: CheckpointExec = async (command, options) => {
			seen.push({ command, env: options.env });
			return { stdout: '', stderr: '', exitCode: 0 };
		};
		const revoked: string[] = [];
		const result = await checkpointWorkingBranch({
			conversationId: 'c1',
			submissionId: 's1',
			submissionType: 'code-change',
			repo: 'https://github.com/skrishnan22/codevil.git',
			expectedSha: 'abc123',
			keys,
			now: 1_000_000,
			handlers: handlers({ token: 'ghs_test', sha: 'abc123' }),
			audit: { append: () => {} },
			exec,
			revoke: async (token) => {
				revoked.push(token);
			},
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]?.command).toBe('git push origin HEAD:refs/heads/agent/c1');
		expect(seen[0]?.command.includes('ghs_test')).toBe(false);
		expect(seen[0]?.env.GIT_CONFIG_VALUE_0).toBe('AUTHORIZATION: bearer ghs_test');
		expect(revoked).toEqual(['ghs_test']);
		expect(result).toEqual({
			branch: 'agent/c1',
			sha: 'abc123',
			htmlUrl: 'https://github.com/skrishnan22/codevil/tree/agent/c1',
		});
	});

	test('revokes when the remote sha does not match', async () => {
		const keys = generateCapabilityKeyPair();
		const revoked: string[] = [];
		await expect(
			checkpointWorkingBranch({
				conversationId: 'c1',
				submissionId: 's1',
				submissionType: 'code-change',
				repo: 'skrishnan22/codevil',
				expectedSha: 'abc123',
				keys,
				now: 1_000_000,
				handlers: handlers({ sha: 'ffff' }),
				audit: { append: () => {} },
				exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
				revoke: async (token) => {
					revoked.push(token);
				},
			}),
		).rejects.toThrow(/sha/i);
		expect(revoked).toEqual(['ghs_test']);
	});

	test('revokes when git push fails', async () => {
		const keys = generateCapabilityKeyPair();
		const revoked: string[] = [];
		await expect(
			checkpointWorkingBranch({
				conversationId: 'c1',
				submissionId: 's1',
				submissionType: 'code-change',
				repo: 'skrishnan22/codevil',
				expectedSha: 'abc123',
				keys,
				now: 1_000_000,
				handlers: handlers({}),
				audit: { append: () => {} },
				exec: async () => ({ stdout: '', stderr: 'rejected', exitCode: 1 }),
				revoke: async (token) => {
					revoked.push(token);
				},
			}),
		).rejects.toThrow(/rejected/);
		expect(revoked).toEqual(['ghs_test']);
	});

	test('investigation cannot checkpoint', async () => {
		const keys = generateCapabilityKeyPair();
		let vended = false;
		await expect(
			checkpointWorkingBranch({
				conversationId: 'c1',
				submissionId: 's1',
				submissionType: 'investigation',
				repo: 'skrishnan22/codevil',
				expectedSha: 'abc123',
				keys,
				now: 1_000_000,
				handlers: handlers({}),
				audit: { append: () => {} },
				exec: async () => {
					vended = true;
					return { stdout: '', stderr: '', exitCode: 0 };
				},
				revoke: async () => {},
			}),
		).rejects.toThrow(/investigation/i);
		expect(vended).toBe(false);
	});
});
