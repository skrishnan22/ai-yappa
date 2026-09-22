import type { CooldownReason, ProviderId } from './types.ts';

export type CooldownEntry = {
	until: number;
	reason: CooldownReason;
};

const DEFAULT_RATE_LIMIT_MS = 60_000;

const DEFAULT_CREDITS_MS = 24 * 60 * 60 * 1000;

const DEFAULT_UPSTREAM_MS = 30_000;

const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

/** In-memory provider cooldown. Not shared across isolates; KV later. */
export class ProviderCooldown {
	readonly #entries = new Map<ProviderId, CooldownEntry>();

	isCooling(provider: ProviderId, now = Date.now()): boolean {
		const entry = this.#entries.get(provider);

		if (!entry) return false;

		if (entry.until <= now) {
			this.#entries.delete(provider);

			return false;
		}

		return true;
	}

	get(provider: ProviderId, now = Date.now()): CooldownEntry | undefined {
		if (!this.isCooling(provider, now)) return undefined;

		return this.#entries.get(provider);
	}

	mark(
		provider: ProviderId,
		reason: CooldownReason,
		opts: { now?: number; retryAfterMs?: number } = {},
	): CooldownEntry {
		const now = opts.now ?? Date.now();
		const until = now + resolveBackoffMs(reason, opts.retryAfterMs);
		const entry = { until, reason };
		this.#entries.set(provider, entry);

		return entry;
	}

	clear(provider: ProviderId): void {
		this.#entries.delete(provider);
	}

	clearAll(): void {
		this.#entries.clear();
	}
}

export function resolveBackoffMs(reason: CooldownReason, retryAfterMs?: number): number {
	if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
		return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
	}

	switch (reason) {
		case 'rate_limit':
			return DEFAULT_RATE_LIMIT_MS;
		case 'credits':
			return DEFAULT_CREDITS_MS;
		case 'upstream':
			return DEFAULT_UPSTREAM_MS;
		default: {
			const _exhaustive: never = reason;

			return _exhaustive;
		}
	}
}

export function parseRetryAfterMs(header: string | null, now = Date.now()): number | undefined {
	if (!header) return undefined;

	const seconds = Number(header);

	if (Number.isFinite(seconds) && seconds >= 0) {
		return seconds * 1000;
	}

	const dateMs = Date.parse(header);

	if (Number.isFinite(dateMs)) {
		return Math.max(0, dateMs - now);
	}

	return undefined;
}

/** Process-local cooldown used until deployment-wide KV lands. */
export const sharedProviderCooldown = new ProviderCooldown();
