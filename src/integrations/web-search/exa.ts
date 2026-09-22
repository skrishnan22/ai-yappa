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

const SEARCH_URL = 'https://api.exa.ai/search';

const CONTENTS_URL = 'https://api.exa.ai/contents';

export function createExaProvider(args: {
	apiKey: string;
	fetchImpl?: typeof fetch;
}): WebSearchProvider {
	const { apiKey, fetchImpl } = args;

	return {
		id: 'exa',
		async search(input: SearchInput): Promise<SearchResult> {
			const body: JsonObject = {
				query: input.query,
				numResults: input.maxResults,
				type: 'auto',
				contents: { highlights: true },
			};

			return {
				provider: 'exa',
				searchResults: await postProviderJson({
					provider: 'exa',
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
				text: { maxCharacters: MAX_FETCH_CHARACTERS_PER_URL },
			};

			return {
				provider: 'exa',
				fetchResults: await postProviderJson({
					provider: 'exa',
					url: CONTENTS_URL,
					apiKey,
					fetchImpl,
					body,
				}),
			};
		},
	};
}
