import type { FlueObservation } from '@flue/runtime';

const MAX_STRING_LENGTH = 512;
const MAX_RECORD_BYTES = 16 * 1024;
const REDACTED = '[REDACTED]';

type CommonTelemetryFields = {
	duration_ms?: number;
	environment?: string;
	release?: string;
	deployment_id?: string;
	error_type?: string;
	error_code?: string;
};

export type TelemetryEvent =
	| (CommonTelemetryFields & {
			event_name: 'slack.invocation';
			outcome: 'ok' | 'refused' | 'dropped' | 'failed' | 'deduplicated';
			slack_event_id: string;
			conversation_id: string;
			signal_type: 'slack.app_mention' | 'slack.message';
			decision: 'dispatch' | 'refuse-invoker' | 'no-repo' | 'drop-untracked' | 'admission-error';
			thread_context_outcome?: 'ok' | 'failed' | 'skipped';
			submission_id?: string;
			agent_uid?: string;
			deduplicated?: boolean;
			repo?: string;
	  })
	| (CommonTelemetryFields & {
			event_name: 'agent.submission';
			outcome:
				| 'completed'
				| 'failed'
				| 'aborted'
				| 'deferred'
				| 'agent_unavailable'
				| 'attempt_cap_deferred'
				| 'terminated';
			conversation_id: string;
			submission_id?: string;
			stage: 'recovery' | 'settlement';
			recovery_operation?: string;
			attempt?: number;
			max_attempts?: number;
			flue_event_version: number;
			flue_event_index: number;
	  })
	| (CommonTelemetryFields & {
			event_name: 'agent.turn';
			outcome: 'ok' | 'failed';
			conversation_id: string;
			submission_id?: string;
			operation_id?: string;
			turn_id: string;
			purpose: 'agent' | 'compaction' | 'compaction_prefix';
			flue_event_version: number;
			flue_event_index: number;
			provider_id: string;
			provider_name: string;
			requested_model: string;
			api: string;
			response_model?: string;
			finish_reason?: string;
			provider_finish_reason?: string;
			gateway_log_id?: string;
			context_compacted?: boolean;
			input_tokens?: number;
			output_tokens?: number;
			cache_read_tokens?: number;
			cache_write_tokens?: number;
			total_tokens?: number;
			cost_total?: number;
	  })
	| (CommonTelemetryFields & {
			event_name: 'agent.tool';
			outcome: 'ok' | 'failed';
			conversation_id: string;
			submission_id?: string;
			operation_id?: string;
			turn_id?: string;
			tool_call_id: string;
			tool_name: string;
			origin?: 'model' | 'caller' | 'framework' | 'adapter';
			flue_event_version: number;
			flue_event_index: number;
			arguments_bytes?: number;
			result_bytes?: number;
	  })
	| (CommonTelemetryFields & {
			event_name: 'sandbox.lifecycle';
			outcome: 'ok' | 'skipped' | 'failed';
			conversation_id: string;
			sandbox_id?: string;
			phase: 'lookup' | 'snapshot' | 'create' | 'start' | 'reuse' | 'hydrate' | 'attach';
			sandbox_class?: string;
			prior_state?: string;
			final_state?: string;
			reused?: boolean;
			skipped?: boolean;
			repo?: string;
	  })
	| (CommonTelemetryFields & {
			event_name: 'sandbox.command';
			outcome: 'ok' | 'failed' | 'timeout';
			conversation_id: string;
			sandbox_id: string;
			sandbox_command_id: string;
			operation: 'exec' | 'mkdir';
			cwd_class: 'workspace' | 'repository' | 'other' | 'default';
			timeout_bucket?: 'none' | 'short' | 'medium' | 'long';
			exit_code?: number;
			stdout_bytes?: number;
			stderr_bytes?: number;
	  })
	| (CommonTelemetryFields & {
			event_name: 'proxy.operation';
			outcome: 'ok' | 'unauthorized' | 'invalid' | 'upstream';
			conversation_id: string;
			submission_id: string;
			repo?: string;
			proxy_operation: string;
			params_digest: string;
	  })
	| (CommonTelemetryFields & {
			event_name: 'slack.delivery';
			outcome: 'ok' | 'skipped' | 'failed';
			conversation_id: string;
			slack_event_id?: string;
			submission_id?: string;
			tool_call_id?: string;
			delivery_kind:
				| 'refusal'
				| 'missing_repo'
				| 'agent_reply'
				| 'run_card_post'
				| 'run_card_update'
				| 'terminal_notification';
			slack_method: 'chat.postMessage' | 'chat.update';
			posted: boolean;
			attempt?: number;
	  });

