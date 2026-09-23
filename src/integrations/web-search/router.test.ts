import { afterEach, describe, expect, test, vi } from 'vitest';
import { postProviderJson } from './client.ts';
import { createWebSearchRouter, resolveWebSearchProviders } from './router.ts';
import {
	ProviderUnavailableError,
	type FetchInput,
	type FetchResult,
	type ProviderId,
	type SearchInput,
	type SearchResult,
	type WebSearchProvider,
} from './types.ts';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('postProviderJson', () => {
	test('uses a five-minute cooldown for 5xx, transport errors, and non-JSON 2xx', async () => {
		await expect(
			postProviderJson({
				provider: 'exa',
				url: 'https://api.exa.ai/search',
				apiKey: 'k',
				body: { query: 'x' },
				fetchImpl: vi
					.fn<typeof fetch>()
					.mockResolvedValue(
						new Response('oops', { status: 502, headers: { 'content-type': 'text/plain' } }),
					),
			}),
		).rejects.toMatchObject({ cooldownMs: 5 * 60 * 1000 });

		await expect(
			postProviderJson({
				provider: 'exa',
				url: 'https://api.exa.ai/search',
				apiKey: 'k',
				body: { query: 'x' },
				fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNRESET')),
			}),
		).rejects.toMatchObject({ cooldownMs: 5 * 60 * 1000 });

		await expect(
			postProviderJson({
				provider: 'parallel',
				url: 'https://api.parallel.ai/v1/search',
				apiKey: 'k',
				body: { query: 'x' },
				fetchImpl: vi
					.fn<typeof fetch>()
					.mockResolvedValue(new Response('not-json', { status: 200 })),
			}),
		).rejects.toMatchObject({ cooldownMs: 5 * 60 * 1000 });
	});

	test('treats an empty 2xx body as an unavailable provider', async () => {
		await expect(
			postProviderJson({
				provider: 'exa',
				url: 'https://api.exa.ai/search',
				apiKey: 'k',
				body: { query: 'x' },
				fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 })),
			}),
		).rejects.toMatchObject({ cooldownMs: 5 * 60 * 1000 });
	});

	test('uses a one-hour cooldown for 401 and 402', async () => {
		await expect(
			postProviderJson({
				provider: 'exa',
				url: 'https://api.exa.ai/search',
				apiKey: 'k',
				body: { query: 'x' },
				fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
					new Response(JSON.stringify({ tag: 'INVALID_API_KEY', error: 'bad key' }), {
						status: 401,
						headers: { 'content-type': 'application/json' },
					}),
				),
			}),
		).rejects.toMatchObject({
			cooldownMs: 60 * 60 * 1000,
			message: expect.stringContaining('INVALID_API_KEY'),
		});

		await expect(
			postProviderJson({
				provider: 'exa',
				url: 'https://api.exa.ai/search',
				apiKey: 'k',
				body: { query: 'x' },
				fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
					new Response(JSON.stringify({ tag: 'NO_MORE_CREDITS', error: 'top up' }), {
						status: 402,
						headers: { 'content-type': 'application/json' },
					}),
				),
			}),
		).rejects.toMatchObject({
			cooldownMs: 60 * 60 * 1000,
			message: expect.stringContaining('NO_MORE_CREDITS'),
		});
	});

	test('does not failover on 400 validation errors', async () => {
		await expect(
			postProviderJson({
				provider: 'exa',
				url: 'https://api.exa.ai/search',
				apiKey: 'k',
				body: { query: 'x' },
				fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
					new Response(
						JSON.stringify({
							tag: 'INVALID_REQUEST_BODY',
							error: 'bad body',
							requestId: 'abc',
						}),
						{ status: 400, headers: { 'content-type': 'application/json' } },
					),
				),
			}),
		).rejects.toThrow(/INVALID_REQUEST_BODY/);
	});

	test('honors Retry-After when present', async () => {
		await expect(
			postProviderJson({
				provider: 'exa',
				url: 'https://api.exa.ai/search',
				apiKey: 'k',
				body: { query: 'x' },
				fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
					new Response('{}', {
						status: 429,
						headers: { 'retry-after': '12', 'content-type': 'application/json' },
					}),
				),
			}),
		).rejects.toMatchObject({ cooldownMs: 12_000 });

		vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-22T12:00:00.000Z'));

		await expect(
			postProviderJson({
				provider: 'parallel',
				url: 'https://api.parallel.ai/v1/search',
				apiKey: 'k',
				body: { objective: 'x' },
				fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
					new Response('{}', {
						status: 503,
						headers: { 'retry-after': 'Tue, 22 Sep 2026 12:00:30 GMT' },
					}),
				),
			}),
		).rejects.toMatchObject({ cooldownMs: 30_000 });
	});

	test('uses a five-minute cooldown for Parallel 408 responses', async () => {
		await expect(
			postProviderJson({
				provider: 'parallel',
				url: 'https://api.parallel.ai/v1/search',
				apiKey: 'k',
				body: { objective: 'x' },
				fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
					new Response(JSON.stringify({ error: { message: 'timed out' } }), {
						status: 408,
						headers: { 'content-type': 'application/json' },
					}),
				),
			}),
		).rejects.toMatchObject({ cooldownMs: 5 * 60 * 1000 });
	});
});

