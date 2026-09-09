import { describe, expect, test } from 'vitest';
import { gitAuthorFromEnv, loadAgentEnv, loadServerEnv } from './env.ts';

const full = {
	SLACK_SIGNING_SECRET: 'signing-secret',
	SLACK_BOT_TOKEN: 'xoxb-test',
	DAYTONA_API_KEY: 'dtn-test',
	OPENCODE_API_KEY: 'sk-test',
};

describe('loadServerEnv', () => {
	test('lists every missing secret at once', () => {
		expect(() => loadServerEnv({})).toThrow(
			/\[boot\] missing secrets: .*DAYTONA_API_KEY.*OPENCODE_API_KEY.*SLACK_BOT_TOKEN.*SLACK_SIGNING_SECRET/s,
		);
	});

	test('rejects an empty value', () => {
		expect(() => loadServerEnv({ ...full, SLACK_BOT_TOKEN: '' })).toThrow(
			/\[boot\] missing secrets: SLACK_BOT_TOKEN/,
		);
	});

	test('returns the validated env', () => {
		expect(loadServerEnv({ ...full })).toEqual(full);
	});
});

describe('loadAgentEnv', () => {
	test('Slack secrets are optional for `flue run`', () => {
		const env = loadAgentEnv({
			DAYTONA_API_KEY: 'dtn-test',
			OPENCODE_API_KEY: 'sk-test',
		});
		expect(env.DAYTONA_API_KEY).toBe('dtn-test');
	});

	test('Daytona and model keys are still required', () => {
		expect(() => loadAgentEnv({})).toThrow(/DAYTONA_API_KEY.*OPENCODE_API_KEY/s);
	});
});

describe('gitAuthorFromEnv', () => {
	test('uses both name and email, skips when neither is set, fails when only one is set', () => {
		expect(gitAuthorFromEnv({})).toBeUndefined();
		expect(
			gitAuthorFromEnv({
				GIT_AUTHOR_NAME: 'ai-yappa[bot]',
				GIT_AUTHOR_EMAIL: '1+ai-yappa[bot]@users.noreply.github.com',
			}),
		).toEqual({
			name: 'ai-yappa[bot]',
			email: '1+ai-yappa[bot]@users.noreply.github.com',
		});
		expect(() => gitAuthorFromEnv({ GIT_AUTHOR_NAME: 'only-name' })).toThrow(/both be set/);
	});
});
