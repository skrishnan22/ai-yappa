import { describe, expect, test } from 'vitest';
import { resolveCoworkerModelSpecifier } from './model-route.ts';
import { openAICodexModelSpecifier } from './openai-codex-route.ts';
import { openCodeGoModelSpecifier } from './opencode-go-catalog.ts';

function accessToken(expiresInMs: number): string {
	const claims = { exp: Math.floor((Date.now() + expiresInMs) / 1000) };

	const payload = btoa(JSON.stringify(claims))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');

	return `header.${payload}.signature`;
}

describe('resolveCoworkerModelSpecifier', () => {
	test('routes to the ChatGPT subscription while the Codex token is valid', () => {
		expect(
			resolveCoworkerModelSpecifier({ OPENAI_CODEX_ACCESS_TOKEN: accessToken(60 * 60 * 1000) }),
		).toBe(openAICodexModelSpecifier);
	});

	test('routes to OpenCode Go without a Codex token', () => {
		expect(resolveCoworkerModelSpecifier({})).toBe(openCodeGoModelSpecifier);
		expect(resolveCoworkerModelSpecifier({ OPENAI_CODEX_ACCESS_TOKEN: '  ' })).toBe(
			openCodeGoModelSpecifier,
		);
	});

	test('routes to OpenCode Go when the Codex token is expired or about to expire', () => {
		expect(
			resolveCoworkerModelSpecifier({ OPENAI_CODEX_ACCESS_TOKEN: accessToken(-60 * 1000) }),
		).toBe(openCodeGoModelSpecifier);
		expect(
			resolveCoworkerModelSpecifier({ OPENAI_CODEX_ACCESS_TOKEN: accessToken(60 * 1000) }),
		).toBe(openCodeGoModelSpecifier);
	});

	test('routes to OpenCode Go when the Codex token is not a JWT with an expiry', () => {
		expect(resolveCoworkerModelSpecifier({ OPENAI_CODEX_ACCESS_TOKEN: 'not-a-jwt' })).toBe(
			openCodeGoModelSpecifier,
		);
		expect(resolveCoworkerModelSpecifier({ OPENAI_CODEX_ACCESS_TOKEN: 'a.%%%.c' })).toBe(
			openCodeGoModelSpecifier,
		);
	});
});
