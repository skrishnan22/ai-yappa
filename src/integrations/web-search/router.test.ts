import { afterEach, describe, expect, test, vi } from 'vitest';
import { ProviderCooldown, parseRetryAfterMs, resolveBackoffMs } from './cooldown.ts';
import { classifyHttpFailure } from './http.ts';
import { createWebSearchRouter, resolveWebSearchProviders } from './router.ts';
import {
	ProviderUnavailableError,
	type FetchInput,
	type FetchResult,
	type SearchInput,
	type SearchResult,
	type WebSearchProvider,
} from './types.ts';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('parseRetryAfterMs', () => {
	test('parses delta-seconds', () => {
		expect(parseRetryAfterMs('120')).toBe(120_000);
	});

	test('parses HTTP-date relative to now', () => {
		const now = Date.parse('2026-09-22T12:00:00.000Z');
		expect(parseRetryAfterMs('Tue, 22 Sep 2026 12:00:30 GMT', now)).toBe(30_000);
	});
});

describe('resolveBackoffMs', () => {
	test('caps Retry-After and falls back by reason', () => {
		expect(resolveBackoffMs('rate_limit', 2 * 60 * 60 * 1000)).toBe(60 * 60 * 1000);
		expect(resolveBackoffMs('credits')).toBe(24 * 60 * 60 * 1000);
		expect(resolveBackoffMs('upstream')).toBe(30_000);
	});
});

describe('ProviderCooldown', () => {
	test('marks and expires entries', () => {
		const cooldown = new ProviderCooldown();
		const now = 1_000_000;
		cooldown.mark('exa', 'rate_limit', { now, retryAfterMs: 5_000 });
		expect(cooldown.isCooling('exa', now + 1_000)).toBe(true);
		expect(cooldown.isCooling('exa', now + 6_000)).toBe(false);
	});
});

describe('classifyHttpFailure', () => {
	test('maps 402/429/503 and credit tags to failover errors', () => {
		expect(
			classifyHttpFailure({
				provider: 'exa',
				status: 402,
				payload: { tag: 'NO_MORE_CREDITS', error: 'out' },
			}),
		).toMatchObject({ reason: 'credits', provider: 'exa' });

		expect(
			classifyHttpFailure({
				provider: 'parallel',
				status: 429,
				payload: { error: 'slow down' },
				retryAfterMs: 10_000,
			}),
		).toMatchObject({ reason: 'rate_limit', retryAfterMs: 10_000 });

		expect(
			classifyHttpFailure({
				provider: 'exa',
				status: 503,
				payload: { tag: 'SERVICE_OVERLOADED' },
			}),
		).toMatchObject({ reason: 'upstream' });

		expect(
			classifyHttpFailure({
				provider: 'exa',
				status: 400,
				payload: { error: 'bad query' },
			}),
		).toBeUndefined();
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

		const exa = stubProvider('exa', { search: exaSearch });

		const parallel = stubProvider('parallel', { search: parallelSearch });

		const router = createWebSearchRouter({
			providers: [exa, parallel],
			cooldown: new ProviderCooldown(),
		});

		await expect(router.search({ query: 'flue', maxResults: 3 })).resolves.toEqual(
			searchResult('exa'),
		);
		expect(exaSearch).toHaveBeenCalledOnce();
		expect(parallelSearch).not.toHaveBeenCalled();
	});

	test('fails over to Parallel on Exa unavailability and cools Exa', async () => {
		const cooldown = new ProviderCooldown();

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

		const exa = stubProvider('exa', { search: exaSearch });

		const parallel = stubProvider('parallel', { search: parallelSearch });

		const router = createWebSearchRouter({
			providers: [exa, parallel],
			cooldown,
			now: () => now,
		});

		await expect(router.search({ query: 'flue', maxResults: 3 })).resolves.toEqual(
			searchResult('parallel'),
		);
		expect(cooldown.isCooling('exa', now + 1_000)).toBe(true);

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
			cooldown: new ProviderCooldown(),
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
			cooldown: new ProviderCooldown(),
		});

		await expect(router.fetch({ urls: ['https://example.com'] })).resolves.toEqual(
			fetchResult('parallel'),
		);
	});
});

function searchResult(provider: 'exa' | 'parallel'): SearchResult {
	return {
		provider,
		results: [{ url: 'https://example.com', title: 'Example', content: 'snippet' }],
	};
}

function fetchResult(provider: 'exa' | 'parallel'): FetchResult {
	return {
		provider,
		pages: [{ url: 'https://example.com', title: 'Example', content: 'body' }],
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
