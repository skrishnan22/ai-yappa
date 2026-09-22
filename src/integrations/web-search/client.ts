import * as v from 'valibot';
import { jsonValueSchema, type JsonObject, type JsonValue } from '../../json.ts';
import { ProviderUnavailableError, type CooldownReason, type ProviderId } from './types.ts';

/**
 * POST JSON to a search provider.
 * - 2xx + valid JSON → body
 * - 402 / 429 / 5xx / transport / invalid JSON → ProviderUnavailableError (router may failover)
 * - other 4xx → plain Error (no failover)
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

	const reason = failoverReason(response.status);

	if (reason) {
		throw new ProviderUnavailableError({
			provider: args.provider,
			reason,
			retryAfterMs: retryAfterMsFor(args.provider, reason, response),
			message: `${args.provider} unavailable (${reason}, HTTP ${response.status})`,
		});
	}

	throw new Error(
		`${args.provider} request failed: HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ''}`,
	);
}

function failoverReason(status: number): CooldownReason | undefined {
	if (status === 402) return 'credits';

	if (status === 429) return 'rate_limit';

	if (status >= 500) return 'upstream';

	return undefined;
}

/**
 * Prefer standard `Retry-After` when present (RFC 9110).
 * Exa and Parallel do not document sending it; fall back to provider defaults.
 */
export function retryAfterMsFor(
	provider: ProviderId,
	reason: CooldownReason,
	response: Response,
): number {
	const fromHeader = parseRetryAfterMs(response.headers.get('retry-after'));

	if (fromHeader !== undefined) return fromHeader;

	return defaultBackoffMs(provider, reason);
}

/** Provider-specific defaults when `Retry-After` is absent. */
export function defaultBackoffMs(provider: ProviderId, reason: CooldownReason): number {
	switch (provider) {
		case 'exa': {
			if (reason === 'rate_limit') return 2_000;

			if (reason === 'credits') return 24 * 60 * 60 * 1000;

			return 5_000;
		}

		case 'parallel': {
			if (reason === 'rate_limit') return 60_000;

			if (reason === 'credits') return 24 * 60 * 60 * 1000;

			return 5_000;
		}

		default: {
			const _exhaustive: never = provider;

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
