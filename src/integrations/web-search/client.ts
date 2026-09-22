import * as v from 'valibot';
import { jsonValueSchema, type JsonObject, type JsonValue } from '../../json.ts';
import { ProviderUnavailableError, type CooldownReason, type ProviderId } from './types.ts';

/**
 * Provider POST helper.
 *
 * Failover (ProviderUnavailableError → try next provider), aligned with
 * https://exa.ai/docs/admin/error-codes (branch on HTTP status first):
 * - 401 auth → failover (bad/missing key for this provider)
 * - 402 credits / budget → failover
 * - 429 rate limit → failover (honor Retry-After when present)
 * - Parallel 408 timeout → failover
 * - 5xx including 500/503/504 → failover
 * - transport / non-JSON 2xx → failover
 *
 * No failover (surface to the model): 400 validation, 403 forbidden/policy,
 * 404, 409, 422, etc.
 */
export async function postProviderJson(args: {
	provider: ProviderId;
	url: string;
	apiKey: string;
	body: JsonObject;
	fetchImpl?: typeof fetch;
}): Promise<JsonValue> {
	const fetchImpl = args.fetchImpl ?? fetch;

	let response: Response;

	try {
		response = await fetchImpl(args.url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-api-key': args.apiKey,
			},
			body: JSON.stringify(args.body),
		});
	} catch (error) {
		throw new ProviderUnavailableError({
			provider: args.provider,
			reason: 'upstream',
			message: `${args.provider} transport failed: ${error instanceof Error ? error.message : 'network error'}`,
		});
	}

	const text = await response.text();

	if (response.ok) {
		const body = parseJsonBody(text);

		if (body === undefined) {
			throw new ProviderUnavailableError({
				provider: args.provider,
				reason: 'upstream',
				message: `${args.provider} returned HTTP ${response.status} with non-JSON body`,
			});
		}

		return body;
	}

	const detail = formatProviderError(args.provider, response.status, text);
	const reason = failoverReason(args.provider, response.status);

	if (reason) {
		throw new ProviderUnavailableError({
			provider: args.provider,
			reason,
			retryAfterMs: readRetryAfterMs(response.headers),
			message: detail,
		});
	}

	throw new Error(detail);
}

/**
 * Exa docs: branch on status first; tags are open-ended detail.
 * @see https://exa.ai/docs/admin/error-codes
 */
function failoverReason(provider: ProviderId, status: number): CooldownReason | undefined {
	if (status === 401) return 'auth';

	if (status === 402) return 'credits';

	if (status === 429) return 'rate_limit';

	if (provider === 'parallel' && status === 408) return 'upstream';

	if (status >= 500) return 'upstream';

	return undefined;
}

const nestedProviderErrorSchema = v.pipe(
	v.object({
		message: v.optional(v.string()),
		ref_id: v.optional(v.string()),
	}),
	v.transform((error) => error.message ?? error.ref_id),
);

const providerErrorSchema = v.object({
	requestId: v.optional(v.string()),
	tag: v.optional(v.string()),
	error: v.optional(v.union([v.string(), nestedProviderErrorSchema])),
	message: v.optional(v.string()),
});

/** Build a compact message: status + Exa tag/requestId (or Parallel message) when present. */
export function formatProviderError(provider: ProviderId, status: number, text: string): string {
	const parts = [`${provider} HTTP ${status}`];
	const body = parseJsonBody(text);
	const parsed = body === undefined ? undefined : v.safeParse(providerErrorSchema, body);

	if (parsed?.success) {
		const { tag, requestId, error: errorText, message } = parsed.output;

		if (tag) parts.push(`tag=${tag}`);

		if (requestId) parts.push(`requestId=${requestId}`);

		if (errorText) parts.push(errorText);
		else if (message) parts.push(message);
	} else if (text.trim()) {
		parts.push(text.trim().slice(0, 200));
	}

	return parts.join(' | ');
}

/** Parse the standard HTTP Retry-After response header. */
export function readRetryAfterMs(headers: Headers, now = Date.now()): number | undefined {
	return parseRetryAfterMs(headers.get('retry-after'), now);
}

export function parseRetryAfterMs(header: string | null, now = Date.now()): number | undefined {
	if (!header) return undefined;

	const seconds = Number(header);

	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

	const dateMs = Date.parse(header);

	if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now);

	return undefined;
}

/** Valid JSON value, or undefined when the body is not JSON. */
function parseJsonBody(text: string): JsonValue | undefined {
	if (!text) return undefined;

	try {
		const parsed: unknown = JSON.parse(text);

		if (v.is(jsonValueSchema, parsed)) return parsed;
	} catch {
		return undefined;
	}

	return undefined;
}
