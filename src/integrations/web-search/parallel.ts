import * as v from 'valibot';
import { jsonValueSchema, type JsonObject, type JsonValue } from '../../json.ts';
import { postJson, truncate } from './http.ts';
import {
	MAX_CONTENT_CHARS,
	type FetchInput,
	type FetchPage,
	type FetchResult,
	type SearchHit,
	type SearchInput,
	type SearchResult,
	type WebSearchProvider,
} from './types.ts';

const SEARCH_URL = 'https://api.parallel.ai/v1/search';

const EXTRACT_URL = 'https://api.parallel.ai/v1/extract';

const hitSchema = v.object({
	url: v.string(),
	title: v.optional(v.nullable(v.string())),
	excerpts: v.optional(v.array(v.string())),
	full_content: v.optional(v.nullable(v.string())),
});

const resultsSchema = v.object({
	results: v.optional(v.array(jsonValueSchema)),
});

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
				max_chars_total: input.maxResults * MAX_CONTENT_CHARS,
				advanced_settings: {
					max_results: input.maxResults,
				},
			};

			const payload = await postJson({
				provider: 'parallel',
				url: SEARCH_URL,
				apiKey,
				fetchImpl,
				body,
			});

			return {
				provider: 'parallel',
				results: readHits(payload).slice(0, input.maxResults),
			};
		},
		async fetch(input: FetchInput): Promise<FetchResult> {
			const body: JsonObject = {
				urls: input.urls,
				max_chars_total: input.urls.length * MAX_CONTENT_CHARS,
				advanced_settings: {
					full_content: true,
				},
			};

			const payload = await postJson({
				provider: 'parallel',
				url: EXTRACT_URL,
				apiKey,
				fetchImpl,
				body,
			});

			return {
				provider: 'parallel',
				pages: readPages(payload),
			};
		},
	};
}

function readHits(payload: JsonValue): SearchHit[] {
	const parsed = v.safeParse(resultsSchema, payload);

	if (!parsed.success || !parsed.output.results) return [];

	const hits: SearchHit[] = [];

	for (const row of parsed.output.results) {
		const hit = normalizeHit(row);

		if (hit) hits.push(hit);
	}

	return hits;
}

function readPages(payload: JsonValue): FetchPage[] {
	const parsed = v.safeParse(resultsSchema, payload);

	if (!parsed.success || !parsed.output.results) return [];

	const pages: FetchPage[] = [];

	for (const row of parsed.output.results) {
		const page = normalizePage(row);

		if (page) pages.push(page);
	}

	return pages;
}

function normalizeHit(row: JsonValue): SearchHit | undefined {
	const parsed = v.safeParse(hitSchema, row);

	if (!parsed.success) return undefined;

	const url = parsed.output.url.trim();

	if (!url) return undefined;

	const title = nonempty(parsed.output.title) ?? url;
	const excerpts = parsed.output.excerpts ?? [];

	return {
		url,
		title,
		content: truncate(excerpts.join('\n\n'), MAX_CONTENT_CHARS),
	};
}

function normalizePage(row: JsonValue): FetchPage | undefined {
	const parsed = v.safeParse(hitSchema, row);

	if (!parsed.success) return undefined;

	const url = parsed.output.url.trim();

	if (!url) return undefined;

	const excerpts = parsed.output.excerpts ?? [];

	const page: FetchPage = {
		url,
		content: truncate(
			nonempty(parsed.output.full_content) ?? excerpts.join('\n\n'),
			MAX_CONTENT_CHARS,
		),
	};

	const title = nonempty(parsed.output.title);

	if (title) page.title = title;

	return page;
}

function nonempty(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();

	return trimmed ? trimmed : undefined;
}
