import type { JsonObject } from '../../json.ts';
import { postProviderJson } from './client.ts';
import {
	MAX_FETCH_CHARACTERS_PER_URL,
	type FetchInput,
	type FetchResult,
	type SearchInput,
	type SearchResult,
	type WebSearchProvider,
} from './types.ts';

const SEARCH_URL = 'https://api.parallel.ai/v1/search';

const EXTRACT_URL = 'https://api.parallel.ai/v1/extract';

export function createParallelProvider(args: {
	apiKey: string;
	fetchImpl?: typeof fetch;
}): WebSearchProvider {
	const { apiKey, fetchImpl } = args;

	return {
		id: 'parallel',
		async search(input: SearchInput): Promise<SearchResult> {
			const body: JsonObject = {
				objective: input.query,
				search_queries: [input.query],
				mode: 'basic',
				advanced_settings: { max_results: input.maxResults },
			};

			return {
				provider: 'parallel',
				searchResults: await postProviderJson({
					provider: 'parallel',
					url: SEARCH_URL,
					apiKey,
					fetchImpl,
					body,
				}),
			};
		},
		async fetch(input: FetchInput): Promise<FetchResult> {
			const body: JsonObject = {
				urls: input.urls,
				advanced_settings: {
					full_content: { max_chars_per_result: MAX_FETCH_CHARACTERS_PER_URL },
				},
			};

			return {
				provider: 'parallel',
				fetchResults: await postProviderJson({
					provider: 'parallel',
					url: EXTRACT_URL,
					apiKey,
					fetchImpl,
					body,
				}),
			};
		},
	};
}
