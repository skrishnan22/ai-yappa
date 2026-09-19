import { describe, expect, test, vi, afterEach } from 'vitest';
import type { Api, Model } from '@earendil-works/pi-ai';
import {
	loadOpenCodeGoCatalog,
	overlayModelsDevCatalog,
	MODELS_DEV_CATALOG_URL,
} from './opencode-go-catalog.ts';

afterEach(() => {
	vi.restoreAllMocks();
});

const flash: Model<Api> = {
	id: 'deepseek-v4-flash',
	name: 'DeepSeek V4 Flash (bundled)',
	api: 'openai-completions',
	provider: 'opencode-go',
	baseUrl: 'https://opencode.ai/zen/go/v1',
	reasoning: true,
	input: ['text'],
	cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 384_000,
	compat: {
		supportsStore: false,
		supportsDeveloperRole: false,
		maxTokensField: 'max_tokens',
		requiresReasoningContentOnAssistantMessages: true,
		thinkingFormat: 'deepseek',
	},
};

const qwen: Model<Api> = {
	id: 'qwen3.7-plus',
	name: 'Qwen3.7 Plus (bundled)',
	api: 'anthropic-messages',
	provider: 'opencode-go',
	baseUrl: 'https://opencode.ai/zen/go',
	reasoning: true,
	input: ['text', 'image'],
	cost: { input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.5 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
};

const modelsDevPayload = {
	'opencode-go': {
		id: 'opencode-go',
		npm: '@ai-sdk/openai-compatible',
		api: 'https://opencode.ai/zen/go/v1',
		models: {
			'deepseek-v4.1-flash': {
				id: 'deepseek-v4.1-flash',
				name: 'DeepSeek V4.1 Flash',
				reasoning: true,
				reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
				interleaved: { field: 'reasoning_content' },
				modalities: { input: ['text', 'image'] },
				limit: { context: 1_000_000, output: 384_000 },
				cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
			},
			'deepseek-v4-flash': {
				id: 'deepseek-v4-flash',
				name: 'DeepSeek V4 Flash',
				reasoning: true,
				limit: { context: 1_000_000, output: 384_000 },
				cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
			},
			'qwen3.7-plus': {
				id: 'qwen3.7-plus',
				name: 'Qwen3.7 Plus',
				reasoning: true,
				modalities: { input: ['text', 'image', 'video'] },
				limit: { context: 1_000_000, output: 65_536 },
				cost: { input: 0.4, output: 1.6, cache_read: 0.04, cache_write: 0.5 },
			},
			'minimax-m3': {
				id: 'minimax-m3',
				name: 'MiniMax-M3',
				reasoning: true,
				provider: { npm: '@ai-sdk/anthropic' },
				limit: { context: 1_000_000, output: 131_072 },
				cost: { input: 0.3, output: 1.2, cache_read: 0.06 },
			},
			'gpt-5.6-luna': {
				id: 'gpt-5.6-luna',
				name: 'GPT-5.6 Luna',
				reasoning: true,
				provider: { npm: '@ai-sdk/openai' },
				limit: { context: 1_050_000, output: 128_000 },
				cost: { input: 0.2, output: 1.2, cache_read: 0.02, cache_write: 0.25 },
			},
		},
	},
};

describe('overlayModelsDevCatalog', () => {
	test('adds deepseek-v4.1-flash from models.dev onto openai-completions', () => {
		const models = overlayModelsDevCatalog([flash, qwen], modelsDevPayload);
		const v41 = models.find((model) => model.id === 'deepseek-v4.1-flash');
		expect(v41).toMatchObject({
			id: 'deepseek-v4.1-flash',
			name: 'DeepSeek V4.1 Flash',
			api: 'openai-completions',
			provider: 'opencode-go',
			baseUrl: 'https://opencode.ai/zen/go/v1',
			reasoning: true,
			input: ['text', 'image'],
			contextWindow: 1_000_000,
			maxTokens: 384_000,
			cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
			compat: {
				thinkingFormat: 'deepseek',
				requiresReasoningContentOnAssistantMessages: true,
				maxTokensField: 'max_tokens',
			},
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: 'low',
				medium: null,
				high: 'high',
				xhigh: null,
				max: 'max',
			},
		});
	});

	test('keeps bundled wire protocol for known ids while taking models.dev pricing', () => {
		const models = overlayModelsDevCatalog([flash, qwen], modelsDevPayload);
		expect(models.find((model) => model.id === 'qwen3.7-plus')).toMatchObject({
			api: 'anthropic-messages',
			baseUrl: 'https://opencode.ai/zen/go',
			name: 'Qwen3.7 Plus',
			cost: { input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.5 },
		});
		expect(models.find((model) => model.id === 'deepseek-v4-flash')).toMatchObject({
			api: 'openai-completions',
			compat: flash.compat,
			cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
		});
	});

	test('infers anthropic-messages and openai-responses from models.dev npm packages', () => {
		const models = overlayModelsDevCatalog([flash, qwen], modelsDevPayload);
		expect(models.find((model) => model.id === 'minimax-m3')?.api).toBe('anthropic-messages');
		expect(models.find((model) => model.id === 'minimax-m3')?.baseUrl).toBe(
			'https://opencode.ai/zen/go',
		);
		expect(models.find((model) => model.id === 'gpt-5.6-luna')).toMatchObject({
			api: 'openai-responses',
			baseUrl: 'https://opencode.ai/zen/go/v1',
			compat: { sessionAffinityFormat: 'openai-nosession' },
		});
	});

	test('returns empty when the opencode-go provider is missing', () => {
		expect(overlayModelsDevCatalog([flash], { openai: { models: {} } })).toEqual([]);
	});
});

describe('loadOpenCodeGoCatalog', () => {
	test('maps a models.dev payload fetched from the catalog URL', async () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const models = await loadOpenCodeGoCatalog({
			bundled: [flash, qwen],
			fetch: async (input) => {
				expect(input).toBe(MODELS_DEV_CATALOG_URL);
				return new Response(JSON.stringify(modelsDevPayload), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			},
		});
		expect(models.some((model) => model.id === 'deepseek-v4.1-flash')).toBe(true);
		expect(info).toHaveBeenCalledWith('[opencode-go] loaded 5 models from models.dev');
	});

	test('falls back to the bundled catalog without throwing when models.dev is down', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const models = await loadOpenCodeGoCatalog({
			bundled: [flash],
			fetch: async () => new Response('nope', { status: 503 }),
		});
		expect(models).toEqual([flash]);
		expect(warn).toHaveBeenCalledWith(
			'[opencode-go] models.dev catalog unavailable (http 503); using bundled pi-ai models',
		);
	});

	test('falls back when the payload is not JSON', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const models = await loadOpenCodeGoCatalog({
			bundled: [flash],
			fetch: async () => new Response('<html>', { status: 200 }),
		});
		expect(models).toEqual([flash]);
		expect(warn.mock.calls[0]?.[0]).toContain('fetch failed');
	});
});
