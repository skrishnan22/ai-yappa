import { createProvider, type Provider, type ProviderStreams } from '@earendil-works/pi-ai';
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';

export const OPENAI_CODEX_MODEL_ID = 'gpt-6.1-luna';

export const OPENAI_CODEX_MODEL_IDS = ['gpt-6.1-luna', 'gpt-6.1-sol'] as const;

export const openAICodexModelSpecifier = `openai-codex/${OPENAI_CODEX_MODEL_ID}`;

// workerd's WebSocket constructor takes no request headers, so pi's default
// WebSocket attempt fails on every fresh isolate before it falls back to SSE.
export function withSseTransport(api: ProviderStreams): ProviderStreams {
	return {
		...api,
		stream: (model, context, options) =>
			api.stream(model, context, { ...options, transport: 'sse' }),
		streamSimple: (model, context, options) =>
			api.streamSimple(model, context, { ...options, transport: 'sse' }),
	};
}

// The ChatGPT subscription provider. `accessToken` asks the `CodexAuth`
// Durable Object, which refreshes under its lock; the refresh token never
// leaves it. src/cloudflare.ts registers this in the Worker; `flue run`
// never loads that file, has no Durable Object, and stays on OpenCode Go.
export function createOpenAICodexProvider(
	accessToken: () => Promise<string | undefined>,
): Provider {
	const catalog = openaiCodexProvider();
	const catalogModels = catalog.getModels();
	const models = [...catalogModels];

	for (const modelId of OPENAI_CODEX_MODEL_IDS) {
		if (models.some((model) => model.id === modelId)) continue;

		const sourceId = modelId.replace('6.1', '5.6');
		const source = catalogModels.find((model) => model.id === sourceId);

		if (!source) throw new Error(`OpenAI Codex catalog is missing ${sourceId}`);

		models.push({ ...source, id: modelId, name: source.name.replace('5.6', '6.1') });
	}

	return createProvider({
		id: catalog.id,
		name: catalog.name,
		baseUrl: catalog.baseUrl,
		auth: {
			apiKey: {
				name: 'ChatGPT subscription (CodexAuth)',
				resolve: async () => {
					const apiKey = await accessToken();

					return apiKey === undefined ? undefined : { auth: { apiKey }, source: 'CodexAuth' };
				},
			},
		},
		models,
		api: withSseTransport(openAICodexResponsesApi()),
	});
}
