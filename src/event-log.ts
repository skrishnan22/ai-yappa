import { observe, type FlueObservation } from '@flue/runtime';

const ERROR_TEXT_LIMIT = 500;

type EventLogContext = { instanceId: string; agentName: string | undefined };

function byteLength(json: string | undefined): number | undefined {
	return json === undefined ? undefined : new TextEncoder().encode(json).length;
}

/** One log record per tool call and model turn. Args, results, and prompts are logged as sizes only. */
export function formatEventLog(event: FlueObservation, context?: EventLogContext) {
	const correlation = {
		service: 'slack-agent',
		timestamp: event.timestamp,
		submissionId: event.submissionId,
		instanceId: event.instanceId ?? context?.instanceId,
		conversationId: event.conversationId,
		agentName: event.agentName ?? context?.agentName,
	};

	switch (event.type) {
		case 'tool_start':
			return {
				event: 'flue.tool_start',
				...correlation,
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				argsBytes: byteLength(JSON.stringify(event.args)),
			};
		case 'tool':
			return {
				event: 'flue.tool',
				...correlation,
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				isError: event.isError,
				durationMs: event.durationMs,
				resultBytes: byteLength(JSON.stringify(event.result)),
				errorType: event.errorInfo?.type,
				error: event.errorInfo?.message?.slice(0, ERROR_TEXT_LIMIT),
			};
		case 'turn': {
			const usage = event.response.usage;

			return {
				event: 'flue.turn',
				...correlation,
				turnId: event.turnId,
				purpose: event.purpose,
				durationMs: event.durationMs,
				isError: event.isError,
				usage: usage && {
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
					totalTokens: usage.totalTokens,
				},
			};
		}

		default:
			return null;
	}
}

export function logRuntimeEvent(event: FlueObservation, context?: EventLogContext): void {
	try {
		const record = formatEventLog(event, context);

		if (!record) return;

		const line = JSON.stringify(record);

		if ('isError' in record && record.isError) console.warn(line);
		else console.log(line);
	} catch {
		// Logging is best effort and must not affect agent execution.
	}
}

export function registerEventLog(): () => void {
	return observe((event, ctx) => {
		logRuntimeEvent(event, { instanceId: ctx.id, agentName: ctx.agentName });
	});
}