describe('resolveWebSearchProviders', () => {
	test('builds only providers with non-empty keys in Exa-then-Parallel order', () => {
		const providers = resolveWebSearchProviders({
			EXA_API_KEY: 'exa-key',
			PARALLEL_API_KEY: ' parallel-key ',
		});

		expect(providers.map((provider) => provider.id)).toEqual(['exa', 'parallel']);
		expect(resolveWebSearchProviders({}).map((provider) => provider.id)).toEqual([]);
	});
});

describe('createWebSearchRouter', () => {
	test('prefers Exa and does not call Parallel on success', async () => {
		const exaSearch = vi.fn<(input: SearchInput) => Promise<SearchResult>>(async () =>
			searchResult('exa'),
		);

		const parallelSearch = vi.fn<(input: SearchInput) => Promise<SearchResult>>(async () =>
			searchResult('parallel'),
		);

		const router = createWebSearchRouter({
			providers: [
				stubProvider('exa', { search: exaSearch }),
				stubProvider('parallel', { search: parallelSearch }),
			],
			cooldown: new Map(),
		});

		await expect(router.search({ query: 'flue', maxResults: 3 })).resolves.toEqual(
			searchResult('exa'),
		);
		expect(exaSearch).toHaveBeenCalledOnce();
		expect(parallelSearch).not.toHaveBeenCalled();
	});

	test('fails over to Parallel on Exa unavailability and cools Exa', async () => {
		const cooldown = new Map<ProviderId, number>();
		const now = 5_000_000;

		const exaSearch = vi.fn<(input: SearchInput) => Promise<SearchResult>>(async () => {
			throw new ProviderUnavailableError('exa out of credits', 60_000);
		});

		const parallelSearch = vi.fn<(input: SearchInput) => Promise<SearchResult>>(async () =>
			searchResult('parallel'),
		);

		const router = createWebSearchRouter({
			providers: [
				stubProvider('exa', { search: exaSearch }),
				stubProvider('parallel', { search: parallelSearch }),
			],
			cooldown,
			now: () => now,
		});

		await expect(router.search({ query: 'flue', maxResults: 3 })).resolves.toEqual(
			searchResult('parallel'),
		);
		expect(cooldown.get('exa')).toBe(now + 60_000);

		exaSearch.mockClear();
		parallelSearch.mockClear();
		await expect(router.search({ query: 'again', maxResults: 3 })).resolves.toEqual(
			searchResult('parallel'),
		);
		expect(exaSearch).not.toHaveBeenCalled();
		expect(parallelSearch).toHaveBeenCalledOnce();
	});

	test('throws ordinary provider errors without trying Parallel', async () => {
		const exaSearch = vi.fn<(input: SearchInput) => Promise<SearchResult>>(async () => {
			throw new Error('exa request failed: bad query');
		});

		const parallelSearch = vi.fn<(input: SearchInput) => Promise<SearchResult>>(async () =>
			searchResult('parallel'),
		);

		const router = createWebSearchRouter({
			providers: [
				stubProvider('exa', { search: exaSearch }),
				stubProvider('parallel', { search: parallelSearch }),
			],
			cooldown: new Map(),
		});

		await expect(router.search({ query: 'flue', maxResults: 3 })).rejects.toThrow(
			'exa request failed: bad query',
		);
		expect(parallelSearch).not.toHaveBeenCalled();
	});

	test('fetch uses the same Exa-first failover path', async () => {
		const exaFetch = vi.fn<(input: FetchInput) => Promise<FetchResult>>(async () => {
			throw new ProviderUnavailableError('exa rate limited', 5 * 60 * 1000);
		});

		const parallelFetch = vi.fn<(input: FetchInput) => Promise<FetchResult>>(async () =>
			fetchResult('parallel'),
		);

		const router = createWebSearchRouter({
			providers: [
				stubProvider('exa', { fetch: exaFetch }),
				stubProvider('parallel', { fetch: parallelFetch }),
			],
			cooldown: new Map(),
		});

		await expect(router.fetch({ urls: ['https://example.com'] })).resolves.toEqual(
			fetchResult('parallel'),
		);
	});

	test('throws when every provider is unavailable', async () => {
		const router = createWebSearchRouter({
			providers: [
				stubProvider('exa', {
					search: vi.fn<(input: SearchInput) => Promise<SearchResult>>(async () => {
						throw new ProviderUnavailableError('exa down', 5 * 60 * 1000);
					}),
				}),
				stubProvider('parallel', {
					search: vi.fn<(input: SearchInput) => Promise<SearchResult>>(async () => {
						throw new ProviderUnavailableError('parallel down', 5 * 60 * 1000);
					}),
				}),
			],
			cooldown: new Map(),
		});

		await expect(router.search({ query: 'flue', maxResults: 3 })).rejects.toThrow(
			/exa down.*parallel down/,
		);
	});

	test('retries a provider after its cooldown expires', async () => {
		let now = 5_000_000;
		const cooldown = new Map<ProviderId, number>([['exa', now + 60_000]]);

		const exaSearch = vi.fn<(input: SearchInput) => Promise<SearchResult>>(async () =>
			searchResult('exa'),
		);

		const parallelSearch = vi.fn<(input: SearchInput) => Promise<SearchResult>>(async () =>
			searchResult('parallel'),
		);

		const router = createWebSearchRouter({
			providers: [
				stubProvider('exa', { search: exaSearch }),
				stubProvider('parallel', { search: parallelSearch }),
			],
			cooldown,
			now: () => now,
		});

		await expect(router.search({ query: 'first', maxResults: 3 })).resolves.toEqual(
			searchResult('parallel'),
		);

		now += 60_001;
		await expect(router.search({ query: 'second', maxResults: 3 })).resolves.toEqual(
			searchResult('exa'),
		);
		expect(exaSearch).toHaveBeenCalledOnce();
	});
});

function searchResult(provider: 'exa' | 'parallel'): SearchResult {
	return {
		provider,
		searchResults: { results: [{ url: 'https://example.com' }] },
	};
}

function fetchResult(provider: 'exa' | 'parallel'): FetchResult {
	return {
		provider,
		fetchResults: { results: [{ url: 'https://example.com' }] },
	};
}

function stubProvider(
	id: 'exa' | 'parallel',
	overrides: Partial<WebSearchProvider>,
): WebSearchProvider {
	return {
		id,
		search: vi.fn<(input: SearchInput) => Promise<SearchResult>>(async () => searchResult(id)),
		fetch: vi.fn<(input: FetchInput) => Promise<FetchResult>>(async () => fetchResult(id)),
		...overrides,
	};
}
