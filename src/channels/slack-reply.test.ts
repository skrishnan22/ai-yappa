import { afterEach, describe, expect, test, vi } from 'vitest';

const { constructed, posted } = vi.hoisted(() => ({
	constructed: [] as Array<
		| {
				token?: string;
				fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
		  }
		| undefined
	>,
	posted: [] as Array<Record<string, string>>,
}));

vi.mock('@slack/web-api', () => ({
	WebClient: class WebClient {
		constructor(
			token?: string,
			opts?: { fetch?: (url: string | URL, init?: RequestInit) => Promise<Response> },
		) {
			constructed.push({ token, ...opts });
		}

		chat = {
			async postMessage(args: Record<string, string>) {
				posted.push(args);
				return { ok: true };
			},
		};
	},
}));

afterEach(() => {
	constructed.length = 0;
	posted.length = 0;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.resetModules();
});

async function fetchFnFromLazyClient() {
	vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test');
	const { getSlackClient, __resetSlackClientForTests } = await import('./slack-reply.ts');
	__resetSlackClientForTests();
	getSlackClient('xoxb-test');
	return constructed[0]?.fetch;
}

describe('slack WebClient fetch', () => {
	test('constructs WebClient with a fetch that can be called unbound', async () => {
		const fetchFn = await fetchFnFromLazyClient();
		expect(fetchFn).toEqual(expect.any(Function));

		const original = globalThis.fetch;
		const seen: unknown[] = [];
		globalThis.fetch = (async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
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
		const fetchFn = await fetchFnFromLazyClient();
		expect(fetchFn).toEqual(expect.any(Function));

		const original = globalThis.fetch;
		const seen: unknown[] = [];
		globalThis.fetch = (async (
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
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

	test('importing the module does not construct a client without a token', async () => {
		vi.stubEnv('SLACK_BOT_TOKEN', '');
		await import('./slack-reply.ts');
		expect(constructed).toEqual([]);
	});

	test('replaces the cached client when the validated token changes', async () => {
		const { getSlackClient, __resetSlackClientForTests } = await import('./slack-reply.ts');
		__resetSlackClientForTests();
		getSlackClient('xoxb-first');
		getSlackClient('xoxb-second');
		expect(constructed.map((entry) => entry?.token)).toEqual(['xoxb-first', 'xoxb-second']);
	});

	test('uses the local fallback when no Slack token was supplied', async () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const { replyInThread } = await import('./slack-reply.ts');
		const ref = {
			channelId: 'C-local',
			threadTs: '1.2',
			conversationId: 'conversation-local',
		};
		const tool = replyInThread(ref);
		await expect(
			tool.run({
				data: { text: 'local reply' },
				toolCallId: 'local',
				log: { info() {}, warn() {}, error() {} },
			}),
		).resolves.toEqual({
			output: { posted: false, text: 'local reply', channel: null, ts: null },
		});
		expect(info.mock.calls).toEqual([
			[
				expect.objectContaining({
					event_name: 'slack.delivery',
					outcome: 'skipped',
					conversation_id: 'conversation-local',
					tool_call_id: 'local',
					delivery_kind: 'agent_reply',
					posted: false,
				}),
			],
		]);
		expect(JSON.stringify(info.mock.calls)).not.toContain('local reply');
	});

	test('posts with the injected token and thread reference', async () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const { replyInThread } = await import('./slack-reply.ts');
		const ref = { channelId: 'C-test', threadTs: '2.3', conversationId: 'conversation-post' };
		const tool = replyInThread(ref, 'xoxb-injected');
		await expect(
			tool.run({
				data: { text: 'hello Slack' },
				toolCallId: 'post',
				log: { info() {}, warn() {}, error() {} },
			}),
		).resolves.toEqual({
			output: { posted: true, text: 'hello Slack', channel: null, ts: null },
		});
		expect(posted).toEqual([{ channel: 'C-test', thread_ts: '2.3', text: 'hello Slack' }]);
		expect(info.mock.calls).toEqual([
			[
				expect.objectContaining({
					event_name: 'slack.delivery',
					outcome: 'ok',
					conversation_id: 'conversation-post',
					tool_call_id: 'post',
					posted: true,
				}),
			],
		]);
		expect(JSON.stringify(info.mock.calls)).not.toContain('hello Slack');
	});

	test('emits a failed delivery without the Slack error message', async () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const { observeSlackDelivery } = await import('./slack-reply.ts');

		await expect(
			observeSlackDelivery(
				{
					conversationId: 'conversation-failed',
					deliveryKind: 'agent_reply',
					method: 'chat.postMessage',
					toolCallId: 'tool-failed',
				},
				async () => {
					throw new Error('Slack response contained private message text');
				},
			),
		).rejects.toThrow('Slack response contained private message text');

		const serialized = JSON.stringify(info.mock.calls);
		expect(serialized).toContain('slack.delivery');
		expect(serialized).toContain('failed');
		expect(serialized).toContain('conversation-failed');
		expect(serialized).not.toContain('private message text');
	});
});
