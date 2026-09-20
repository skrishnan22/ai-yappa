import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	__resetSlackClientForTests,
	__setSlackClientFactoryForTests,
	getSlackClient,
	replyInThread,
	slackFetch,
	type SlackBotClient,
} from './slack-reply.ts';

const constructed: string[] = [];

const posted: Array<Parameters<SlackBotClient['chat']['postMessage']>[0]> = [];

function fakeClient(token: string): SlackBotClient {
	constructed.push(token);

	return {
		chat: {
			async postMessage(args) {
				posted.push(args);

				return { ok: true };
			},
			async update() {
				return { ok: true };
			},
		},
		conversations: {
			async replies() {
				return { ok: true, messages: [] };
			},
		},
	};
}

afterEach(() => {
	constructed.length = 0;
	posted.length = 0;
	vi.unstubAllEnvs();
	__setSlackClientFactoryForTests();
	__resetSlackClientForTests();
});

describe('slackFetch', () => {
	test('can be called unbound', async () => {
		const original = globalThis.fetch;
		const seen: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
		globalThis.fetch = async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			seen.push({ input, init });

			return new Response('{}', { status: 200 });
		};

		try {
			await slackFetch('https://slack.com/api/chat.postMessage', { method: 'POST' });
			expect(seen).toEqual([
				{ input: 'https://slack.com/api/chat.postMessage', init: { method: 'POST' } },
			]);
		} finally {
			globalThis.fetch = original;
		}
	});

	test('maps redirect error to manual before calling fetch', async () => {
		const original = globalThis.fetch;
		const seen: Array<RequestInit | undefined> = [];
		globalThis.fetch = async (
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			seen.push(init);

			return new Response('{}', { status: 200 });
		};

		try {
			await slackFetch('https://slack.com/api/chat.postMessage', { redirect: 'error' });
			expect(seen).toEqual([{ redirect: 'manual' }]);
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe('slack WebClient factory', () => {
	test('importing the module does not construct a client without a token', async () => {
		vi.stubEnv('SLACK_BOT_TOKEN', '');
		__setSlackClientFactoryForTests(fakeClient);
		await import('./slack-reply.ts');
		expect(constructed).toEqual([]);
	});

	test('replaces the cached client when the validated token changes', () => {
		__setSlackClientFactoryForTests(fakeClient);
		getSlackClient('xoxb-first');
		getSlackClient('xoxb-second');
		expect(constructed).toEqual(['xoxb-first', 'xoxb-second']);
	});

	test('uses the local fallback when no Slack token was supplied', async () => {
		const tool = replyInThread({ channelId: 'C-local', threadTs: '1.2' });
		await expect(
			tool.run({
				data: { text: 'local **reply**' },
				toolCallId: 'local',
				log: { info() {}, warn() {}, error() {} },
			}),
		).resolves.toEqual({
			output: { posted: false, text: 'local **reply**', channel: null, ts: null },
		});
	});

	test('requires complete operational identifiers in the reply tool contract', () => {
		const tool = replyInThread({ channelId: 'C-local', threadTs: '1.2' });

		expect(tool.description).toMatch(/full exact operational identifiers/i);
		expect(tool.description).toMatch(/trace IDs, request IDs, commit hashes/i);
		expect(tool.description).toMatch(/never abbreviate.*\.\.\.|…/i);
		expect(tool.description).not.toMatch(/standard Markdown accepted by Slack/i);
	});

	test('submits standard Markdown unchanged through markdown_text', async () => {
		__setSlackClientFactoryForTests(fakeClient);
		const tool = replyInThread({ channelId: 'C-test', threadTs: '2.3' }, 'xoxb-injected');

		const text =
			'Completed at **17:43:23.056Z**. Inline `**requestId**`.\n```text\n**traceId**\n```\n_italic_ and [link](https://example.com)';

		await expect(
			tool.run({
				data: { text },
				toolCallId: 'post-formatted',
				log: { info() {}, warn() {}, error() {} },
			}),
		).resolves.toEqual({
			output: { posted: true, text, channel: null, ts: null },
		});
		expect(posted).toEqual([
			{
				channel: 'C-test',
				thread_ts: '2.3',
				markdown_text: text,
			},
		]);
		expect(posted[0]).not.toHaveProperty('text');
	});

	test('posts with the injected token and thread reference', async () => {
		__setSlackClientFactoryForTests(fakeClient);
		const tool = replyInThread({ channelId: 'C-test', threadTs: '2.3' }, 'xoxb-injected');
		await expect(
			tool.run({
				data: { text: 'hello Slack' },
				toolCallId: 'post',
				log: { info() {}, warn() {}, error() {} },
			}),
		).resolves.toEqual({
			output: { posted: true, text: 'hello Slack', channel: null, ts: null },
		});
		expect(posted).toEqual([{ channel: 'C-test', thread_ts: '2.3', markdown_text: 'hello Slack' }]);
	});
});
