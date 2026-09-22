import { createExaProvider } from './exa.ts';
import { createParallelProvider } from './parallel.ts';
import {
	ProviderUnavailableError,
	type FetchInput,
	type ProviderId,
	type SearchInput,
	type WebSearchProvider,
} from './types.ts';

export type WebSearchEnv = {
	readonly [key: string]: string | undefined;
};

/** Process-local cooldown shared by Coworker conversations in this isolate. */
const sharedCooldown = new Map<ProviderId, number>();

/** Build adapters for whichever API keys are present. */
export function resolveWebSearchProviders(env: WebSearchEnv): WebSearchProvider[] {
	const providers: WebSearchProvider[] = [];
	const exaKey = env.EXA_API_KEY?.trim();
	const parallelKey = env.PARALLEL_API_KEY?.trim();

	if (exaKey) {
		providers.push(createExaProvider({ apiKey: exaKey }));
	}

	if (parallelKey) {
		providers.push(createParallelProvider({ apiKey: parallelKey }));
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
	cooldown?: Map<ProviderId, number>;
}) {
	const now = args.now ?? Date.now;
	const cooldown = args.cooldown ?? sharedCooldown;

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
			const unavailableUntil = cooldown.get(provider.id);

			if (unavailableUntil !== undefined && unavailableUntil > at) {
				failures.push(`${provider.id}: cooling until ${new Date(unavailableUntil).toISOString()}`);
				continue;
			}

			cooldown.delete(provider.id);

			try {
				return await call(provider);
			} catch (error) {
				if (error instanceof ProviderUnavailableError) {
					cooldown.set(provider.id, now() + error.cooldownMs);
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
		search: (input: SearchInput) => runStacked('search', (provider) => provider.search(input)),
		fetch: (input: FetchInput) => runStacked('fetch', (provider) => provider.fetch(input)),
	};
}
