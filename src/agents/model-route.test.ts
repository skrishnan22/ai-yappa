import { describe, expect, test } from 'vitest';
import { resolveCoworkerModelSpecifier } from './model-route.ts';
import { openAICodexModelSpecifier } from './openai-codex-route.ts';
import { openCodeGoModelSpecifier } from './opencode-go-catalog.ts';

describe('resolveCoworkerModelSpecifier', () => {
	test('routes to the ChatGPT subscription when a Codex credential is configured', () => {
		expect(resolveCoworkerModelSpecifier({ OPENAI_CODEX_ACCESS_TOKEN: 'eyJ.token' })).toBe(
			openAICodexModelSpecifier,
		);
	});

	test('routes to OpenCode Go without a Codex credential', () => {
		expect(resolveCoworkerModelSpecifier({})).toBe(openCodeGoModelSpecifier);
		expect(resolveCoworkerModelSpecifier({ OPENAI_CODEX_ACCESS_TOKEN: '  ' })).toBe(
			openCodeGoModelSpecifier,
		);
	});
});
