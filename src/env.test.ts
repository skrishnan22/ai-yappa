import { afterEach, describe, expect, test, vi } from 'vitest';

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
});

describe('Slack environment', () => {
	test('requires a bot token when the Slack application is loaded', async () => {
		vi.stubEnv('SLACK_SIGNING_SECRET', 'signing-secret');
		vi.stubEnv('SLACK_BOT_TOKEN', '');

		await expect(import('./env.ts')).rejects.toThrow();
	});

	test('returns both required Slack credentials', async () => {
		vi.stubEnv('SLACK_SIGNING_SECRET', 'signing-secret');
		vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test');

		const { env } = await import('./env.ts');

		expect(env).toEqual({
			SLACK_SIGNING_SECRET: 'signing-secret',
			SLACK_BOT_TOKEN: 'xoxb-test',
		});
	});
});
