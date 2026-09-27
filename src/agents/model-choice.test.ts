import levenshtein from 'damerau-levenshtein';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go';
import { describe, expect, test } from 'vitest';
import { modelAliases } from '../config.ts';
import { coworkerModel, modelHelpText, resolveModelChoice, typoLimit } from './model-choice.ts';
import { openAICodexModelSpecifier } from './openai-codex-route.ts';
import { openCodeGoModelSpecifier } from './opencode-go-catalog.ts';

const pickModel = (typed: string) => resolveModelChoice({ model: typed });

const pickEffort = (typed: string) => resolveModelChoice({ effort: typed });

const luna = { provider: 'chatgpt', modelId: 'gpt-5.6-luna' } as const;

describe('matching model names', () => {
	test('matches an alias case-insensitively, or a unique prefix', () => {
		expect(pickModel('LUNA')).toEqual({ ok: true, choice: { model: luna } });
		expect(pickModel('ki')).toEqual({
			ok: true,
			choice: { model: { provider: 'opencode-go', modelId: 'kimi-k3' } },
		});
	});

	test('accepts a typo within the length-scaled edit limit', () => {
		expect(pickModel('lnua')).toEqual({ ok: true, choice: { model: luna } });

		for (const typo of ['deepsek', 'deespeek']) {
			expect(pickModel(typo)).toMatchObject({
				ok: true,
				choice: { model: { modelId: 'deepseek-v4.1-flash' } },
			});
		}
	});

	test('rejects names too far from any alias', () => {
		for (const typed of ['gpt', 'gpt-4o', 'lunar-x']) {
			expect(pickModel(typed)).toEqual({ ok: false, error: `Unknown model \`${typed}\`.` });
		}
	});
});

describe('matching effort', () => {
	test('matches levels, prefixes, and typos', () => {
		expect(pickEffort('High')).toEqual({ ok: true, choice: { thinkingLevel: 'high' } });
		expect(pickEffort('med')).toEqual({ ok: true, choice: { thinkingLevel: 'medium' } });
		expect(pickEffort('hgih')).toEqual({ ok: true, choice: { thinkingLevel: 'high' } });
		expect(pickEffort('maximum')).toEqual({ ok: false, error: 'Unknown effort `maximum`.' });
	});
});

describe('resolveModelChoice', () => {
	test('records only what the user gave', () => {
		expect(resolveModelChoice({})).toEqual({ ok: true, choice: undefined });
		expect(resolveModelChoice({ effort: 'hi' })).toEqual({
			ok: true,
			choice: { thinkingLevel: 'high' },
		});
		expect(resolveModelChoice({ model: 'lnua', effort: 'hgih' })).toEqual({
			ok: true,
			choice: { model: luna, thinkingLevel: 'high' },
		});
	});
});

describe('coworkerModel', () => {
	test('uses a ChatGPT choice while ChatGPT is usable', () => {
		expect(coworkerModel({ model: luna, thinkingLevel: 'high' }, true)).toEqual({
			specifier: 'openai-codex/gpt-5.6-luna',
			thinkingLevel: 'high',
			label: 'openai-codex/gpt-5.6-luna',
			isDefault: false,
		});
	});

	test('falls back to the OpenCode Go default when ChatGPT is not usable', () => {
		expect(coworkerModel({ model: luna, thinkingLevel: 'high' }, false)).toEqual({
			specifier: openCodeGoModelSpecifier,
			thinkingLevel: 'high',
			label: `gpt-5.6-luna unavailable → ${openCodeGoModelSpecifier}`,
			isDefault: false,
		});
	});

	test('uses an OpenCode Go choice regardless of ChatGPT', () => {
		const kimi = { model: { provider: 'opencode-go', modelId: 'kimi-k3' } } as const;

		expect(coworkerModel(kimi, true).specifier).toBe('opencode-go/kimi-k3');
		expect(coworkerModel(kimi, false).specifier).toBe('opencode-go/kimi-k3');
		expect(
			coworkerModel({ model: { provider: 'opencode-go', modelId: 'deepseek-v4.1-flash' } }, true)
				.specifier,
		).toBe(openCodeGoModelSpecifier);
	});

	test('falls back to the default route when the catalog no longer has the model', () => {
		const dropped = { model: { provider: 'opencode-go', modelId: 'kimi-k0' } } as const;

		expect(coworkerModel(dropped, true)).toMatchObject({
			specifier: openAICodexModelSpecifier,
			label: `kimi-k0 unavailable → ${openAICodexModelSpecifier}`,
			isDefault: false,
		});
		expect(coworkerModel(dropped, false).specifier).toBe(openCodeGoModelSpecifier);
	});

	test('keeps the deployment default without a model choice', () => {
		expect(coworkerModel(undefined, true)).toMatchObject({
			specifier: 'openai-codex/gpt-5.6-luna',
			thinkingLevel: 'high',
			isDefault: true,
		});
		expect(coworkerModel(undefined, false)).toMatchObject({
			specifier: openCodeGoModelSpecifier,
			thinkingLevel: 'high',
			isDefault: true,
		});
		expect(coworkerModel({ thinkingLevel: 'low' }, false)).toMatchObject({
			specifier: openCodeGoModelSpecifier,
			thinkingLevel: 'low',
			isDefault: true,
		});
	});
});

describe('model alias table', () => {
	test('every alias names a model pi ships for its provider', () => {
		const catalogs = {
			chatgpt: openaiCodexProvider().getModels(),
			'opencode-go': opencodeGoProvider().getModels(),
		};

		for (const { provider, modelId } of Object.values(modelAliases)) {
			expect(catalogs[provider].map((model) => model.id)).toContain(modelId);
		}
	});

	test('no alias is within typo distance of another', () => {
		const aliases = Object.keys(modelAliases);

		for (const a of aliases) {
			for (const b of aliases) {
				if (a === b) continue;
				expect(levenshtein(a, b).steps).toBeGreaterThan(typoLimit(b));
			}
		}
	});

	test('help text lists every alias', () => {
		for (const alias of Object.keys(modelAliases)) {
			expect(modelHelpText()).toContain(`\`${alias}\``);
		}
	});
});
