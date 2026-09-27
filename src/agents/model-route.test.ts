import { describe, expect, test } from 'vitest';
import { deliveredModelRoute, modelRouteFor } from './model-route.ts';

describe('Model Route', () => {
	test('routes to the ChatGPT subscription only while CodexAuth is connected', () => {
		expect(modelRouteFor({ state: 'connected', expires: 0, accountId: 'account-1' })).toBe(
			'chatgpt',
		);
		expect(modelRouteFor({ state: 'pending_login', expires: 0 })).toBe('opencode-go');
		expect(modelRouteFor({ state: 'disconnected' })).toBe('opencode-go');
	});

	test('reads the route from the Slack signal that woke the submission', () => {
		const signal = { kind: 'signal', type: 'slack.app_mention', body: 'hi' } as const;

		expect(deliveredModelRoute({ ...signal, attributes: { modelRoute: 'chatgpt' } })).toBe(
			'chatgpt',
		);
		expect(deliveredModelRoute({ ...signal, attributes: { modelRoute: 'opencode-go' } })).toBe(
			'opencode-go',
		);
		expect(deliveredModelRoute({ ...signal, attributes: { modelRoute: 'gpt-9' } })).toBeUndefined();
		expect(deliveredModelRoute(signal)).toBeUndefined();
		expect(deliveredModelRoute({ kind: 'user', body: 'Hi' })).toBeUndefined();
	});
});
