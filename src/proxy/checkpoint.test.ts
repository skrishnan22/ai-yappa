import { describe, expect, test } from 'vitest';
import { generateCapabilityKeyPair, type ProxyOp } from './capabilities.ts';
import { checkpointWorkingBranch, workingBranchName, type CheckpointExec } from './checkpoint.ts';
import type { ProxyHandler } from './ops.ts';

function handlers(args: { token?: string; sha?: string }): Record<ProxyOp, ProxyHandler> {
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

function execAt(
	expectedSha: string,
	args?: {
		seen?: Array<{ command: string; env: Record<string, string> }>;
		push?: { stderr?: string; stdout?: string; exitCode?: number };
	},
): CheckpointExec {
	return async (command, options) => {
		args?.seen?.push({ command, env: options.env });
		if (command === 'git rev-parse HEAD') {
			return { stdout: `${expectedSha}\n`, stderr: '', exitCode: 0 };
		}
		return {
			stdout: args?.push?.stdout ?? '',
			stderr: args?.push?.stderr ?? '',
			exitCode: args?.push?.exitCode ?? 0,
		};
	};
}

describe('checkpointWorkingBranch', () => {
	test('injects the token into exec env and keeps it out of the command', async () => {
		const keys = generateCapabilityKeyPair();
		const seen: Array<{ command: string; env: Record<string, string> }> = [];
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
			exec: execAt('abc123', { seen }),
			revoke: async (token) => {
				revoked.push(token);
			},
		});
		expect(seen.map((entry) => entry.command)).toEqual([
			'git rev-parse HEAD',
			'git push origin HEAD:refs/heads/agent/c1',
		]);
		expect(seen[0]?.env).toEqual({});
		expect(seen[1]?.command.includes('ghs_test')).toBe(false);
		expect(seen[1]?.env.GIT_CONFIG_VALUE_0).toBe(
			`Authorization: Basic ${Buffer.from('x-access-token:ghs_test').toString('base64')}`,
		);
		expect(revoked).toEqual(['ghs_test']);
		expect(result).toEqual({
			branch: 'agent/c1',
			sha: 'abc123',
			htmlUrl: 'https://github.com/skrishnan22/codevil/tree/agent/c1',
		});
	});

	test('does not vend or push when local HEAD does not match expectedSha', async () => {
		const keys = generateCapabilityKeyPair();
		const seen: string[] = [];
		let vended = false;
		const vend = handlers({});
		vend.vendPushToken = async () => {
			vended = true;
			return { token: 'ghs_test', expiresAt: '2099-01-01T00:00:00.000Z' };
		};
		await expect(
			checkpointWorkingBranch({
				conversationId: 'c1',
				submissionId: 's1',
				submissionType: 'code-change',
				repo: 'skrishnan22/codevil',
				expectedSha: 'abc123',
				keys,
				now: 1_000_000,
				handlers: vend,
				audit: { append: () => {} },
				exec: async (command) => {
					seen.push(command);
					return { stdout: 'deadbeef\n', stderr: '', exitCode: 0 };
				},
				revoke: async () => {},
			}),
		).rejects.toThrow(/local HEAD deadbeef/);
		expect(seen).toEqual(['git rev-parse HEAD']);
		expect(vended).toBe(false);
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
				exec: execAt('abc123'),
				revoke: async (token) => {
					revoked.push(token);
				},
			}),
		).rejects.toThrow(/remote sha/);
		expect(revoked).toEqual(['ghs_test']);
	});

	test('reports git push stdout when stderr is empty', async () => {
		const keys = generateCapabilityKeyPair();
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
				exec: execAt('abc123', {
					push: { stdout: 'The requested URL returned error: 403', stderr: '', exitCode: 128 },
				}),
				revoke: async () => {},
			}),
		).rejects.toThrow(/403/);
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
				exec: execAt('abc123', { push: { stderr: 'rejected', exitCode: 1 } }),
				revoke: async (token) => {
					revoked.push(token);
				},
			}),
		).rejects.toThrow(/rejected/);
		expect(revoked).toEqual(['ghs_test']);
	});

	test('keeps the checkpoint error when revoke also fails', async () => {
		const keys = generateCapabilityKeyPair();
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
				exec: execAt('abc123', { push: { stderr: 'rejected', exitCode: 1 } }),
				revoke: async () => {
					throw new Error('revoke failed');
				},
			}),
		).rejects.toThrow(/rejected.*revoke failed/);
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