type TelemetryEventName = TelemetryEvent['event_name'];
type TelemetryErrorFields = Pick<CommonTelemetryFields, 'error_type' | 'error_code'>;

const commonKeys = [
	'event_name',
	'outcome',
	'duration_ms',
	'environment',
	'release',
	'deployment_id',
	'error_type',
	'error_code',
] as const;

const allowedKeys = {
	'slack.invocation': new Set([
		...commonKeys,
		'slack_event_id',
		'conversation_id',
		'signal_type',
		'decision',
		'thread_context_outcome',
		'submission_id',
		'agent_uid',
		'deduplicated',
		'repo',
	]),
	'agent.submission': new Set([
		...commonKeys,
		'conversation_id',
		'submission_id',
		'stage',
		'recovery_operation',
		'attempt',
		'max_attempts',
		'flue_event_version',
		'flue_event_index',
	]),
	'agent.turn': new Set([
		...commonKeys,
		'conversation_id',
		'submission_id',
		'operation_id',
		'turn_id',
		'purpose',
		'flue_event_version',
		'flue_event_index',
		'provider_id',
		'provider_name',
		'requested_model',
		'api',
		'response_model',
		'finish_reason',
		'provider_finish_reason',
		'gateway_log_id',
		'context_compacted',
		'input_tokens',
		'output_tokens',
		'cache_read_tokens',
		'cache_write_tokens',
		'total_tokens',
		'cost_total',
	]),
	'agent.tool': new Set([
		...commonKeys,
		'conversation_id',
		'submission_id',
		'operation_id',
		'turn_id',
		'tool_call_id',
		'tool_name',
		'origin',
		'flue_event_version',
		'flue_event_index',
		'arguments_bytes',
		'result_bytes',
	]),
	'sandbox.lifecycle': new Set([
		...commonKeys,
		'conversation_id',
		'sandbox_id',
		'phase',
		'sandbox_class',
		'prior_state',
		'final_state',
		'reused',
		'skipped',
		'repo',
	]),
	'sandbox.command': new Set([
		...commonKeys,
		'conversation_id',
		'sandbox_id',
		'sandbox_command_id',
		'operation',
		'cwd_class',
		'timeout_bucket',
		'exit_code',
		'stdout_bytes',
		'stderr_bytes',
	]),
	'proxy.operation': new Set([
		...commonKeys,
		'conversation_id',
		'submission_id',
		'repo',
		'proxy_operation',
		'params_digest',
	]),
	'slack.delivery': new Set([
		...commonKeys,
		'conversation_id',
		'slack_event_id',
		'submission_id',
		'tool_call_id',
		'delivery_kind',
		'slack_method',
		'posted',
		'attempt',
	]),
} satisfies Record<TelemetryEventName, ReadonlySet<string>>;

const outcomes = {
	'slack.invocation': new Set(['ok', 'refused', 'dropped', 'failed', 'deduplicated']),
	'agent.submission': new Set([
		'completed',
		'failed',
		'aborted',
		'deferred',
		'agent_unavailable',
		'attempt_cap_deferred',
		'terminated',
	]),
	'agent.turn': new Set(['ok', 'failed']),
	'agent.tool': new Set(['ok', 'failed']),
	'sandbox.lifecycle': new Set(['ok', 'skipped', 'failed']),
	'sandbox.command': new Set(['ok', 'failed', 'timeout']),
	'proxy.operation': new Set(['ok', 'unauthorized', 'invalid', 'upstream']),
	'slack.delivery': new Set(['ok', 'skipped', 'failed']),
} satisfies Record<TelemetryEventName, ReadonlySet<string>>;

