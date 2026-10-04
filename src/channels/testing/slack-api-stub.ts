import * as v from 'valibot';
import { vi } from 'vitest';
import type { JsonValue } from '../../json.ts';

export type SlackApiCall = {
	method: string;
	token: string;
	params: Record<string, JsonValue>;
};

export type SlackApiResponder = (call: SlackApiCall) => Promise<Record<string, JsonValue>>;

// The WebClient form-encodes arguments. Decode booleans and JSON-encoded
// objects and arrays so tests can assert on the arguments they passed.
function decodeParam(value: string): JsonValue {
	if (value === 'true') return true;

	if (value === 'false') return false;

	return value.startsWith('[') || value.startsWith('{') ? JSON.parse(value) : value;
}

// Replaces the network only; the real Slack WebClient builds and sends the request.
export function stubSlackApi(
	respond: SlackApiResponder = async () => ({ ok: true }),
): SlackApiCall[] {
	const calls: SlackApiCall[] = [];

	vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		const body = await new Response(init?.body).text();

		const call: SlackApiCall = {
			method: new URL(String(input)).pathname.replace('/api/', ''),
			token: (headers.get('authorization') ?? '').replace('Bearer ', ''),
			params: Object.fromEntries(
				Array.from(new URLSearchParams(body), ([key, value]) => [key, decodeParam(value)]),
			),
		};

		calls.push(call);

		const response = await respond(call);

		return Response.json(response);
	});

	return calls;
}

export function stringParam(call: Pick<SlackApiCall, 'params'>, key: string): string {
	return v.parse(v.string(), call.params[key]);
}
