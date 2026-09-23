import type { JsonValue } from '../../json.ts';

export type ProviderId = 'exa' | 'parallel';

export type SearchInput = {
	query: string;
	maxResults: number;
};

export type FetchInput = {
	urls: string[];
};

/** Stable wrapper; `searchResults` is the provider's own JSON body. */
export type SearchResult = {
	provider: ProviderId;
	searchResults: JsonValue;
};

/** Stable wrapper; `fetchResults` is the provider's own JSON body. */
export type FetchResult = {
	provider: ProviderId;
	fetchResults: JsonValue;
};

/** Failover-worthy provider failure; router may try the next provider. */
export class ProviderUnavailableError extends Error {
	constructor(
		message: string,
		readonly cooldownMs: number,
	) {
		super(message);
		this.name = 'ProviderUnavailableError';
	}
}

export type WebSearchProvider = {
	id: ProviderId;
	search: (input: SearchInput) => Promise<SearchResult>;
	fetch: (input: FetchInput) => Promise<FetchResult>;
};

export const DEFAULT_MAX_RESULTS = 5;

export const DEFAULT_MAX_FETCH_URLS = 5;

export const MAX_FETCH_CHARACTERS_PER_URL = 10_000;