const secretPatterns = [
	/Bearer\s+[^\s"']+/gi,
	/\bxox[baprs]-[A-Za-z0-9-]+\b/g,
	/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
	/\bsk-[A-Za-z0-9_-]{20,}\b/g,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

type ToolEnrichment = {
	origin?: 'model' | 'caller' | 'framework' | 'adapter';
	arguments_bytes?: number;
};

const toolEnrichments = new Map<string, ToolEnrichment>();

export function emitTelemetry(event: TelemetryEvent): void {
	try {
		if (!isTelemetryEvent(event)) {
			emitFailure('invalid_event');
			return;
		}
		const record = sanitizeRecord({
			schema_version: 1,
			timestamp: new Date().toISOString(),
			service: 'slack-agent',
			...event,
		});
		const serialized = JSON.stringify(record);
		if (new TextEncoder().encode(serialized).byteLength > MAX_RECORD_BYTES) {
			emitFailure('record_too_large');
			return;
		}
		console.info(record);
	} catch {
		emitFailure('emission_failed');
	}
}

export function classifyTelemetryError(error: unknown): TelemetryErrorFields {
	if (error === undefined || error === null) return {};
	if (!isRecord(error)) return { error_type: 'unknown' };
	const rawType = stringValue(error.type) ?? stringValue(error.name);
	const rawCode = stringValue(error.code);
	return {
		error_type: sanitizeString(rawType ?? 'unknown'),
		...(rawCode === undefined ? {} : { error_code: sanitizeString(rawCode) }),
	};
}

export function observeFlueTelemetry(event: FlueObservation, fallbackConversationId: string): void {
	const conversationId = event.conversationId ?? event.instanceId ?? fallbackConversationId;
	switch (event.type) {
		case 'tool_start': {
			toolEnrichments.set(toolKey(conversationId, event.toolCallId), {
				...(event.origin === undefined ? {} : { origin: event.origin }),
				...optionalNumber('arguments_bytes', serializedByteLength(event.args)),
			});
			return;
		}
		case 'tool': {
			const key = toolKey(conversationId, event.toolCallId);
			const enrichment = toolEnrichments.get(key);
			toolEnrichments.delete(key);
			emitTelemetry({
				event_name: 'agent.tool',
				outcome: event.isError ? 'failed' : 'ok',
				conversation_id: conversationId,
				submission_id: event.submissionId,
				operation_id: event.operationId,
				turn_id: event.turnId,
				tool_call_id: event.toolCallId,
				tool_name: event.toolName,
				origin: event.origin ?? enrichment?.origin,
				flue_event_version: event.v,
				flue_event_index: event.eventIndex,
				duration_ms: event.durationMs,
				arguments_bytes: enrichment?.arguments_bytes,
				result_bytes: serializedByteLength(event.effectiveResult ?? event.result),
				...classifyTelemetryError(event.errorInfo),
			});
			return;
		}
		case 'turn': {
			const usage = event.response.usage;
			emitTelemetry({
				event_name: 'agent.turn',
				outcome: event.isError ? 'failed' : 'ok',
				conversation_id: conversationId,
				submission_id: event.submissionId,
				operation_id: event.operationId,
				turn_id: event.turnId,
				purpose: event.purpose,
				flue_event_version: event.v,
				flue_event_index: event.eventIndex,
				provider_id: event.request.providerId,
				provider_name: event.request.providerName,
				requested_model: event.request.requestedModel,
				api: event.request.api,
				response_model: event.response.responseModel,
				finish_reason: event.response.finishReason,
				provider_finish_reason: event.response.providerFinishReason,
				gateway_log_id: event.response.gatewayLogId,
				context_compacted: event.request.contextCompacted,
				input_tokens: usage?.input,
				output_tokens: usage?.output,
				cache_read_tokens: usage?.cacheRead,
				cache_write_tokens: usage?.cacheWrite,
				total_tokens: usage?.totalTokens,
				cost_total: usage?.cost.total,
				duration_ms: event.durationMs,
				...classifyTelemetryError(event.response.error ?? event.errorInfo),
			});
			return;
		}
		case 'submission_recovery':
			emitTelemetry({
				event_name: 'agent.submission',
				outcome: event.outcome,
				conversation_id: conversationId,
				submission_id: event.submissionId,
				stage: 'recovery',
				recovery_operation: event.operation,
				attempt: event.attemptCount,
				max_attempts: event.maxAttempts,
				flue_event_version: event.v,
				flue_event_index: event.eventIndex,
				...classifyTelemetryError(event.error ?? event.errorInfo),
			});
			return;
		case 'submission_settled':
			emitTelemetry({
				event_name: 'agent.submission',
				outcome: event.outcome,
				conversation_id: conversationId,
				submission_id: event.submissionId,
				stage: 'settlement',
				flue_event_version: event.v,
				flue_event_index: event.eventIndex,
				...classifyTelemetryError(event.error ?? event.errorInfo),
			});
			return;
		default:
			return;
	}
}

export function resetTelemetryForTests(): void {
	toolEnrichments.clear();
}

function isTelemetryEvent(value: unknown): value is TelemetryEvent {
	if (!isRecord(value)) return false;
	const eventName = value.event_name;
	if (!isTelemetryEventName(eventName)) return false;
	if (typeof value.outcome !== 'string' || !outcomes[eventName].has(value.outcome)) return false;
	if (Object.keys(value).some((key) => !allowedKeys[eventName].has(key))) return false;
	for (const field of Object.values(value)) {
		if (
			field !== undefined &&
			typeof field !== 'string' &&
			typeof field !== 'number' &&
			typeof field !== 'boolean'
		) {
			return false;
		}
		if (typeof field === 'number' && !Number.isFinite(field)) return false;
	}
	return requiredFieldsPresent(value, eventName);
}

function requiredFieldsPresent(
	value: Record<string, unknown>,
	eventName: TelemetryEventName,
): boolean {
	if (!hasString(value, 'outcome')) return false;
	switch (eventName) {
		case 'slack.invocation':
			return hasStrings(value, ['slack_event_id', 'conversation_id', 'signal_type', 'decision']);
		case 'agent.submission':
			return (
				hasStrings(value, ['conversation_id', 'stage']) &&
				hasNumbers(value, ['flue_event_version', 'flue_event_index'])
			);
		case 'agent.turn':
			return (
				hasStrings(value, [
					'conversation_id',
					'turn_id',
					'purpose',
					'provider_id',
					'provider_name',
					'requested_model',
					'api',
				]) && hasNumbers(value, ['flue_event_version', 'flue_event_index'])
			);
		case 'agent.tool':
			return (
				hasStrings(value, ['conversation_id', 'tool_call_id', 'tool_name']) &&
				hasNumbers(value, ['flue_event_version', 'flue_event_index'])
			);
		case 'sandbox.lifecycle':
			return hasStrings(value, ['conversation_id', 'phase']);
		case 'sandbox.command':
			return hasStrings(value, [
				'conversation_id',
				'sandbox_id',
				'sandbox_command_id',
				'operation',
				'cwd_class',
			]);
		case 'proxy.operation':
			return hasStrings(value, [
				'conversation_id',
				'submission_id',
				'proxy_operation',
				'params_digest',
			]);
		case 'slack.delivery':
			return (
				hasStrings(value, ['conversation_id', 'delivery_kind', 'slack_method']) &&
				typeof value.posted === 'boolean'
			);
		default: {
			const _exhaustive: never = eventName;
			return _exhaustive;
		}
	}
}

function sanitizeRecord(value: Record<string, unknown>): Record<string, string | number | boolean> {
	const result: Record<string, string | number | boolean> = {};
	for (const [key, field] of Object.entries(value)) {
		if (typeof field === 'string') {
			result[key] = key === 'repo' ? sanitizeRepository(field) : sanitizeString(field);
		}
		if (typeof field === 'number' || typeof field === 'boolean') result[key] = field;
	}
	return result;
}

function sanitizeRepository(value: string): string {
	if (value.includes('://')) {
		try {
			const url = new URL(value);
			const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
			const owner = segments[0];
			const repo = segments[1];
			if (owner === undefined || repo === undefined) return '[INVALID_REPO]';
			return sanitizeString(`${owner}/${repo.replace(/\.git$/i, '')}`);
		} catch {
			return '[INVALID_REPO]';
		}
	}
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value)) return '[INVALID_REPO]';
	return sanitizeString(value.replace(/\.git$/i, ''));
}

