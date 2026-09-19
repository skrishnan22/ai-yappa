import { describe, expect, test, vi, afterEach, beforeEach } from 'vitest';
import type { Api, Model } from '@earendil-works/pi-ai';
import {
	resolveOpenCodeGoModel,
	MODELS_DEV_CATALOG_URL,
	OPENCODE_GO_BUNDLED_ID,
	OPENCODE_GO_PREFERRED_ID,
} from './opencode-go-catalog.ts';

beforeEach(() => {
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

const flash: Model<Api> = {
	id: OPENCODE_GO_BUNDLED_ID,
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

function catalogResponse(ids: string[], status = 200): Response {
	const models: Record<string, { id: string }> = {};
	for (const id of ids) models[id] = { id };
	return new Response(JSON.stringify({ 'opencode-go': { models } }), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

describe('resolveOpenCodeGoModel', () => {
	test('uses the preferred id when models.dev lists it', async () => {
		const resolved = await resolveOpenCodeGoModel({
			bundled: [flash],
			fetch: async (input) => {
				expect(input).toBe(MODELS_DEV_CATALOG_URL);
				return catalogResponse([OPENCODE_GO_PREFERRED_ID, OPENCODE_GO_BUNDLED_ID]);
			},
		});
		expect(resolved.modelId).toBe(OPENCODE_GO_PREFERRED_ID);
		expect(resolved.models[0]).toMatchObject({
			id: OPENCODE_GO_PREFERRED_ID,
			api: flash.api,
			compat: flash.compat,
			baseUrl: flash.baseUrl,
		});
	});

	test('uses the bundled id when models.dev omits the preferred id', async () => {
		const resolved = await resolveOpenCodeGoModel({
			bundled: [flash],
			fetch: async () => catalogResponse([OPENCODE_GO_BUNDLED_ID]),
		});
		expect(resolved).toEqual({ models: [flash], modelId: OPENCODE_GO_BUNDLED_ID });
		expect(console.warn).toHaveBeenCalled();
	});

	test('uses the bundled id when models.dev is down', async () => {
		const resolved = await resolveOpenCodeGoModel({
			bundled: [flash],
			fetch: async () => new Response('nope', { status: 503 }),
		});
		expect(resolved).toEqual({ models: [flash], modelId: OPENCODE_GO_BUNDLED_ID });
	});

	test('uses the bundled id when the payload is not JSON', async () => {
		const resolved = await resolveOpenCodeGoModel({
			bundled: [flash],
			fetch: async () => new Response('<html>', { status: 200 }),
		});
		expect(resolved).toEqual({ models: [flash], modelId: OPENCODE_GO_BUNDLED_ID });
	});
});
