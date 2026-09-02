import { afterEach, describe, expect, test, vi } from 'vitest';

const { constructed } = vi.hoisted(() => ({
	constructed: [] as Array<{ fetch?: (url: string | URL, init?: RequestInit) => Promise<Response> } | undefined>,
}));

vi.mock('@slack/web-api', () => ({
	WebClient: class WebClient {
		constructor(_token?: string, opts?: { fetch?: (url: string | URL, init?: RequestInit) => Promise<Response> }) {
			constructed.push(opts);
		}

		chat = {
			async postMessage() {
				return { ok: true };
			},
		};
	},
}));

afterEach(() => {
	constructed.length = 0;
	vi.resetModules();
});

describe('slack WebClient fetch', () => {
	test('constructs WebClient with a fetch that can be called unbound', async () => {
		await import('./slack-reply.ts');

		const fetchFn = constructed[0]?.fetch;
		expect(fetchFn).toEqual(expect.any(Function));

		const original = globalThis.fetch;
		const seen: unknown[] = [];
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			seen.push({ input, init });
			return new Response('{}', { status: 200 });
		}) as typeof fetch;
		try {
			await fetchFn!('https://slack.com/api/chat.postMessage', { method: 'POST' });
			expect(seen).toEqual([
				{ input: 'https://slack.com/api/chat.postMessage', init: { method: 'POST' } },
			]);
		} finally {
			globalThis.fetch = original;
		}
	});

	test('maps redirect error to manual before calling fetch', async () => {
		await import('./slack-reply.ts');

		const fetchFn = constructed[0]?.fetch;
		expect(fetchFn).toEqual(expect.any(Function));

		const original = globalThis.fetch;
		const seen: unknown[] = [];
		globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			seen.push(init);
			return new Response('{}', { status: 200 });
		}) as typeof fetch;
		try {
			await fetchFn!('https://slack.com/api/chat.postMessage', { redirect: 'error' });
			expect(seen).toEqual([{ redirect: 'manual' }]);
		} finally {
			globalThis.fetch = original;
		}
	});
});
