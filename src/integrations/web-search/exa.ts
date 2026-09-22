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

const SEARCH_URL = 'https://api.exa.ai/search';

const CONTENTS_URL = 'https://api.exa.ai/contents';

const hitSchema = v.object({
	url: v.optional(v.string()),
	id: v.optional(v.string()),
	title: v.optional(v.string()),
	text: v.optional(v.string()),
	summary: v.optional(v.string()),
	highlights: v.optional(v.array(v.string())),
});

const resultsSchema = v.object({
	results: v.optional(v.array(jsonValueSchema)),
});

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
				contents: {
					text: { maxCharacters: MAX_CONTENT_CHARS },
					highlights: true,
				},
			};

			const payload = await postJson({
				provider: 'exa',
				url: SEARCH_URL,
				apiKey,
				fetchImpl,
				body,
			});

			return {
				provider: 'exa',
				results: readHits(payload).slice(0, input.maxResults),
			};
		},
		async fetch(input: FetchInput): Promise<FetchResult> {
			const body: JsonObject = {
				urls: input.urls,
				text: { maxCharacters: MAX_CONTENT_CHARS },
			};

			const payload = await postJson({
				provider: 'exa',
				url: CONTENTS_URL,
				apiKey,
				fetchImpl,
				body,
			});

			return {
				provider: 'exa',
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

	const url = nonempty(parsed.output.url) ?? nonempty(parsed.output.id);

	if (!url) return undefined;

	const title = nonempty(parsed.output.title) ?? url;
	const highlights = parsed.output.highlights ?? [];
	let content = nonempty(parsed.output.text) ?? nonempty(parsed.output.summary) ?? '';

	if (!content && highlights.length > 0) content = highlights.join('\n');

	return { url, title, content: truncate(content, MAX_CONTENT_CHARS) };
}

function normalizePage(row: JsonValue): FetchPage | undefined {
	const parsed = v.safeParse(hitSchema, row);

	if (!parsed.success) return undefined;

	const url = nonempty(parsed.output.url) ?? nonempty(parsed.output.id);

	if (!url) return undefined;

	const page: FetchPage = {
		url,
		content: truncate(
			nonempty(parsed.output.text) ?? nonempty(parsed.output.summary) ?? '',
			MAX_CONTENT_CHARS,
		),
	};

	const title = nonempty(parsed.output.title);

	if (title) page.title = title;

	return page;
}

function nonempty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();

	return trimmed ? trimmed : undefined;
}
