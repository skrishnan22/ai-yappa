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
			retryAfterMs: defaultBackoffMs(args.provider, 'upstream'),
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
				retryAfterMs: defaultBackoffMs(args.provider, 'upstream'),
			});
		}

		return body;
	}

	const detail = formatProviderError(args.provider, response.status, text);
	const reason = failoverReason(response.status);

	if (reason) {
		throw new ProviderUnavailableError({
			provider: args.provider,
			reason,
			retryAfterMs: retryAfterMsFor(args.provider, reason, response),
			message: detail,
		});
	}

	throw new Error(detail);
}

/**
 * Exa docs: branch on status first; tags are open-ended detail.
 * @see https://exa.ai/docs/admin/error-codes
 */
function failoverReason(status: number): CooldownReason | undefined {
	if (status === 401) return 'auth';

	if (status === 402) return 'credits';

	if (status === 429) return 'rate_limit';

	if (status >= 500) return 'upstream';

	return undefined;
}

const providerErrorSchema = v.object({
	requestId: v.optional(v.string()),
	tag: v.optional(v.string()),
	error: v.optional(
		v.union([
			v.string(),
			v.object({
				message: v.optional(v.string()),
				ref_id: v.optional(v.string()),
			}),
		]),
	),
	message: v.optional(v.string()),
	type: v.optional(v.string()),
});

/** Build a compact message: status + Exa tag/requestId (or Parallel message) when present. */
export function formatProviderError(provider: ProviderId, status: number, text: string): string {
	const parts = [`${provider} HTTP ${status}`];
	const body = parseJsonBody(text);
	const parsed = body === undefined ? undefined : v.safeParse(providerErrorSchema, body);

	if (parsed?.success) {
		const { tag, requestId, error, message } = parsed.output;

		if (tag) parts.push(`tag=${tag}`);

		if (requestId) parts.push(`requestId=${requestId}`);

		let errorText: string | undefined;

		if (v.is(v.string(), error)) {
			errorText = error;
		} else if (
			v.is(v.object({ message: v.optional(v.string()), ref_id: v.optional(v.string()) }), error)
		) {
			errorText = error.message ?? error.ref_id;
		}

		if (errorText) parts.push(errorText);
		else if (message) parts.push(message);
	} else if (text.trim()) {
		parts.push(text.trim().slice(0, 200));
	}

	return parts.join(' | ');
}

/**
 * Prefer a retry-delay header when present; otherwise provider defaults.
 * Exa 429: wait for Retry-After when present, else backoff.
 * `Headers.get` is case-insensitive; we also probe common aliases.
 */
export function retryAfterMsFor(
	provider: ProviderId,
	reason: CooldownReason,
	response: Response,
	now = Date.now(),
): number {
	const fromHeader = readRetryAfterMs(response.headers, now);

	if (fromHeader !== undefined) return fromHeader;

	return defaultBackoffMs(provider, reason);
}

/** Delay-style headers (seconds or HTTP-date), then ms-style, then any *retry-after* name. */
const RETRY_AFTER_SECOND_HEADERS = ['retry-after', 'x-retry-after'] as const;

const RETRY_AFTER_MS_HEADERS = ['retry-after-ms', 'x-retry-after-ms'] as const;

export function readRetryAfterMs(headers: Headers, now = Date.now()): number | undefined {
	for (const name of RETRY_AFTER_SECOND_HEADERS) {
		const parsed = parseRetryAfterMs(headers.get(name), now);

		if (parsed !== undefined) return parsed;
	}

	for (const name of RETRY_AFTER_MS_HEADERS) {
		const raw = headers.get(name);

		if (!raw) continue;

		const ms = Number(raw.trim());

		if (Number.isFinite(ms) && ms >= 0) return ms;
	}

	const knownSeconds = new Set<string>(RETRY_AFTER_SECOND_HEADERS);
	const knownMs = new Set<string>(RETRY_AFTER_MS_HEADERS);

	// Catch odd prefixes (e.g. `acme-retry-after`); Headers iteration yields lowercase names.
	for (const [name, value] of headers) {
		if (!name.includes('retry-after')) continue;

		if (knownSeconds.has(name) || knownMs.has(name)) continue;

		if (name.endsWith('retry-after-ms') || name.endsWith('retry-after_ms')) {
			const ms = Number(value.trim());

			if (Number.isFinite(ms) && ms >= 0) return ms;

			continue;
		}

		const parsed = parseRetryAfterMs(value, now);

		if (parsed !== undefined) return parsed;
	}

	return undefined;
}

/** Provider-specific defaults when `Retry-After` is absent. */
export function defaultBackoffMs(provider: ProviderId, reason: CooldownReason): number {
	switch (reason) {
		case 'auth':
			// Don't hammer a bad key; try the other provider for a while.
			return 60 * 60 * 1000;
		case 'credits':
			return 24 * 60 * 60 * 1000;
		case 'rate_limit':
			// Exa ~10 QPS → short cool-off; Parallel Search is per-minute → longer.
			return provider === 'exa' ? 2_000 : 60_000;
		case 'upstream':
			// Exa 503 SERVICE_OVERLOADED: retry with backoff (independent of request rate).
			return 5_000;
		default: {
			const _exhaustive: never = reason;

			return _exhaustive;
		}
	}
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
	if (!text) return null;

	try {
		const parsed: unknown = JSON.parse(text);

		if (v.is(jsonValueSchema, parsed)) return parsed;
	} catch {
		return undefined;
	}

	return undefined;
}
