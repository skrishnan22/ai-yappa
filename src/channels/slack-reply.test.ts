import * as v from 'valibot';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	constructed.length = 0;
	posted.length = 0;
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
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
			output: { posted: true, text, blocks: null, channel: null, ts: null },
		});
		expect(posted).toEqual([
			{
				channel: 'C-test',
				thread_ts: '2.3',
				markdown_text: text,
				unfurl_links: false,
				unfurl_media: false,
			},
		]);
		expect(posted[0]).not.toHaveProperty('text');
	});

	test('posts validated blocks with a top-level text fallback instead of markdown_text', async () => {
		__setSlackClientFactoryForTests(fakeClient);
		const tool = replyInThread({ channelId: 'C-test', threadTs: '2.3' }, 'xoxb-injected');

		const data = v.parse(tool.input, {
			text: 'p95 latency fell from 480 ms on Monday to 210 ms on Wednesday.',
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
		expect(posted).toEqual([
			{
				channel: 'C-test',
				thread_ts: '2.3',
				text: data.text,
				blocks: data.blocks,
				unfurl_links: false,
				unfurl_media: false,
			},
		]);
		expect(posted[0]).not.toHaveProperty('markdown_text');
	});

	test('posts normalized table cells and header text', async () => {
		__setSlackClientFactoryForTests(fakeClient);
		const tool = replyInThread({ channelId: 'C-test', threadTs: '2.3' }, 'xoxb-injected');

		const data = v.parse(tool.input, {
			text: 'lint took 1.5 minutes on 09/23.',
			blocks: [
				{ type: 'header', text: 'Results' },
				{
					type: 'data_table',
					caption: 'Results',
					rows: [
						['Job', 'When', 'Minutes'],
						['lint', '09/23', 1.5],
					],
				},
			],
		});

		await expect(
			tool.run({
				data,
				toolCallId: 'post-cells',
				log: { info() {}, warn() {}, error() {} },
			}),
		).resolves.toEqual({
			output: { posted: true, text: data.text, blocks: null, channel: null, ts: null },
		});
		expect(posted).toEqual([
			{
				channel: 'C-test',
				thread_ts: '2.3',
				text: data.text,
				blocks: [
					{ type: 'header', text: { type: 'plain_text', text: 'Results' } },
					{
						type: 'data_table',
						caption: 'Results',
						rows: [
							[
								{ type: 'raw_text', text: 'Job' },
								{ type: 'raw_text', text: 'When' },
								{ type: 'raw_text', text: 'Minutes' },
							],
							[
								{ type: 'raw_text', text: 'lint' },
								{ type: 'raw_text', text: '09/23' },
								{ type: 'raw_number', value: 1.5 },
							],
						],
					},
				],
				unfurl_links: false,
				unfurl_media: false,
			},
		]);
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
			output: { posted: true, text: 'hello Slack', blocks: null, channel: null, ts: null },
		});
		expect(posted).toEqual([
			{
				channel: 'C-test',
				thread_ts: '2.3',
				markdown_text: 'hello Slack',
				unfurl_links: false,
				unfurl_media: false,
			},
		]);
	});

	test('logs the Slack error code and rethrows when chat.postMessage fails', async () => {
		const failure = Object.assign(new Error('An API error occurred: invalid_blocks'), {
			data: { ok: false, error: 'invalid_blocks' },
		});

		__setSlackClientFactoryForTests(() => ({
			chat: {
				async postMessage() {
					throw failure;
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
		}));
		const tool = replyInThread({ channelId: 'C-test', threadTs: '2.3' }, 'xoxb-injected');
		const blocks = [{ type: 'divider' as const }];

		await expect(
			tool.run({
				data: { text: 'chart fallback', blocks },
				toolCallId: 'post-fail',
				log: { info() {}, warn() {}, error() {} },
			}),
		).rejects.toBe(failure);

		expect(console.log).not.toHaveBeenCalled();
		expect(JSON.parse(String(vi.mocked(console.warn).mock.calls[0]?.[0]))).toMatchObject({
			event: 'slack.reply_post',
			toolCallId: 'post-fail',
			channel: 'C-test',
			blocks: true,
			blockCount: 1,
			ok: false,
			error: 'invalid_blocks',
		});
	});

	test('reports a delivered reply as posted when logging throws', async () => {
		__setSlackClientFactoryForTests(fakeClient);
		vi.mocked(console.log).mockImplementation(() => {
			throw new Error('console unavailable');
		});
		const tool = replyInThread({ channelId: 'C-test', threadTs: '2.3' }, 'xoxb-injected');

		await expect(
			tool.run({
				data: { text: 'hello Slack' },
				toolCallId: 'post-log-throws',
				log: { info() {}, warn() {}, error() {} },
			}),
		).resolves.toMatchObject({ output: { posted: true } });
		expect(posted).toHaveLength(1);
	});
});
