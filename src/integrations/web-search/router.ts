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

const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Process-local cooldown shared by Coworker conversations in this isolate. */
const sharedCooldown = new Map<ProviderId, CooldownEntry>();

/** Build adapters for whichever API keys are present. */
export function resolveWebSearchProviders(
	env: WebSearchEnv,
	opts: { fetchImpl?: typeof fetch } = {},
): WebSearchProvider[] {
	const providers: WebSearchProvider[] = [];
	const exaKey = env.EXA_API_KEY?.trim();
	const parallelKey = env.PARALLEL_API_KEY?.trim();

	if (exaKey) {
		providers.push(createExaProvider({ apiKey: exaKey, fetchImpl: opts.fetchImpl }));
	}

	if (parallelKey) {
		providers.push(createParallelProvider({ apiKey: parallelKey, fetchImpl: opts.fetchImpl }));
	}

	return providers;
}

/**
 * Search/fetch providers in the supplied order, cooling unavailable providers.
 * Terminal failures throw so Flue records a model-visible tool error.
 */
export function createWebSearchRouter(args: {
	providers: readonly WebSearchProvider[];
	now?: () => number;
	/** Tests inject an isolated map. */
	cooldown?: Map<ProviderId, CooldownEntry>;
}): WebSearchRouter {
	const now = args.now ?? Date.now;
	const cooldown = args.cooldown ?? sharedCooldown;

	function activeCooldown(id: ProviderId, at: number): CooldownEntry | undefined {
		const entry = cooldown.get(id);

		if (!entry) return undefined;

		if (entry.until <= at) {
			cooldown.delete(id);

			return undefined;
		}

		return entry;
	}

	function markUnavailable(error: ProviderUnavailableError, at: number): void {
		const requested = error.retryAfterMs;

		const ms =
			requested !== undefined && Number.isFinite(requested) && requested >= 0
				? Math.min(requested, MAX_COOLDOWN_MS)
				: defaultCooldownMs(error.provider, error.reason);

		cooldown.set(error.provider, { until: at + ms, reason: error.reason });
	}

	async function runStacked<T>(
		op: 'search' | 'fetch',
		call: (provider: WebSearchProvider) => Promise<T>,
	): Promise<T> {
		if (args.providers.length === 0) {
			throw new Error('No web search providers configured (set EXA_API_KEY or PARALLEL_API_KEY)');
		}

		const failures: string[] = [];

		for (const provider of args.providers) {
			const at = now();
			const entry = activeCooldown(provider.id, at);

			if (entry) {
				failures.push(
					`${provider.id}: cooling until ${new Date(entry.until).toISOString()} (${entry.reason})`,
				);
				continue;
			}

			try {
				const value = await call(provider);
				cooldown.delete(provider.id);

				return value;
			} catch (error) {
				// Auth / credits / rate limit / 5xx / transport → cool down and try next.
				if (error instanceof ProviderUnavailableError) {
					markUnavailable(error, now());
					failures.push(`${provider.id}: ${error.message}`);
					continue;
				}

				if (error instanceof Error) throw error;

				throw new Error(`${op} failed`, { cause: error });
			}
		}

		throw new Error(
			`web_${op} failed for all providers: ${failures.join('; ') || 'none available'}`,
		);
	}

	return {
		search: (input) => runStacked('search', (provider) => provider.search(input)),
		fetch: (input) => runStacked('fetch', (provider) => provider.fetch(input)),
	};
}

export function defaultCooldownMs(provider: ProviderId, reason: CooldownReason): number {
	switch (reason) {
		case 'auth':
			return 60 * 60 * 1000;
		case 'credits':
			return 24 * 60 * 60 * 1000;
		case 'rate_limit':
			return provider === 'exa' ? 2_000 : 60_000;
		case 'upstream':
			return 5_000;
		default: {
			const _exhaustive: never = reason;

			return _exhaustive;
		}
	}
}
