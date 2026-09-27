import levenshtein from 'damerau-levenshtein';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go';
import { describe, expect, test } from 'vitest';
import { modelAliases } from '../config.ts';
import {
	coworkerModel,
	distanceLimit,
	modelHelpText,
	resolveModelAlias,
	resolveModelChoice,
	resolveThinkingLevel,
} from './model-choice.ts';
import { openAICodexModelSpecifier } from './openai-codex-route.ts';
import { openCodeGoModelSpecifier } from './opencode-go-catalog.ts';

describe('resolveModelAlias', () => {
	test('matches alias, model id, and unique prefix without calling it a correction', () => {
		expect(resolveModelAlias('LUNA')).toEqual({ kind: 'match', value: 'luna', corrected: false });
		expect(resolveModelAlias('gpt-5.6-luna')).toEqual({
			kind: 'match',
			value: 'luna',
			corrected: false,
		});
		expect(resolveModelAlias('ki')).toEqual({ kind: 'match', value: 'kimi', corrected: false });
	});

	test('corrects a typo within the length-scaled edit limit', () => {
		expect(resolveModelAlias('lnua')).toEqual({ kind: 'match', value: 'luna', corrected: true });
		expect(resolveModelAlias('kmi')).toEqual({ kind: 'match', value: 'kimi', corrected: true });
		expect(resolveModelAlias('deepsek')).toEqual({
			kind: 'match',
			value: 'deepseek',
			corrected: true,
		});
		expect(resolveModelAlias('deespeek')).toEqual({
			kind: 'match',
			value: 'deepseek',
			corrected: true,
		});
	});

	test('rejects names too far from any alias', () => {
		expect(resolveModelAlias('gpt')).toEqual({ kind: 'unknown' });
		expect(resolveModelAlias('gpt-4o')).toEqual({ kind: 'unknown' });
		expect(resolveModelAlias('lunar-x')).toEqual({ kind: 'unknown' });
	});
});

describe('resolveThinkingLevel', () => {
	test('matches levels, prefixes, shorthands, and typos', () => {
		expect(resolveThinkingLevel('High')).toEqual({
			kind: 'match',
			value: 'high',
			corrected: false,
		});
		expect(resolveThinkingLevel('med')).toEqual({
			kind: 'match',
			value: 'medium',
			corrected: false,
		});
		expect(resolveThinkingLevel('mid')).toEqual({
			kind: 'match',
			value: 'medium',
			corrected: false,
		});
		expect(resolveThinkingLevel('hgih')).toEqual({ kind: 'match', value: 'high', corrected: true });
		expect(resolveThinkingLevel('maximum')).toEqual({ kind: 'unknown' });
	});
});

describe('resolveModelChoice', () => {
	test('records only what the user gave', () => {
		expect(resolveModelChoice({})).toEqual({ ok: true, choice: undefined });
		expect(resolveModelChoice({ think: 'hi' })).toEqual({
			ok: true,
			choice: { thinkingLevel: 'high' },
		});
		expect(resolveModelChoice({ model: 'lnua', think: 'hgih' })).toEqual({
			ok: true,
			choice: {
				model: { provider: 'chatgpt', modelId: 'gpt-5.6-luna' },
				thinkingLevel: 'high',
				correctedFrom: { model: 'lnua', think: 'hgih' },
			},
		});
	});

	test('explains unknown values', () => {
		expect(resolveModelChoice({ model: 'gpt-4o' })).toEqual({
			ok: false,
			error: 'Unknown model `gpt-4o`.',
		});
		expect(resolveModelChoice({ think: 'max' })).toEqual({
			ok: false,
			error: 'Unknown thinking level `max`.',
		});
	});
});

describe('coworkerModel', () => {
	const luna = { provider: 'chatgpt', modelId: 'gpt-5.6-luna' } as const;

	test('uses a ChatGPT choice while ChatGPT is usable', () => {
		expect(coworkerModel({ model: luna, thinkingLevel: 'high' }, 'chatgpt')).toEqual({
			specifier: 'openai-codex/gpt-5.6-luna',
			thinkingLevel: 'high',
			label: 'openai-codex/gpt-5.6-luna',
			thinkingLabel: 'high',
			isDefault: false,
		});
	});

	test('falls back to the OpenCode Go default when ChatGPT is not usable', () => {
		expect(coworkerModel({ model: luna, thinkingLevel: 'high' }, 'opencode-go')).toEqual({
			specifier: openCodeGoModelSpecifier,
			thinkingLevel: 'high',
			label: `gpt-5.6-luna unavailable → ${openCodeGoModelSpecifier}`,
			thinkingLabel: 'high',
			isDefault: false,
		});
	});

	test('uses an OpenCode Go choice regardless of ChatGPT', () => {
		const kimi = { model: { provider: 'opencode-go', modelId: 'kimi-k3' } } as const;

		expect(coworkerModel(kimi, 'chatgpt').specifier).toBe('opencode-go/kimi-k3');
		expect(coworkerModel(kimi, 'opencode-go').specifier).toBe('opencode-go/kimi-k3');
		expect(
			coworkerModel(
				{ model: { provider: 'opencode-go', modelId: 'deepseek-v4.1-flash' } },
				'chatgpt',
			).specifier,
		).toBe(openCodeGoModelSpecifier);
	});

	test('keeps the deployment default without a model choice', () => {
		expect(coworkerModel(undefined, 'chatgpt')).toMatchObject({
			specifier: openAICodexModelSpecifier,
			thinkingLevel: 'medium',
			isDefault: true,
		});
		expect(coworkerModel({ thinkingLevel: 'low' }, 'opencode-go')).toMatchObject({
			specifier: openCodeGoModelSpecifier,
			thinkingLevel: 'low',
			isDefault: true,
		});
		expect(coworkerModel(undefined, undefined).specifier).toBe(openCodeGoModelSpecifier);
	});

	test('labels corrected input', () => {
		expect(
			coworkerModel(
				{ model: luna, thinkingLevel: 'high', correctedFrom: { model: 'lnua', think: 'hgih' } },
				'chatgpt',
			),
		).toMatchObject({
			label: 'openai-codex/gpt-5.6-luna (from "lnua")',
			thinkingLabel: 'high (from "hgih")',
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
				expect(levenshtein(a, b).steps).toBeGreaterThan(distanceLimit(b));
			}
		}
	});

	test('help text lists every alias', () => {
		for (const alias of Object.keys(modelAliases)) {
			expect(modelHelpText()).toContain(`\`${alias}\``);
		}
	});
});
