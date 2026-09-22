import * as v from 'valibot';
import { jsonValueSchema, type JsonObject, type JsonValue } from '../../json.ts';
import { parseRetryAfterMs } from './cooldown.ts';
import { ProviderUnavailableError, type CooldownReason, type ProviderId } from './types.ts';

const nestedErrorSchema = v.object({
	message: v.optional(v.string()),
});

const errorTagSchema = v.object({
	tag: v.optional(v.string()),
	error: v.optional(v.union([v.string(), nestedErrorSchema])),
	message: v.optional(v.string()),
});

export async function postJson(args: {
	provider: ProviderId;
	url: string;
	apiKey: string;
	body: JsonObject;
	fetchImpl?: typeof fetch;
}): Promise<JsonValue> {
	const fetchImpl = args.fetchImpl ?? fetch;

	const response = await fetchImpl(args.url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': args.apiKey,
		},
		body: JSON.stringify(args.body),
	});

	const text = await response.text();

	const payload = parseResponseBody(text);

	if (response.ok) return payload;

	const unavailable = classifyHttpFailure({
		provider: args.provider,
		status: response.status,
		payload,
		retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
	});

	if (unavailable) throw unavailable;

	const detail = errorDetail(payload) ?? (text.slice(0, 200) || `HTTP ${response.status}`);
	throw new Error(`${args.provider} request failed: ${detail}`);
}

export function classifyHttpFailure(args: {
	provider: ProviderId;
	status: number;
	payload: JsonValue;
	retryAfterMs?: number;
}): ProviderUnavailableError | undefined {
	const reason = failoverReason(args.status, args.payload);

	if (!reason) return undefined;

	return new ProviderUnavailableError({
		provider: args.provider,
		reason,
		status: args.status,
		retryAfterMs: args.retryAfterMs,
		message: `${args.provider} unavailable (${reason}): ${errorDetail(args.payload) ?? `HTTP ${args.status}`}`,
	});
}

function failoverReason(status: number, payload: JsonValue): CooldownReason | undefined {
	if (status === 429) return 'rate_limit';

	if (status === 402) return 'credits';

	const parsed = v.safeParse(errorTagSchema, payload);
	const tag = parsed.success ? (parsed.output.tag ?? '').toUpperCase() : '';
	const message = (errorDetail(payload) ?? '').toLowerCase();

	if (
		tag === 'NO_MORE_CREDITS' ||
		tag === 'API_KEY_BUDGET_EXCEEDED' ||
		tag === 'TEAM_BUDGET_EXCEEDED' ||
		message.includes('no more credits') ||
		message.includes('exceeded your credits') ||
		message.includes('insufficient credits')
	) {
		return 'credits';
	}

	if (tag === 'RATE_LIMIT_EXCEEDED' || message.includes('rate limit')) {
		return 'rate_limit';
	}

	if (status === 503 || tag === 'SERVICE_OVERLOADED') {
		return 'upstream';
	}

	return undefined;
}

function parseResponseBody(text: string): JsonValue {
	if (!text) return null;

	try {
		const parsed: unknown = JSON.parse(text);

		if (v.is(jsonValueSchema, parsed)) return parsed;
	} catch {
		return { message: text };
	}

	return { message: text };
}

function errorDetail(payload: JsonValue): string | undefined {
	const parsed = v.safeParse(errorTagSchema, payload);

	if (!parsed.success) return undefined;

	const error = parsed.output.error;

	if (v.is(v.string(), error)) return error;

	if (v.is(nestedErrorSchema, error) && error.message) return error.message;

	return parsed.output.message;
}

export function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;

	return `${text.slice(0, maxChars)}…`;
}
