import {
	createAssistantMessageEventStream,
	createModels,
	normalizeContext,
	type ProviderStreams,
} from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { describe, expect, test, vi } from 'vitest';
import {
	createOpenAICodexProvider,
	OPENAI_CODEX_MODEL_ID,
	withSseTransport,
} from './openai-codex-route.ts';

const context = normalizeContext({ messages: [] });

describe('openai-codex route', () => {
	test('pins a model id the pinned pi catalog declares', () => {
		const ids = openaiCodexProvider()
			.getModels()
			.map((model) => model.id);

		expect(ids).toContain(OPENAI_CODEX_MODEL_ID);
	});

	test('forces SSE on both stream entrypoints and keeps other options', () => {
		const stream = vi.fn<ProviderStreams['stream']>(createAssistantMessageEventStream);
		const streamSimple = vi.fn<ProviderStreams['streamSimple']>(createAssistantMessageEventStream);
		const wrapped = withSseTransport({ stream, streamSimple });
		const [model] = openaiCodexProvider().getModels();

		if (model === undefined) throw new Error('openai-codex catalog is empty');

		wrapped.stream(model, context, { apiKey: 'token', transport: 'websocket' });
		wrapped.streamSimple(model, context, { apiKey: 'token', reasoning: 'medium' });

		expect(stream).toHaveBeenCalledWith(model, context, { apiKey: 'token', transport: 'sse' });
		expect(streamSimple).toHaveBeenCalledWith(model, context, {
			apiKey: 'token',
			reasoning: 'medium',
			transport: 'sse',
		});
	});

	test('resolves auth from the CodexAuth access token on every request', async () => {
		const tokens = ['token-1', undefined];
		const models = createModels();

		models.setProvider(createOpenAICodexProvider(async () => tokens.shift()));

		await expect(models.getAuth('openai-codex')).resolves.toMatchObject({
			auth: { apiKey: 'token-1' },
		});
		await expect(models.getAuth('openai-codex')).resolves.toBeUndefined();
	});
});
