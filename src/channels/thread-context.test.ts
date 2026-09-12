import { describe, expect, test } from 'vitest';
import {
	formatThreadContext,
	loadThreadContext,
	THREAD_CONTEXT_CHAR_CAP,
	THREAD_CONTEXT_MAX_PAGES,
} from './thread-context.ts';

describe('formatThreadContext', () => {
	test('skips bot messages and blank text', () => {
		expect(
			formatThreadContext([
				{ user: 'U1', text: 'hello' },
				{ user: 'U_BOT', bot_id: 'B1', text: 'I am a bot' },
				{ user: 'U2', text: '  ' },
				{ user: 'U2', text: 'follow up' },
			]),
		).toBe('<@U1>: hello\n<@U2>: follow up');
	});

	test('keeps the tail when over the cap', () => {
		const formatted = formatThreadContext(
			[
				{ user: 'U1', text: 'aaaa' },
				{ user: 'U2', text: 'bbbb' },
			],
			6,
		);
		expect(formatted.length).toBe(6);
		expect(formatted.endsWith('bbbb')).toBe(true);
	});
});

describe('loadThreadContext', () => {
	test('returns undefined when only bot messages exist', async () => {
		const context = await loadThreadContext(
			{
				conversations: {
					async replies() {
						return { messages: [{ bot_id: 'B1', text: 'hi' }] };
					},
				},
			},
			{ channelId: 'C1', threadTs: '1.2' },
		);
		expect(context).toBeUndefined();
	});

	test('formats human replies from conversations.replies', async () => {
		const context = await loadThreadContext(
			{
				conversations: {
					async replies(args) {
						expect(args).toEqual({ channel: 'C1', ts: '1.2', limit: 100 });
						return { messages: [{ user: 'U1', text: 'please fix the login' }] };
					},
				},
			},
			{ channelId: 'C1', threadTs: '1.2' },
		);
		expect(context).toBe('<@U1>: please fix the login');
	});

	test('follows next_cursor so recent replies are included', async () => {
		const cursors: Array<string | undefined> = [];
		const context = await loadThreadContext(
			{
				conversations: {
					async replies(args) {
						cursors.push(args.cursor);
						if (args.cursor === undefined) {
							return {
								messages: [{ user: 'U1', text: 'old request' }],
								response_metadata: { next_cursor: 'page-2' },
							};
						}
						return { messages: [{ user: 'U2', text: 'recent follow-up' }] };
					},
				},
			},
			{ channelId: 'C1', threadTs: '1.2' },
		);
		expect(cursors).toEqual([undefined, 'page-2']);
		expect(context).toBe('<@U1>: old request\n<@U2>: recent follow-up');
	});

	test('stops paging at the documented ceiling', async () => {
		let pages = 0;
		await loadThreadContext(
			{
				conversations: {
					async replies() {
						pages++;
						return {
							messages: [{ user: 'U1', text: `m${pages}` }],
							response_metadata: { next_cursor: 'more' },
						};
					},
				},
			},
			{ channelId: 'C1', threadTs: '1.2' },
		);
		expect(pages).toBe(THREAD_CONTEXT_MAX_PAGES);
	});

	test('char cap is the documented M3 ceiling', () => {
		expect(THREAD_CONTEXT_CHAR_CAP).toBe(8_000);
	});
});
