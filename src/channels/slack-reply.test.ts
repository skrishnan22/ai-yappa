import * as slack from '@slack/web-api';
import * as v from 'valibot';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	__resetSlackClientForTests,
	getSlackClient,
	replyInThread,
	slackFetch,
} from './slack-reply.ts';
import { stubSlackApi } from './testing/slack-api-stub.ts';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
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
		const WebClient = slack.WebClient;

		const constructor = vi.spyOn(slack, 'WebClient').mockImplementation(function (...args) {
			return new WebClient(...args);
		});

		vi.resetModules();

		try {
			const fresh = await import('./slack-reply.ts');
			expect(constructor).not.toHaveBeenCalled();

			fresh.getSlackClient('xoxb-test');
			expect(constructor).toHaveBeenCalledOnce();
		} finally {
			constructor.mockRestore();
		}
	});

	test('replaces the cached client when the validated token changes', async () => {
		const calls = stubSlackApi();

		await getSlackClient('xoxb-first').chat.postMessage({ channel: 'C1', text: 'a' });
		await getSlackClient('xoxb-second').chat.postMessage({ channel: 'C1', text: 'b' });
		expect(calls.map((call) => call.token)).toEqual(['xoxb-first', 'xoxb-second']);
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
			output: { posted: false, text: 'local **reply**', blocks: null, channel: null, ts: null },
		});
	});

	test('requires complete operational identifiers in the reply tool contract', () => {
		const tool = replyInThread({ channelId: 'C-local', threadTs: '1.2' });

		expect(tool.description).toMatch(/full exact operational identifiers/i);
		expect(tool.description).toMatch(/trace IDs, request IDs, commit hashes/i);
		expect(tool.description).toMatch(/never abbreviate.*\.\.\.|…/i);
		expect(tool.description).not.toMatch(/standard Markdown accepted by Slack/i);
	});

	test.each([
		'Completed at **17:43:23.056Z**. Inline `**requestId**`.\n```text\n**traceId**\n```\n_italic_ and [link](https://example.com)',
		'[example]',
		'{name}',
		'true',
		'false',
	])('submits Markdown unchanged through markdown_text: %s', async (text) => {
		const calls = stubSlackApi();
		const tool = replyInThread({ channelId: 'C-test', threadTs: '2.3' }, 'xoxb-injected');

		await expect(
			tool.run({
				data: { text },
				toolCallId: 'post-formatted',
				log: { info() {}, warn() {}, error() {} },
			}),
		).resolves.toEqual({
			output: { posted: true, text, blocks: null, channel: null, ts: null },
		});
		expect(calls.map((call) => call.params)).toEqual([
			{
				channel: 'C-test',
				thread_ts: '2.3',
				markdown_text: text,
				unfurl_links: false,
				unfurl_media: false,
			},
		]);
		expect(calls[0]?.params).not.toHaveProperty('text');
		expect(calls.map((call) => call.token)).toEqual(['xoxb-injected']);
	});

	test.each([
		'p95 latency fell from 480 ms on Monday to 210 ms on Wednesday.',
		'[example]',
		'{name}',
		'true',
		'false',
	])('posts validated blocks with unchanged text fallback: %s', async (text) => {
		const calls = stubSlackApi();
		const tool = replyInThread({ channelId: 'C-test', threadTs: '2.3' }, 'xoxb-injected');

		const data = v.parse(tool.input, {
			text,
			blocks: [
				{ type: 'markdown', text: 'Latency after the cache change:' },
				{
					type: 'data_visualization',
					title: 'p95 latency (ms)',
					chart: {
						type: 'line',
						series: [
							{
								name: 'p95',
								data: [
									{ label: 'Mon', value: 480 },
									{ label: 'Tue', value: 320 },
									{ label: 'Wed', value: 210 },
								],
							},
						],
						axis_config: { categories: ['Mon', 'Tue', 'Wed'], y_label: 'ms' },
					},
				},
			],
		});

		await expect(
			tool.run({ data, toolCallId: 'post-blocks', log: { info() {}, warn() {}, error() {} } }),
		).resolves.toEqual({
			output: { posted: true, text: data.text, blocks: null, channel: null, ts: null },
		});
		expect(calls.map((call) => call.params)).toEqual([
			{
				channel: 'C-test',
				thread_ts: '2.3',
				text: data.text,
				blocks: data.blocks,
				unfurl_links: false,
				unfurl_media: false,
			},
		]);
		expect(calls[0]?.params).not.toHaveProperty('markdown_text');
	});

	test('returns validated blocks without posting when no Slack token was supplied', async () => {
		const tool = replyInThread({ channelId: 'C-local', threadTs: '1.2' });
		const blocks = [{ type: 'divider' as const }];

		await expect(
			tool.run({
				data: { text: 'fallback', blocks },
				toolCallId: 'local-blocks',
				log: { info() {}, warn() {}, error() {} },
			}),
		).resolves.toEqual({
			output: { posted: false, text: 'fallback', blocks, channel: null, ts: null },
		});
	});

	test('rejects unsupported blocks at the tool input boundary', () => {
		const tool = replyInThread({ channelId: 'C-local', threadTs: '1.2' });

		const result = v.safeParse(tool.input, {
			text: 'look',
			blocks: [{ type: 'image', image_url: 'https://attacker.example/pixel.png', alt_text: 'x' }],
		});

		expect(result.success).toBe(false);
	});
});
