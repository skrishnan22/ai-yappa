import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go';
import { setProvider } from '@flue/runtime';

type StreamOptions = {
	sessionId?: string;
	headers?: Record<string, string | null>;
};

const inner = opencodeGoProvider();

// ponytail: pi-ai ≤0.85.1 never maps sessionId → x-opencode-session (OpenCode Go 400 since 2026-09-06). Drop after a release with earendil-works/pi@561a2e0.
export function installOpenCodeGoSessionHeader(): void {
	setProvider({
		...inner,
		stream: ((model, context, options) =>
			recoverMissingFinishReason(
				inner.stream(model, context, withOpenCodeRequestLog(model.id, options)),
			)) as typeof inner.stream,
		streamSimple: ((model, context, options) =>
			recoverMissingFinishReason(
				inner.streamSimple(model, context, withOpenCodeRequestLog(model.id, options)),
			)) as typeof inner.streamSimple,
	});
}

export function withOpenCodeSessionHeader<T extends StreamOptions>(
	options: T | undefined,
): T | undefined {
	const sessionId = options?.sessionId;
	if (!sessionId) return options;
	if (options.headers && Object.hasOwn(options.headers, 'x-opencode-session')) return options;
	return {
		...options,
		headers: { ...options.headers, 'x-opencode-session': sessionId },
	};
}

// ponytail: OpenCode Go/DeepSeek often closes SSE without finish_reason; pi-ai 0.83 then discards the turn. Drop when pi-ai honors compat.supportsFinishReason (earendil-works/pi#7062).
export function recoverOpenCodeStreamError(
	event: AssistantMessageEvent,
): Extract<AssistantMessageEvent, { type: 'done' }> | undefined {
	if (event.type !== 'error') return undefined;
	if (!/Stream ended without finish_reason/i.test(event.error.errorMessage ?? '')) return undefined;
	const reason = recoveredStopReason(event.error);
	if (reason === undefined) return undefined;
	const { errorMessage: _dropped, ...message } = event.error;
	return { type: 'done', reason, message: { ...message, stopReason: reason } };
}

function recoveredStopReason(message: AssistantMessage): 'toolUse' | 'stop' | undefined {
	let hasTool = false;
	let hasText = false;
	for (const block of message.content) {
		if (block.type === 'toolCall' && block.name.length > 0) hasTool = true;
		if (block.type === 'text' && block.text.trim().length > 0) hasText = true;
	}
	if (hasTool) return 'toolUse';
	if (hasText) return 'stop';
	return undefined;
}

function recoverMissingFinishReason(
	stream: AssistantMessageEventStream,
): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of stream) {
				const recovered = recoverOpenCodeStreamError(event);
				if (recovered) {
					console.info('[slack-agent] recovered missing finish_reason', {
						reason: recovered.reason,
					});
				}
				const next: AssistantMessageEvent = recovered ?? event;
				out.push(next);
				if (next.type === 'done' || next.type === 'error') return;
			}
		} finally {
			out.end();
		}
	})();
	return out;
}

function withOpenCodeRequestLog<T extends StreamOptions>(
	modelId: string,
	options: T | undefined,
): T {
	const started = Date.now();
	console.info('[slack-agent] opencode request', { model: modelId, sessionId: options?.sessionId });
	const next = (withOpenCodeSessionHeader(options) ?? {}) as T & {
		onResponse?: (response: { status: number }, model: unknown) => unknown;
	};
	const previous = next.onResponse;
	return {
		...next,
		onResponse: (response: { status: number }, model: unknown) => {
			console.info('[slack-agent] opencode response', {
				status: response.status,
				waitMs: Date.now() - started,
			});
			return previous?.(response, model);
		},
	};
}
