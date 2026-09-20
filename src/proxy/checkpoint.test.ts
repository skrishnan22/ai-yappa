import { describe, expect, test, vi } from 'vitest';
import { checkpointWorkingBranch, workingBranchName, type CheckpointExec } from './checkpoint.ts';
import type { OperationContext, ProxyHandler } from './ops.ts';
import type { ProxyOp } from './policy.ts';

const CONTEXT: OperationContext = {
	conversationId: 'c1',
	submissionId: 's1',
	submissionType: 'code-change',
	repo: 'https://github.com/skrishnan22/codevil.git',
};

function handlers(args?: {
	token?: string;
	sha?: string;
	vend?: ProxyHandler;
	readRef?: ProxyHandler;
}): Record<ProxyOp, ProxyHandler> {
	const refuse: ProxyHandler = async () => {
		throw new Error('handler not stubbed');
	};

	return {
		readIssue: refuse,
		readRepoMetadata: refuse,
		createBranch: refuse,
		createPullRequest: refuse,
		readRef:
			args?.readRef ?? (async () => ({ ref: 'refs/heads/agent/c1', sha: args?.sha ?? 'abc123' })),
		vendPushToken:
			args?.vend ??
			(async () => ({
				token: args?.token ?? 'ghs_test',
				expiresAt: '2099-01-01T00:00:00.000Z',
			})),
	};
}

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

function checkpointArgs(overrides?: {
	context?: OperationContext;
	handlers?: Record<ProxyOp, ProxyHandler>;
	exec?: CheckpointExec;
	revoke?: (token: string) => Promise<void>;
}) {
	return {
		context: overrides?.context ?? CONTEXT,
		expectedSha: 'abc123',
		now: 1_000_000,
		handlers: overrides?.handlers ?? handlers(),
		audit: { append: () => {} },
		exec: overrides?.exec ?? execAt('abc123'),
		revoke: overrides?.revoke ?? (async () => {}),
	};
}

describe('workingBranchName', () => {
	test('strips illegal ref characters from the conversation id', () => {
		expect(workingBranchName('C1/123.45')).toBe('agent/C1-123.45');
	});
});

describe('checkpointWorkingBranch', () => {
	test('does not issue a token or push when local HEAD differs from expectedSha', async () => {
		const vend = vi.fn<ProxyHandler>();
		const seen: Array<{ command: string; env: Record<string, string> }> = [];
		await expect(
			checkpointWorkingBranch({
				...checkpointArgs({ handlers: handlers({ vend }), exec: execAt('deadbeef', { seen }) }),
			}),
		).rejects.toThrow(/local HEAD deadbeef/);

		expect(vend).not.toHaveBeenCalled();
		expect(seen).toEqual([{ command: 'git rev-parse HEAD', env: {} }]);
	});

	test('refuses investigations before token issuance or sandbox execution', async () => {
		const vend = vi.fn<ProxyHandler>();
		const exec = vi.fn<CheckpointExec>();
		await expect(
			checkpointWorkingBranch({
				...checkpointArgs({
					context: { ...CONTEXT, submissionType: 'investigation' },
					handlers: handlers({ vend }),
					exec,
				}),
			}),
		).rejects.toThrow(/investigation/i);

		expect(vend).not.toHaveBeenCalled();
		expect(exec).not.toHaveBeenCalled();
	});

	test('pushes to the explicit canonical repo and deterministic branch with hooks disabled', async () => {
		const seen: Array<{ command: string; env: Record<string, string> }> = [];

		const result = await checkpointWorkingBranch({
			...checkpointArgs({ exec: execAt('abc123', { seen }) }),
		});

		expect(seen.map((entry) => entry.command)).toEqual([
			'git rev-parse HEAD',
			"git push --no-verify 'https://github.com/skrishnan22/codevil.git' 'HEAD:refs/heads/agent/c1'",
		]);
		expect(seen[1]?.command).not.toContain('origin');
		expect(seen[1]?.command).not.toContain('ghs_test');
		expect(result).toEqual({
			branch: 'agent/c1',
			sha: 'abc123',
			htmlUrl: 'https://github.com/skrishnan22/codevil/tree/agent/c1',
		});
	});

	test('injects Basic auth only into push and disables redirects and prompts', async () => {
		const seen: Array<{ command: string; env: Record<string, string> }> = [];
		await checkpointWorkingBranch({ ...checkpointArgs({ exec: execAt('abc123', { seen }) }) });

		expect(seen[0]?.env).toEqual({});
		expect(seen[1]?.env).toEqual({
			GIT_CONFIG_COUNT: '2',
			GIT_CONFIG_KEY_0: 'http.extraHeader',
			GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from('x-access-token:ghs_test').toString('base64')}`,
			GIT_CONFIG_KEY_1: 'http.followRedirects',
			GIT_CONFIG_VALUE_1: 'false',
			GIT_TERMINAL_PROMPT: '0',
		});
	});

	test('revokes the token after push failure and reports only a static error', async () => {
		const revoked: string[] = [];
		const secret = 'ghs_secret';
		let message = '';

		try {
			await checkpointWorkingBranch({
				...checkpointArgs({
					handlers: handlers({ token: secret }),
					exec: execAt('abc123', {
						push: { stdout: secret, stderr: `leaked ${secret}`, exitCode: 128 },
					}),
					revoke: async (token) => {
						revoked.push(token);
					},
				}),
			});
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toBe('git push exited 128');
		expect(message).not.toContain(secret);
		expect(revoked).toEqual([secret]);
	});

	test('revokes the token when readRef fails', async () => {
		const revoked: string[] = [];
		await expect(
			checkpointWorkingBranch({
				...checkpointArgs({
					handlers: handlers({
						readRef: async () => {
							throw new Error('GitHub 502');
						},
					}),
					revoke: async (token) => {
						revoked.push(token);
					},
				}),
			}),
		).rejects.toThrow('GitHub 502');
		expect(revoked).toEqual(['ghs_test']);
	});

	test('revokes the token when the remote SHA differs', async () => {
		const revoked: string[] = [];
		await expect(
			checkpointWorkingBranch({
				...checkpointArgs({
					handlers: handlers({ sha: 'ffff' }),
					revoke: async (token) => {
						revoked.push(token);
					},
				}),
			}),
		).rejects.toThrow(/remote sha ffff/);
		expect(revoked).toEqual(['ghs_test']);
	});

	test('revokes exactly once after success', async () => {
		const revoke = vi.fn<(token: string) => Promise<void>>(async () => {});
		await checkpointWorkingBranch({ ...checkpointArgs({ revoke }) });
		expect(revoke).toHaveBeenCalledTimes(1);
		expect(revoke).toHaveBeenCalledWith('ghs_test');
	});

	test('surfaces a static revoke failure without exposing the token', async () => {
		const secret = 'ghs_secret';
		let message = '';

		try {
			await checkpointWorkingBranch({
				...checkpointArgs({
					handlers: handlers({ token: secret }),
					revoke: async () => {
						throw new Error(secret);
					},
				}),
			});
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toBe('failed to revoke push token');
		expect(message).not.toContain(secret);
	});

	test('preserves the sanitized checkpoint error when revocation also fails', async () => {
		await expect(
			checkpointWorkingBranch({
				...checkpointArgs({
					exec: execAt('abc123', { push: { exitCode: 1 } }),
					revoke: async () => {
						throw new Error('private detail');
					},
				}),
			}),
		).rejects.toThrow('git push exited 1; failed to revoke push token');
	});
});
