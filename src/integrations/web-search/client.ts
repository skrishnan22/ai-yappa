import * as v from 'valibot';
import { jsonValueSchema, type JsonObject, type JsonValue } from '../../json.ts';
import { ProviderUnavailableError, type CooldownReason, type ProviderId } from './types.ts';

const FAILOVER_STATUS = {
	402: 'credits',
	429: 'rate_limit',
	503: 'upstream',
} as const satisfies Record<number, CooldownReason>;

/** POST JSON; on 2xx return the body as JsonValue. Failover statuses throw ProviderUnavailableError. */
export async function postProviderJson(args: {
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

	const body = parseJsonBody(text);

	if (response.ok) return body;

	const reason =
		response.status === 402 || response.status === 429 || response.status === 503
			? FAILOVER_STATUS[response.status]
			: undefined;

	if (reason) {
		throw new ProviderUnavailableError({
			provider: args.provider,
			reason,
			retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
			message: `${args.provider} unavailable (${reason}, HTTP ${response.status})`,
		});
	}

	throw new Error(
		`${args.provider} request failed: HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ''}`,
	);
}

export function parseRetryAfterMs(header: string | null, now = Date.now()): number | undefined {
	if (!header) return undefined;

	const seconds = Number(header);

	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

	const dateMs = Date.parse(header);

	if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now);

	return undefined;
}

function parseJsonBody(text: string): JsonValue {
	if (!text) return null;

	try {
		const parsed: unknown = JSON.parse(text);

		if (v.is(jsonValueSchema, parsed)) return parsed;
	} catch {
		return { message: text };
	}

	return { message: text };
}
