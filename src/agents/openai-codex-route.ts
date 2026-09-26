import { createProvider, type Provider, type ProviderStreams } from '@earendil-works/pi-ai';
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';

export const OPENAI_CODEX_MODEL_ID = 'gpt-5.6-sol';

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
// leaves it. app.ts registers this in the Worker; `flue run` never loads
// app.ts, has no Durable Object, and stays on OpenCode Go.
export function createOpenAICodexProvider(
	accessToken: () => Promise<string | undefined>,
): Provider {
	const catalog = openaiCodexProvider();

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
		models: catalog.getModels(),
		api: withSseTransport(openAICodexResponsesApi()),
	});
}
