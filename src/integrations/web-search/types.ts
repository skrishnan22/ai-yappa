export type ProviderId = 'exa' | 'parallel';

export type SearchHit = {
	url: string;
	title: string;
	content: string;
};

export type FetchPage = {
	url: string;
	title?: string;
	content: string;
};

export type SearchResult = {
	provider: ProviderId;
	results: SearchHit[];
};

export type FetchResult = {
	provider: ProviderId;
	pages: FetchPage[];
};

export type SearchInput = {
	query: string;
	maxResults: number;
};

export type FetchInput = {
	urls: string[];
};

export type CooldownReason = 'rate_limit' | 'credits' | 'upstream';

/** Failover-worthy provider failure; router may try the next provider. */
export class ProviderUnavailableError extends Error {
	readonly provider: ProviderId;
	readonly reason: CooldownReason;
	readonly retryAfterMs: number | undefined;
	readonly status: number | undefined;

	constructor(args: {
		provider: ProviderId;
		reason: CooldownReason;
		message: string;
		retryAfterMs?: number;
		status?: number;
	}) {
		super(args.message);
		this.name = 'ProviderUnavailableError';
		this.provider = args.provider;
		this.reason = args.reason;
		this.retryAfterMs = args.retryAfterMs;
		this.status = args.status;
	}
}

export type WebSearchProvider = {
	id: ProviderId;
	search: (input: SearchInput) => Promise<SearchResult>;
	fetch: (input: FetchInput) => Promise<FetchResult>;
};

export const DEFAULT_MAX_RESULTS = 5;

export const DEFAULT_MAX_FETCH_URLS = 5;

/** Cap each result/page body returned to the model. */
export const MAX_CONTENT_CHARS = 4_000;