function sanitizeString(value: string): string {
	let next = value;
	for (const pattern of secretPatterns) next = next.replace(pattern, REDACTED);
	return replaceControlCharacters(next).slice(0, MAX_STRING_LENGTH);
}

function replaceControlCharacters(value: string): string {
	let result = '';
	for (const character of value) {
		const code = character.charCodeAt(0);
		result += code <= 31 || code === 127 ? ' ' : character;
	}
	return result;
}

function emitFailure(reason: 'invalid_event' | 'record_too_large' | 'emission_failed'): void {
	try {
		console.error({
			schema_version: 1,
			event_name: 'telemetry.emit_failure',
			timestamp: new Date().toISOString(),
			service: 'slack-agent',
			outcome: 'failed',
			reason,
		});
	} catch {
		// Telemetry must never affect the product path.
	}
}

function serializedByteLength(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	try {
		return new TextEncoder().encode(JSON.stringify(value)).byteLength;
	} catch {
		return undefined;
	}
}

function optionalNumber<Key extends string>(
	key: Key,
	value: number | undefined,
): Record<Key, number> | Record<never, never> {
	return value === undefined ? {} : { [key]: value };
}

function toolKey(conversationId: string, toolCallId: string): string {
	return `${conversationId}\u0000${toolCallId}`;
}

function isTelemetryEventName(value: unknown): value is TelemetryEventName {
	return typeof value === 'string' && Object.hasOwn(allowedKeys, value);
}

function hasStrings(value: Record<string, unknown>, keys: string[]): boolean {
	return keys.every((key) => hasString(value, key));
}

function hasString(value: Record<string, unknown>, key: string): boolean {
	return typeof value[key] === 'string' && value[key].length > 0;
}

function hasNumbers(value: Record<string, unknown>, keys: string[]): boolean {
	return keys.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]));
}

function stringValue(value: unknown): string | undefined {
	if (typeof value === 'string' && value.length > 0) return value;
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
