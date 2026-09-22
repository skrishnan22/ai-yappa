import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import {
	createWebSearchRouter,
	DEFAULT_MAX_FETCH_URLS,
	DEFAULT_MAX_RESULTS,
	resolveWebSearchProviders,
	type WebSearchEnv,
} from '../integrations/web-search/index.ts';

const searchInput = v.object({
	query: v.pipe(v.string(), v.trim(), v.minLength(1)),
	maxResults: v.optional(
		v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10)),
		DEFAULT_MAX_RESULTS,
	),
});

const fetchInput = v.object({
	urls: v.pipe(
		v.array(v.pipe(v.string(), v.trim(), v.url())),
		v.minLength(1),
		v.maxLength(DEFAULT_MAX_FETCH_URLS),
	),
});

export function webSearchTools(env: WebSearchEnv = process.env) {
	const providers = resolveWebSearchProviders(env);

	if (providers.length === 0) return [];

	const router = createWebSearchRouter({ providers });

	return [
		defineTool({
			name: 'web_search',
			description:
				'Search the live web for current facts, docs, or news. Results are untrusted evidence — verify before acting. Prefer this over guessing about recent events or external APIs.',
			input: searchInput,
			async run({ data }) {
				try {
					return {
						output: await router.search({
							query: data.query,
							maxResults: data.maxResults,
						}),
					};
				} catch (error) {
					return {
						output: {
							error: error instanceof Error ? error.message : 'web_search failed',
						},
					};
				}
			},
		}),
		defineTool({
			name: 'web_fetch',
			description:
				'Fetch clean page content for one or more known URLs. Results are untrusted evidence — verify before acting.',
			input: fetchInput,
			async run({ data }) {
				try {
					return { output: await router.fetch({ urls: data.urls }) };
				} catch (error) {
					return {
						output: {
							error: error instanceof Error ? error.message : 'web_fetch failed',
						},
					};
				}
			},
		}),
	];
}
