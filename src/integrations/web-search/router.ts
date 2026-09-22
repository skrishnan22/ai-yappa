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

/** Success or a message the tool can return to the model (no throw). */
export type RouterOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

export type WebSearchRouter = {
	search: (input: SearchInput) => Promise<RouterOutcome<SearchResult>>;
	fetch: (input: FetchInput) => Promise<RouterOutcome<FetchResult>>;
};

type CooldownEntry = {
	until: number;
	reason: CooldownReason;
};

/** Prefer Exa, then Parallel. Only configured providers are tried. */
const PROVIDER_ORDER: readonly ProviderId[] = ['exa', 'parallel'];

const MAX_COOLDOWN_MS = 60 * 60 * 1000;

const FALLBACK_COOLDOWN_MS = 30_000;

/** Process-local: skip a provider until `until` (KV later). */
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
 * Exa-first search/fetch with failover.
 * Operational failures become `{ ok: false, error }` so the tool can return them
 * to the model without throwing out of `defineTool`.
 */
export function createWebSearchRouter(args: {
	providers: readonly WebSearchProvider[];
	now?: () => number;
	/** Tests inject an isolated map. */
	cooldown?: Map<ProviderId, CooldownEntry>;
}): WebSearchRouter {
	const now = args.now ?? Date.now;
	const cooldown = args.cooldown ?? sharedCooldown;
	const byId = new Map(args.providers.map((p) => [p.id, p] as const));

	function providersToTry(): WebSearchProvider[] {
		const list: WebSearchProvider[] = [];

		for (const id of PROVIDER_ORDER) {
			const provider = byId.get(id);

			if (provider) list.push(provider);
		}

		return list;
	}

	function isCooling(id: ProviderId, at: number): boolean {
		const entry = cooldown.get(id);

		if (!entry) return false;

		if (entry.until <= at) {
			cooldown.delete(id);

			return false;
		}

		return true;
	}

	function markUnavailable(error: ProviderUnavailableError, at: number): void {
		const requested = error.retryAfterMs;

		const ms =
			requested !== undefined && Number.isFinite(requested) && requested > 0
				? Math.min(requested, MAX_COOLDOWN_MS)
				: FALLBACK_COOLDOWN_MS;

		cooldown.set(error.provider, { until: at + ms, reason: error.reason });
	}

	async function runStacked<T>(
		op: 'search' | 'fetch',
		call: (provider: WebSearchProvider) => Promise<T>,
	): Promise<RouterOutcome<T>> {
		const stack = providersToTry();

		if (stack.length === 0) {
			return {
				ok: false,
				error: 'No web search providers configured (set EXA_API_KEY or PARALLEL_API_KEY)',
			};
		}

		const failures: string[] = [];

		for (const provider of stack) {
			const at = now();

			if (isCooling(provider.id, at)) {
				const entry = cooldown.get(provider.id);
				failures.push(
					`${provider.id}: cooling until ${entry ? new Date(entry.until).toISOString() : '?'} (${entry?.reason ?? '?'})`,
				);
				continue;
			}

			try {
				const value = await call(provider);
				cooldown.delete(provider.id);

				return { ok: true, value };
			} catch (error) {
				// Auth / credits / rate limit / 5xx / transport → cool down and try next.
				if (error instanceof ProviderUnavailableError) {
					markUnavailable(error, now());
					failures.push(`${provider.id}: ${error.message}`);
					continue;
				}

				// Validation / forbidden / unexpected → stop; surface to the model.
				return {
					ok: false,
					error: error instanceof Error ? error.message : `${op} failed`,
				};
			}
		}

		return {
			ok: false,
			error: `web_${op} failed for all providers: ${failures.join('; ') || 'none available'}`,
		};
	}

	return {
		search: (input) => runStacked('search', (provider) => provider.search(input)),
		fetch: (input) => runStacked('fetch', (provider) => provider.fetch(input)),
	};
}
