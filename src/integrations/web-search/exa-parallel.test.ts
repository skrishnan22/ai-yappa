import { describe, expect, test, vi } from 'vitest';
import type { JsonObject } from '../../json.ts';
import { createExaProvider } from './exa.ts';
import { createParallelProvider } from './parallel.ts';
import { ProviderUnavailableError } from './types.ts';

describe('createExaProvider', () => {
	test('maps search and contents payloads', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				jsonResponse(200, {
					results: [
						{
							url: 'https://exa.ai/blog',
							title: 'Blog',
							text: 'hello from exa',
						},
					],
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse(200, {
					results: [
						{
							url: 'https://exa.ai/docs',
							title: 'Docs',
							text: 'docs body',
						},
					],
				}),
			);

		const provider = createExaProvider({ apiKey: 'exa-key', fetchImpl });

		await expect(provider.search({ query: 'exa', maxResults: 3 })).resolves.toEqual({
			provider: 'exa',
			results: [{ url: 'https://exa.ai/blog', title: 'Blog', content: 'hello from exa' }],
		});
		await expect(provider.fetch({ urls: ['https://exa.ai/docs'] })).resolves.toEqual({
			provider: 'exa',
			pages: [{ url: 'https://exa.ai/docs', title: 'Docs', content: 'docs body' }],
		});

		expect(fetchImpl).toHaveBeenNthCalledWith(
			1,
			'https://api.exa.ai/search',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({ 'x-api-key': 'exa-key' }),
			}),
		);
	});

	test('throws ProviderUnavailableError on 402', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(jsonResponse(402, { tag: 'NO_MORE_CREDITS', error: 'top up' }));

		const provider = createExaProvider({ apiKey: 'exa-key', fetchImpl });

		await expect(provider.search({ query: 'x', maxResults: 1 })).rejects.toBeInstanceOf(
			ProviderUnavailableError,
		);
	});
});

describe('createParallelProvider', () => {
	test('maps search excerpts and extract full_content', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				jsonResponse(200, {
					results: [
						{
							url: 'https://parallel.ai',
							title: 'Parallel',
							excerpts: ['one', 'two'],
						},
					],
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse(200, {
					results: [
						{
							url: 'https://parallel.ai/docs',
							title: 'Docs',
							excerpts: ['ignored when full present'],
							full_content: 'full markdown',
						},
					],
					errors: [],
				}),
			);

		const provider = createParallelProvider({ apiKey: 'parallel-key', fetchImpl });

		await expect(provider.search({ query: 'parallel', maxResults: 2 })).resolves.toEqual({
			provider: 'parallel',
			results: [
				{
					url: 'https://parallel.ai',
					title: 'Parallel',
					content: 'one\n\ntwo',
				},
			],
		});
		await expect(provider.fetch({ urls: ['https://parallel.ai/docs'] })).resolves.toEqual({
			provider: 'parallel',
			pages: [
				{
					url: 'https://parallel.ai/docs',
					title: 'Docs',
					content: 'full markdown',
				},
			],
		});
	});
});

function jsonResponse(status: number, body: JsonObject): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}
