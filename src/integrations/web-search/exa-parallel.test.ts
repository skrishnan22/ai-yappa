import { describe, expect, test, vi } from 'vitest';
import * as v from 'valibot';
import { jsonObjectSchema, type JsonObject } from '../../json.ts';
import { createExaProvider } from './exa.ts';
import { createParallelProvider } from './parallel.ts';
import { ProviderUnavailableError } from './types.ts';

describe('createExaProvider', () => {
	test('returns provider JSON under searchResults / fetchResults', async () => {
		const searchBody = {
			results: [{ url: 'https://exa.ai/blog', title: 'Blog', text: 'hello' }],
		};

		const fetchBody = {
			results: [{ url: 'https://exa.ai/docs', title: 'Docs', text: 'docs' }],
		};

		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse(200, searchBody))
			.mockResolvedValueOnce(jsonResponse(200, fetchBody));

		const provider = createExaProvider({ apiKey: 'exa-key', fetchImpl });

		await expect(provider.search({ query: 'exa', maxResults: 3 })).resolves.toEqual({
			provider: 'exa',
			searchResults: searchBody,
		});
		await expect(provider.fetch({ urls: ['https://exa.ai/docs'] })).resolves.toEqual({
			provider: 'exa',
			fetchResults: fetchBody,
		});

		expect(requestBody(fetchImpl, 1)).toMatchObject({
			contents: { highlights: true },
		});
		expect(requestBody(fetchImpl, 2)).toMatchObject({
			urls: ['https://exa.ai/docs'],
			text: { maxCharacters: 10_000 },
		});
	});

	test('throws ProviderUnavailableError on 402', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(jsonResponse(402, { error: 'top up' }));

		const provider = createExaProvider({ apiKey: 'exa-key', fetchImpl });

		await expect(provider.search({ query: 'x', maxResults: 1 })).rejects.toBeInstanceOf(
			ProviderUnavailableError,
		);
	});
});

describe('createParallelProvider', () => {
	test('returns provider JSON under searchResults / fetchResults', async () => {
		const searchBody = {
			results: [{ url: 'https://parallel.ai', excerpts: ['one'] }],
		};

		const fetchBody = {
			results: [{ url: 'https://parallel.ai/docs', full_content: 'full' }],
			errors: [],
		};

		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse(200, searchBody))
			.mockResolvedValueOnce(jsonResponse(200, fetchBody));

		const provider = createParallelProvider({ apiKey: 'parallel-key', fetchImpl });

		await expect(provider.search({ query: 'parallel', maxResults: 2 })).resolves.toEqual({
			provider: 'parallel',
			searchResults: searchBody,
		});
		await expect(provider.fetch({ urls: ['https://parallel.ai/docs'] })).resolves.toEqual({
			provider: 'parallel',
			fetchResults: fetchBody,
		});

		expect(requestBody(fetchImpl, 2)).toMatchObject({
			urls: ['https://parallel.ai/docs'],
			advanced_settings: { full_content: { max_chars_per_result: 10_000 } },
		});
	});
});

function requestBody(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>, call: number): JsonObject {
	const init = fetchImpl.mock.calls[call - 1]?.[1];
	const body = v.safeParse(v.string(), init?.body);

	if (!body.success) throw new Error(`request ${call} did not have a JSON body`);

	const parsed: unknown = JSON.parse(body.output);

	return v.parse(jsonObjectSchema, parsed);
}

function jsonResponse(status: number, body: JsonObject): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}
