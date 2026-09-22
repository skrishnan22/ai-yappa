import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	defaultBackoffMs,
	parseRetryAfterMs,
	postProviderJson,
	readRetryAfterMs,
} from './client.ts';
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

describe('parseRetryAfterMs', () => {
	test('parses delta-seconds and HTTP-date', () => {
		expect(parseRetryAfterMs('120')).toBe(120_000);
		const now = Date.parse('2026-09-22T12:00:00.000Z');
		expect(parseRetryAfterMs('Tue, 22 Sep 2026 12:00:30 GMT', now)).toBe(30_000);
	});
});

describe('readRetryAfterMs', () => {
	test('accepts Retry-After, x-retry-after, and ms aliases case-insensitively', () => {
		expect(readRetryAfterMs(new Headers({ 'Retry-After': '5' }))).toBe(5_000);
		expect(readRetryAfterMs(new Headers({ 'X-Retry-After': '8' }))).toBe(8_000);
		expect(readRetryAfterMs(new Headers({ 'x-retry-after-ms': '1500' }))).toBe(1_500);
		expect(readRetryAfterMs(new Headers({ 'Acme-Retry-After': '3' }))).toBe(3_000);
		expect(readRetryAfterMs(new Headers({ 'content-type': 'application/json' }))).toBeUndefined();
	});
});

describe('defaultBackoffMs', () => {
	test('uses shorter Exa rate-limit cool-off than Parallel', () => {
		expect(defaultBackoffMs('exa', 'rate_limit')).toBe(2_000);
		expect(defaultBackoffMs('parallel', 'rate_limit')).toBe(60_000);
	});
});

describe('postProviderJson', () => {
	test('fails over on 5xx, transport errors, and non-JSON 2xx', async () => {
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
		).rejects.toMatchObject({ reason: 'upstream', provider: 'exa' });

		await expect(
			postProviderJson({
				provider: 'exa',
				url: 'https://api.exa.ai/search',
				apiKey: 'k',
				body: { query: 'x' },
				fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNRESET')),
			}),
		).rejects.toMatchObject({ reason: 'upstream' });

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
		).rejects.toMatchObject({ reason: 'upstream', provider: 'parallel' });
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
						headers: { 'x-retry-after': '12', 'content-type': 'application/json' },
					}),
				),
			}),
		).rejects.toMatchObject({ reason: 'rate_limit', retryAfterMs: 12_000 });
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
		const cooldown = new Map<ProviderId, { until: number; reason: 'credits' }>();
		const now = 5_000_000;

		const exaSearch = vi.fn<(input: SearchInput) => Promise<SearchResult>>(async () => {
			throw new ProviderUnavailableError({
				provider: 'exa',
				reason: 'credits',
				message: 'exa out of credits',
				retryAfterMs: 60_000,
			});
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
		expect(cooldown.get('exa')?.until).toBe(now + 60_000);

		exaSearch.mockClear();
		parallelSearch.mockClear();
		await expect(router.search({ query: 'again', maxResults: 3 })).resolves.toEqual(
			searchResult('parallel'),
		);
		expect(exaSearch).not.toHaveBeenCalled();
		expect(parallelSearch).toHaveBeenCalledOnce();
	});

	test('does not failover on ordinary provider errors', async () => {
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

		await expect(router.search({ query: 'flue', maxResults: 3 })).rejects.toThrow(/bad query/);
		expect(parallelSearch).not.toHaveBeenCalled();
	});

	test('fetch uses the same Exa-first failover path', async () => {
		const exaFetch = vi.fn<(input: FetchInput) => Promise<FetchResult>>(async () => {
			throw new ProviderUnavailableError({
				provider: 'exa',
				reason: 'rate_limit',
				message: 'exa rate limited',
			});
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
