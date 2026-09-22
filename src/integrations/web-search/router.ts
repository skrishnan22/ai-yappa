import type { ProviderCooldown } from './cooldown.ts';
import { sharedProviderCooldown } from './cooldown.ts';
import { createExaProvider } from './exa.ts';
import { createParallelProvider } from './parallel.ts';
import {
	ProviderUnavailableError,
	type FetchInput,
	type FetchResult,
	type ProviderId,
	type SearchInput,
	type SearchResult,
	type WebSearchProvider,
} from './types.ts';

export type WebSearchEnv = {
	readonly [key: string]: string | undefined;
};

export type WebSearchRouter = {
	search: (input: SearchInput) => Promise<SearchResult>;
	fetch: (input: FetchInput) => Promise<FetchResult>;
};

const PROVIDER_ORDER: readonly ProviderId[] = ['exa', 'parallel'];

export function resolveWebSearchProviders(
	env: WebSearchEnv,
	opts: { fetchImpl?: typeof fetch } = {},
): WebSearchProvider[] {
	const providers: WebSearchProvider[] = [];
	const exaKey = env.EXA_API_KEY?.trim();
	const parallelKey = env.PARALLEL_API_KEY?.trim();

	if (exaKey) providers.push(createExaProvider({ apiKey: exaKey, fetchImpl: opts.fetchImpl }));

	if (parallelKey) {
		providers.push(createParallelProvider({ apiKey: parallelKey, fetchImpl: opts.fetchImpl }));
	}

	return providers;
}

export function createWebSearchRouter(args: {
	providers: readonly WebSearchProvider[];
	cooldown?: ProviderCooldown;
	now?: () => number;
}): WebSearchRouter {
	const cooldown = args.cooldown ?? sharedProviderCooldown;
	const now = args.now ?? Date.now;
	const byId = new Map(args.providers.map((provider) => [provider.id, provider]));

	async function runWithFailover<T>(
		op: 'search' | 'fetch',
		call: (provider: WebSearchProvider) => Promise<T>,
	): Promise<T> {
		const candidates = PROVIDER_ORDER.flatMap((id) => {
			const provider = byId.get(id);

			return provider ? [provider] : [];
		});

		if (candidates.length === 0) {
			throw new Error('No web search providers configured (set EXA_API_KEY or PARALLEL_API_KEY)');
		}

		const failures: string[] = [];

		for (const provider of candidates) {
			const at = now();

			if (cooldown.isCooling(provider.id, at)) {
				const entry = cooldown.get(provider.id, at);
				failures.push(
					`${provider.id}: cooling until ${entry ? new Date(entry.until).toISOString() : 'unknown'} (${entry?.reason ?? 'unknown'})`,
				);
				continue;
			}

			try {
				const result = await call(provider);
				cooldown.clear(provider.id);

				return result;
			} catch (error) {
				if (error instanceof ProviderUnavailableError) {
					cooldown.mark(error.provider, error.reason, {
						now: now(),
						retryAfterMs: error.retryAfterMs,
					});
					failures.push(`${provider.id}: ${error.message}`);
					continue;
				}

				throw error;
			}
		}

		throw new Error(
			`web_${op} failed for all providers: ${failures.join('; ') || 'none available'}`,
		);
	}

	return {
		search: (input) => runWithFailover('search', (provider) => provider.search(input)),
		fetch: (input) => runWithFailover('fetch', (provider) => provider.fetch(input)),
	};
}
