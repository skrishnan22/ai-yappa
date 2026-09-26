import { describe, expect, test } from 'vitest';
import {
	coworkerModelSpecifier,
	deliveredModelRoute,
	deliveredModelRouteFallback,
	modelRouteFallbackNote,
	modelRouteFor,
	resolveModelRoute,
} from './model-route.ts';
import { openAICodexModelSpecifier } from './openai-codex-route.ts';
import { openCodeGoModelSpecifier } from './opencode-go-catalog.ts';

describe('Model Route', () => {
	test('routes to the ChatGPT subscription only while CodexAuth is connected', () => {
		expect(modelRouteFor({ state: 'connected', expires: 0, accountId: 'account-1' })).toEqual({
			route: 'chatgpt',
		});
		expect(modelRouteFor({ state: 'pending_login', expires: 0 })).toEqual({
			route: 'opencode-go',
		});
		expect(modelRouteFor({ state: 'disconnected' })).toEqual({ route: 'opencode-go' });
	});

	test('names the fallback when ChatGPT needs a login or CodexAuth cannot answer', async () => {
		expect(
			modelRouteFor({ state: 'needs_login', reason: 'refresh_token_reused', since: 0 }),
		).toEqual({ route: 'opencode-go', fallback: 'needs_login' });

		await expect(
			resolveModelRoute(() => Promise.reject(new Error('CodexAuth is down'))),
		).resolves.toEqual({ route: 'opencode-go', fallback: 'status_failed' });
		await expect(resolveModelRoute(async () => ({ state: 'disconnected' }))).resolves.toEqual({
			route: 'opencode-go',
		});
	});

	test('reads the fallback from the Slack signal, so flue run messages carry none', () => {
		const signal = { kind: 'signal', type: 'slack.app_mention', body: 'hi' } as const;

		expect(
			deliveredModelRouteFallback({ ...signal, attributes: { modelRouteFallback: 'needs_login' } }),
		).toBe('needs_login');
		expect(
			deliveredModelRouteFallback({ ...signal, attributes: { modelRouteFallback: 'nope' } }),
		).toBeUndefined();
		expect(deliveredModelRouteFallback(signal)).toBeUndefined();
		expect(deliveredModelRouteFallback({ kind: 'user', body: 'Hi' })).toBeUndefined();
		expect(modelRouteFallbackNote('needs_login')).toBe('ChatGPT needs a new login');
		expect(modelRouteFallbackNote('status_failed')).toBe('ChatGPT unavailable');
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

	test('uses OpenCode Go without a ChatGPT route', () => {
		expect(coworkerModelSpecifier('chatgpt')).toBe(openAICodexModelSpecifier);
		expect(coworkerModelSpecifier('opencode-go')).toBe(openCodeGoModelSpecifier);
		expect(coworkerModelSpecifier(undefined)).toBe(openCodeGoModelSpecifier);
	});
});
