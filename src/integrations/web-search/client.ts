import * as v from 'valibot';
import { jsonValueSchema, type JsonObject, type JsonValue } from '../../json.ts';
import { ProviderUnavailableError, type ProviderId } from './types.ts';

const LONG_COOLDOWN_MS = 60 * 60 * 1000;

const TRANSIENT_COOLDOWN_MS = 5 * 60 * 1000;

/** POST JSON and distinguish provider unavailability from terminal request errors. */
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
		throw new ProviderUnavailableError(
			`${args.provider} transport failed: ${error instanceof Error ? error.message : 'network error'}`,
			TRANSIENT_COOLDOWN_MS,
		);
	}

	const text = await response.text();

	if (response.ok) {
		const body = parseJsonBody(text);

		if (body === undefined) {
			throw new ProviderUnavailableError(
				`${args.provider} returned HTTP ${response.status} with non-JSON body`,
				TRANSIENT_COOLDOWN_MS,
			);
		}

		return body;
	}

	const errorBody = text.trim().slice(0, 200);
	const message = `${args.provider} HTTP ${response.status}${errorBody ? `: ${errorBody}` : ''}`;
	const cooldownMs = responseCooldownMs(response);

	if (cooldownMs !== undefined) {
		throw new ProviderUnavailableError(message, cooldownMs);
	}

	throw new Error(message);
}

function responseCooldownMs(response: Response): number | undefined {
	const { status } = response;

	const providerUnavailable =
		status === 401 || status === 402 || status === 408 || status === 429 || status >= 500;

	if (!providerUnavailable) return undefined;

	return (
		parseRetryAfterMs(response.headers.get('retry-after')) ??
		(status === 401 || status === 402 ? LONG_COOLDOWN_MS : TRANSIENT_COOLDOWN_MS)
	);
}

function parseRetryAfterMs(header: string | null): number | undefined {
	if (!header) return undefined;

	const seconds = Number(header);

	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

	const dateMs = Date.parse(header);

	if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());

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
