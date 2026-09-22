import { parseRetryAfterMs } from './client.ts';
import { createExaProvider } from './exa.ts';
import { createParallelProvider } from './parallel.ts';
import {
	ProviderUnavailableError,
	type CooldownReason,
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

type CooldownEntry = {
	until: number;
	reason: CooldownReason;
};

const PROVIDER_ORDER: readonly ProviderId[] = ['exa', 'parallel'];

const DEFAULT_BACKOFF_MS: Record<CooldownReason, number> = {
	rate_limit: 60_000,
	credits: 24 * 60 * 60 * 1000,
	upstream: 30_000,
};

const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

/** In-memory cooldown until deployment-wide KV. Shared across calls in this isolate. */
const cooldownUntil = new Map<ProviderId, CooldownEntry>();

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
	now?: () => number;
	/** Test hook: replace the process-local cooldown map. */
	cooldown?: Map<ProviderId, CooldownEntry>;
}): WebSearchRouter {
	const now = args.now ?? Date.now;
	const cooldown = args.cooldown ?? cooldownUntil;
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
			const entry = cooldown.get(provider.id);

			if (entry && entry.until > at) {
				failures.push(
					`${provider.id}: cooling until ${new Date(entry.until).toISOString()} (${entry.reason})`,
				);
				continue;
			}

			if (entry) cooldown.delete(provider.id);

			try {
				const result = await call(provider);
				cooldown.delete(provider.id);

				return result;
			} catch (error) {
				if (error instanceof ProviderUnavailableError) {
					const retryAfterMs = error.retryAfterMs;

					const backoff =
						retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
							? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS)
							: DEFAULT_BACKOFF_MS[error.reason];

					cooldown.set(error.provider, { until: now() + backoff, reason: error.reason });
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

export { parseRetryAfterMs };
