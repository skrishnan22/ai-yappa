import { createProvider, envApiKeyAuth, type ProviderStreams } from '@earendil-works/pi-ai';
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { setProvider } from '@flue/runtime';

export const OPENAI_CODEX_MODEL_ID = 'gpt-5.6-sol';

export const openAICodexModelSpecifier = `openai-codex/${OPENAI_CODEX_MODEL_ID}`;

// ponytail: hand-supplied ChatGPT access token until the CodexAuth Durable
// Object owns device-code login and refresh (ADR 0020).
export const OPENAI_CODEX_ACCESS_TOKEN_ENV = 'OPENAI_CODEX_ACCESS_TOKEN';

export function hasOpenAICodexCredential(env: { OPENAI_CODEX_ACCESS_TOKEN?: string }): boolean {
	return Boolean(env.OPENAI_CODEX_ACCESS_TOKEN?.trim());
}

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

const catalog = openaiCodexProvider();

setProvider(
	createProvider({
		id: catalog.id,
		name: catalog.name,
		baseUrl: catalog.baseUrl,
		auth: {
			apiKey: envApiKeyAuth('ChatGPT subscription access token', [OPENAI_CODEX_ACCESS_TOKEN_ENV]),
		},
		models: catalog.getModels(),
		api: withSseTransport(openAICodexResponsesApi()),
	}),
);
