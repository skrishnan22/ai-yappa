import { afterEach, describe, expect, test, vi } from 'vitest';
import type { JsonValue } from '../json.ts';
import {
	__resetRunCardForTests,
	applyCardEvent,
	bindRunCard,
	formatElapsed,
	publishCardEvent,
	formatModelRoute,
	renderRunCard,
	type CardEvent,
	type RoutedCardEvent,
	type RunCardState,
} from './run-card.ts';
import { stringParam, stubSlackApi } from './testing/slack-api-stub.ts';
import { __resetSlackClientForTests } from './slack-reply.ts';

type SlackCardPort = {
	post(args: {
		channel: string;
		threadTs: string;
		text: string;
		blocks: JsonValue;
	}): Promise<{ ts: string | null }>;
	update(args: { channel: string; ts: string; text: string; blocks: JsonValue }): Promise<void>;
	notify(args: { channel: string; threadTs: string; text: string }): Promise<void>;
};

const TOKEN = 'xoxb-test';

// Routes the Slack Web API calls the card makes to the fake: chat.postMessage
// with blocks is the card post, without blocks the settle ping, and
// chat.update edits the card. A throwing notify surfaces as a Slack API error.
function stubCardApi(port: SlackCardPort) {
	return stubSlackApi(async (call): Promise<Record<string, JsonValue>> => {
		const { method, params } = call;

		if (method === 'chat.update') {
			await port.update({
				channel: stringParam(call, 'channel'),
				ts: stringParam(call, 'ts'),
				text: stringParam(call, 'text'),
				blocks: params.blocks ?? null,
			});

			return { ok: true };
		}

		if (params.blocks) {
			const posted = await port.post({
				channel: stringParam(call, 'channel'),
				threadTs: stringParam(call, 'thread_ts'),
				text: stringParam(call, 'text'),
				blocks: params.blocks,
			});

			return { ok: true, ts: posted.ts };
		}

		try {
			await port.notify({
				channel: stringParam(call, 'channel'),
				threadTs: stringParam(call, 'thread_ts'),
				text: stringParam(call, 'text'),
			});
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}

		return { ok: true };
	});
}

afterEach(() => {
	__resetRunCardForTests();
	__resetSlackClientForTests();
	vi.unstubAllGlobals();
});

function working(overrides?: Partial<RunCardState>): RunCardState {
	return {
		submissionId: 'sub-1',
		messageTs: '9.9',
		status: 'working',
		step: 'Working',
		startedAt: 1_000,
		...overrides,
	};
}

function routed(event: CardEvent, instanceId = 'conversation-1'): RoutedCardEvent {
	return { ...event, instanceId };
}

describe('applyCardEvent', () => {
	test('opens a new card on submission_running', () => {
		expect(
			applyCardEvent(null, { type: 'submission_running', submissionId: 'sub-1' }, 5_000),
		).toEqual({
			state: {
				submissionId: 'sub-1',
				messageTs: null,
				status: 'working',
				step: 'Working',
				startedAt: 5_000,
			},
		});
	});

	test('keeps messageTs when the same submission is re-emitted', () => {
		const applied = applyCardEvent(
			working(),
			{ type: 'submission_running', submissionId: 'sub-1' },
			8_000,
		);

		expect(applied?.state.messageTs).toBe('9.9');
		expect(applied?.state.startedAt).toBe(1_000);
	});

	test('posts a new card for a later submission', () => {
		const applied = applyCardEvent(
			working({ status: 'completed', step: 'Completed', messageTs: 'old.ts' }),
			{ type: 'submission_running', submissionId: 'sub-2' },
			9_000,
		);

		expect(applied?.state).toEqual({
			submissionId: 'sub-2',
			messageTs: null,
			status: 'working',
			step: 'Working',
			startedAt: 9_000,
		});
	});

	test('does not post a second card when hydration used a placeholder id', () => {
		const hydrated = applyCardEvent(null, { type: 'hydration', phase: 'start' }, 1_000);
		expect(hydrated?.state.submissionId).toBe('active');

		const running = applyCardEvent(
			hydrated!.state,
			{ type: 'submission_running', submissionId: 'sub-1' },
			2_000,
		);

		expect(running?.state.submissionId).toBe('sub-1');
		expect(running?.state.status).toBe('working');
		expect(running?.state.messageTs).toBeNull();
	});

	test('a tool event from a later submission does not keep the old messageTs', () => {
		const applied = applyCardEvent(
			working({ messageTs: 'old.ts' }),
			{ type: 'tool_start', submissionId: 'sub-2', toolName: 'bash' },
			9_000,
		);

		expect(applied?.state.submissionId).toBe('sub-2');
		expect(applied?.state.messageTs).toBeNull();
		expect(applied?.state.step).toBe('Running a command');
	});

	test('does not downgrade working back to queued on replay', () => {
		const applied = applyCardEvent(
			working(),
			{ type: 'submission_queued', submissionId: 'sub-1' },
			2_000,
		);

		expect(applied?.state.status).toBe('working');
		expect(applied?.state.step).toBe('Working');
	});

	test('hydration start then done updates the step without a new card', () => {
		const start = applyCardEvent(working(), { type: 'hydration', phase: 'start' }, 2_000);
		expect(start?.state.status).toBe('hydrating');
		expect(start?.state.step).toBe('Hydrating workspace');
		expect(start?.state.messageTs).toBe('9.9');

		const done = applyCardEvent(
			start!.state,
			{ type: 'hydration', phase: 'done', skipped: true },
			3_000,
		);

		expect(done?.state.status).toBe('working');
		expect(done?.state.step).toBe('Workspace ready');
	});

	test('tool_start maps known tools and leaves unknown names readable', () => {
		expect(
			applyCardEvent(
				working(),
				{ type: 'tool_start', submissionId: 'sub-1', toolName: 'open_pull_request' },
				2_000,
			)?.state.step,
		).toBe('Opening pull request');
		expect(
			applyCardEvent(
				working(),
				{ type: 'tool_start', submissionId: 'sub-1', toolName: 'mystery' },
				2_000,
			)?.state.step,
		).toBe('Running mystery');
	});

	test('ignores tool_start after the submission settled', () => {
		expect(
			applyCardEvent(
				working({ status: 'completed', step: 'Completed' }),
				{ type: 'tool_start', submissionId: 'sub-1', toolName: 'bash' },
				2_000,
			),
		).toBeUndefined();
	});

	test('scrapes PR and branch urls out of nested tool results', () => {
		const withBranch = applyCardEvent(
			working(),
			{
				type: 'tool',
				submissionId: 'sub-1',
				toolName: 'checkpoint_working_branch',
				result: { output: { htmlUrl: 'https://github.com/org/repo/tree/agent/x' } },
			},
			2_000,
		);

		expect(withBranch?.state.branchUrl).toBe('https://github.com/org/repo/tree/agent/x');

		const withPr = applyCardEvent(
			withBranch!.state,
			{
				type: 'tool',
				submissionId: 'sub-1',
				toolName: 'open_pull_request',
				result: { details: { output: { htmlUrl: 'https://github.com/org/repo/pull/4' } } },
			},
			2_000,
		);

		expect(withPr?.state.prUrl).toBe('https://github.com/org/repo/pull/4');
		expect(withPr?.state.branchUrl).toBe('https://github.com/org/repo/tree/agent/x');
	});

	test('settlement posts a notify ping and keeps the PR link', () => {
		const applied = applyCardEvent(
			working({ prUrl: 'https://github.com/org/repo/pull/4' }),
			{ type: 'submission_settled', submissionId: 'sub-1', outcome: 'completed' },
			4_000,
		);

		expect(applied?.state.status).toBe('completed');
		expect(applied?.state.step).toBe('Pull request opened');
		expect(applied?.notify).toBe('Done: https://github.com/org/repo/pull/4');
	});

	test('completed without a PR does not ping Done', () => {
		const applied = applyCardEvent(
			working(),
			{ type: 'submission_settled', submissionId: 'sub-1', outcome: 'completed' },
			4_000,
		);

		expect(applied?.state.status).toBe('completed');
		expect(applied?.notify).toBeUndefined();
	});

	test('failed settlement truncates the error into the card and notify', () => {
		const applied = applyCardEvent(
			working(),
			{
				type: 'submission_settled',
				submissionId: 'sub-1',
				outcome: 'failed',
				error: 'x'.repeat(300),
			},
			4_000,
		);

		const expected = `Failed: ${'x'.repeat(199)}…`;
		expect(applied?.state.status).toBe('failed');
		expect(applied?.state.step).toBe(expected);
		expect(applied?.notify).toBe(expected);
	});
});

describe('renderRunCard', () => {
	test('includes elapsed, step, and links', () => {
		const rendered = renderRunCard(
			working({
				startedAt: 0,
				prUrl: 'https://github.com/org/repo/pull/4',
				step: 'Opening pull request',
			}),
			65_000,
		);

		expect(rendered.text).toContain('Working');
		expect(rendered.text).toContain('Opening pull request');
		expect(JSON.stringify(rendered.blocks)).not.toContain('"type":"header"');
		expect(JSON.stringify(rendered.blocks)).toContain('1m 5s');
		expect(JSON.stringify(rendered.blocks)).toContain('pull request');
	});

	test('shows model and thinking level in the context block', () => {
		const rendered = renderRunCard(
			working({
				startedAt: 0,
				model: 'opencode-go/deepseek-v4-flash',
				thinkingLevel: 'medium',
			}),
			1_000,
		);

		expect(rendered.text).toContain('opencode-go/deepseek-v4-flash · thinking medium');
		expect(JSON.stringify(rendered.blocks)).toContain(
			'opencode-go/deepseek-v4-flash · thinking medium',
		);
	});

	test('hints at model: only when the thread uses the default model', () => {
		const hint = 'new threads can pick `$model:&lt;name&gt; $effort:&lt;level&gt;`';
		const route = { startedAt: 0, model: 'opencode-go/kimi-k3', thinkingLevel: 'high' };

		expect(
			JSON.stringify(renderRunCard(working({ ...route, modelIsDefault: true }), 1_000).blocks),
		).toContain(hint);
		expect(JSON.stringify(renderRunCard(working(route), 1_000).blocks)).not.toContain(hint);
	});
});

describe('formatModelRoute', () => {
	test('formats model alone or with thinking level', () => {
		expect(formatModelRoute({ model: 'opencode-go/x' })).toBe('opencode-go/x');
		expect(formatModelRoute({ model: 'opencode-go/x', thinkingLevel: 'high' })).toBe(
			'opencode-go/x · thinking high',
		);
		expect(formatModelRoute({})).toBeUndefined();
	});
});

describe('formatElapsed', () => {
	test('formats seconds and minutes', () => {
		expect(formatElapsed(900)).toBe('0s');
		expect(formatElapsed(4_000)).toBe('4s');
		expect(formatElapsed(60_000)).toBe('1m');
		expect(formatElapsed(65_000)).toBe('1m 5s');
	});
});

describe('publishCardEvent', () => {
	test('replays a submission boundary that arrived before the card was bound', async () => {
		const posts: Array<{ ts: string }> = [];
		const updates: Array<{ ts: string }> = [];

		await publishCardEvent(routed({ type: 'submission_running', submissionId: 'sub-2' }), 1_000);

		stubCardApi({
			async post() {
				const ts = `card-${posts.length + 1}`;
				posts.push({ ts });

				return { ts };
			},
			async update(args) {
				updates.push({ ts: args.ts });
			},
			async notify() {},
		});

		bindRunCard({
			instanceId: 'conversation-1',
			channelId: 'C1',
			threadTs: '1.2',
			state: working({ messageTs: 'old.ts' }),
			persist() {},
			token: TOKEN,
		});

		await publishCardEvent(routed({ type: 'hydration', phase: 'start' }), 2_000);

		expect(posts).toEqual([{ ts: 'card-1' }]);
		expect(updates).toEqual([{ ts: 'card-1' }]);
	});

	test('posts once when hydration overlaps a new submission', async () => {
		const posts: Array<{ ts: string }> = [];
		const updates: Array<{ ts: string }> = [];
		let releasePost = () => {};

		const postGate = new Promise<void>((resolve) => {
			releasePost = resolve;
		});

		const port: SlackCardPort = {
			async post() {
				const ts = `card-${posts.length + 1}`;
				posts.push({ ts });
				await postGate;

				return { ts };
			},
			async update(args) {
				updates.push({ ts: args.ts });
			},
			async notify() {},
		};

		stubCardApi(port);

		bindRunCard({
			instanceId: 'conversation-1',
			channelId: 'C1',
			threadTs: '1.2',
			state: working({ status: 'completed', step: 'Completed', messageTs: 'old.ts' }),
			persist() {},
			token: TOKEN,
		});

		const running = publishCardEvent(
			routed({ type: 'submission_running', submissionId: 'sub-2' }),
			1_000,
		);

		const hydration = publishCardEvent(routed({ type: 'hydration', phase: 'start' }), 1_000);

		releasePost();
		await Promise.all([running, hydration]);

		expect(posts).toEqual([{ ts: 'card-1' }]);
		expect(updates).toEqual([{ ts: 'card-1' }]);
	});

	test('stamps model route from bindRunCard onto the posted card', async () => {
		const posts: Array<{ text: string; blocks: unknown }> = [];

		const port: SlackCardPort = {
			async post(args) {
				posts.push({ text: args.text, blocks: args.blocks });

				return { ts: 'card.ts' };
			},
			async update() {},
			async notify() {},
		};

		stubCardApi(port);

		const persisted: RunCardState[] = [];
		bindRunCard({
			instanceId: 'conversation-1',
			channelId: 'C1',
			threadTs: '1.2',
			state: null,
			model: 'opencode-go/deepseek-v4-flash',
			thinkingLevel: 'medium',
			persist(state) {
				persisted.push(state);
			},
			token: TOKEN,
		});
		await publishCardEvent(routed({ type: 'submission_running', submissionId: 'sub-1' }), 1_000);
		expect(posts[0]?.text).toContain('opencode-go/deepseek-v4-flash · thinking medium');
		expect(persisted.at(-1)?.model).toBe('opencode-go/deepseek-v4-flash');
		expect(persisted.at(-1)?.thinkingLevel).toBe('medium');
	});
	test('does not route a new conversation event through the previously bound thread', async () => {
		const firstThreadPosts: unknown[] = [];
		const secondThreadPosts: unknown[] = [];

		const firstThreadPort: SlackCardPort = {
			async post(args) {
				firstThreadPosts.push(args);

				return { ts: 'first-card.ts' };
			},
			async update() {},
			async notify() {},
		};

		stubCardApi(firstThreadPort);

		bindRunCard({
			instanceId: 'conversation-1',
			channelId: 'C1',
			threadTs: 'first-thread.ts',
			state: null,
			persist() {},
			token: TOKEN,
		});

		await publishCardEvent(
			routed({ type: 'submission_queued', submissionId: 'sub-2' }, 'conversation-2'),
		);

		expect(firstThreadPosts).toEqual([]);

		stubCardApi({
			async post(args) {
				secondThreadPosts.push(args);

				return { ts: 'second-card.ts' };
			},
			async update() {},
			async notify() {},
		});

		bindRunCard({
			instanceId: 'conversation-2',
			channelId: 'C1',
			threadTs: 'second-thread.ts',
			state: null,
			persist() {},
			token: TOKEN,
		});
		await publishCardEvent(
			routed({ type: 'submission_running', submissionId: 'sub-2' }, 'conversation-2'),
		);

		expect(secondThreadPosts).toEqual([
			expect.objectContaining({ channel: 'C1', threadTs: 'second-thread.ts' }),
		]);
	});

	test('posts once then updates the same message, and notifies on settle', async () => {
		const posts: unknown[] = [];
		const updates: unknown[] = [];
		const notifies: unknown[] = [];
		const persisted: RunCardState[] = [];

		const port: SlackCardPort = {
			async post(args) {
				posts.push(args);

				return { ts: 'card.ts' };
			},
			async update(args) {
				updates.push(args);
			},
			async notify(args) {
				notifies.push(args);
			},
		};

		stubCardApi(port);

		bindRunCard({
			instanceId: 'conversation-1',
			channelId: 'C1',
			threadTs: '1.2',
			state: null,
			persist: (state) => {
				persisted.push(state);
			},
			token: TOKEN,
		});

		await publishCardEvent(routed({ type: 'submission_running', submissionId: 'sub-1' }), 1_000);
		await publishCardEvent(
			routed({ type: 'tool_start', submissionId: 'sub-1', toolName: 'bash' }),
			2_000,
		);
		await publishCardEvent(
			routed({
				type: 'tool',
				submissionId: 'sub-1',
				toolName: 'open_pull_request',
				result: { output: { htmlUrl: 'https://github.com/org/repo/pull/4' } },
			}),
			3_000,
		);
		await publishCardEvent(
			routed({ type: 'submission_settled', submissionId: 'sub-1', outcome: 'completed' }),
			4_000,
		);

		expect(posts).toHaveLength(1);
		expect(updates.length).toBeGreaterThan(0);
		expect(notifies).toEqual([
			{ channel: 'C1', threadTs: '1.2', text: 'Done: https://github.com/org/repo/pull/4' },
		]);
		expect(persisted.at(-1)?.messageTs).toBe('card.ts');
		expect(persisted.at(-1)?.notifyPosted).toBe(true);
	});

	test('a new submission posts a new Slack message', async () => {
		const posts: Array<{ ts: string }> = [];
		const updates: Array<{ ts: string }> = [];
		const persisted: RunCardState[] = [];

		const port: SlackCardPort = {
			async post() {
				const ts = `card-${posts.length + 1}`;
				posts.push({ ts });

				return { ts };
			},
			async update(args) {
				updates.push({ ts: args.ts });
			},
			async notify() {},
		};

		stubCardApi(port);

		bindRunCard({
			instanceId: 'conversation-1',
			channelId: 'C1',
			threadTs: '1.2',
			state: null,
			persist: (state) => {
				persisted.push(state);
			},
			token: TOKEN,
		});

		await publishCardEvent(routed({ type: 'submission_running', submissionId: 'sub-1' }), 1_000);
		await publishCardEvent(
			routed({ type: 'submission_settled', submissionId: 'sub-1', outcome: 'completed' }),
			2_000,
		);
		expect(posts.map((entry) => entry.ts)).toEqual(['card-1']);

		bindRunCard({
			instanceId: 'conversation-1',
			channelId: 'C1',
			threadTs: '1.2',
			state: persisted.at(-1) ?? null,
			persist: (state) => {
				persisted.push(state);
			},
			token: TOKEN,
		});
		updates.length = 0;
		await publishCardEvent(routed({ type: 'submission_running', submissionId: 'sub-2' }), 3_000);
		await publishCardEvent(
			routed({ type: 'tool_start', submissionId: 'sub-2', toolName: 'bash' }),
			4_000,
		);

		expect(posts.map((entry) => entry.ts)).toEqual(['card-1', 'card-2']);
		expect(persisted.at(-1)?.submissionId).toBe('sub-2');
		expect(persisted.at(-1)?.messageTs).toBe('card-2');
		expect(updates.every((entry) => entry.ts === 'card-2')).toBe(true);
	});

	test('persists settlement when the terminal ping fails, then retries it', async () => {
		const persisted: RunCardState[] = [];
		let notifies = 0;

		const port: SlackCardPort = {
			async post() {
				return { ts: 'card.ts' };
			},
			async update() {},
			async notify() {
				notifies++;

				if (notifies === 1) throw new Error('slack down');
			},
		};

		stubCardApi(port);

		bindRunCard({
			instanceId: 'conversation-1',
			channelId: 'C1',
			threadTs: '1.2',
			state: null,
			persist: (state) => {
				persisted.push(state);
			},
			token: TOKEN,
		});

		await publishCardEvent(
			routed({
				type: 'submission_running',
				submissionId: 'sub-1',
			}),
			1_000,
		);
		await publishCardEvent(
			routed({
				type: 'tool',
				submissionId: 'sub-1',
				toolName: 'open_pull_request',
				result: { output: { htmlUrl: 'https://github.com/org/repo/pull/4' } },
			}),
			2_000,
		);

		await publishCardEvent(
			routed({ type: 'submission_settled', submissionId: 'sub-1', outcome: 'completed' }),
			3_000,
		);

		expect(notifies).toBe(2);
		expect(persisted.at(-1)?.status).toBe('completed');
		expect(persisted.at(-1)?.notifyPosted).toBe(true);
	});

	test('persists the settled card even if every terminal ping attempt fails', async () => {
		const persisted: RunCardState[] = [];

		const port: SlackCardPort = {
			async post() {
				return { ts: 'card.ts' };
			},
			async update() {},
			async notify() {
				throw new Error('slack down');
			},
		};

		stubCardApi(port);

		bindRunCard({
			instanceId: 'conversation-1',
			channelId: 'C1',
			threadTs: '1.2',
			state: null,
			persist: (state) => {
				persisted.push(state);
			},
			token: TOKEN,
		});

		await publishCardEvent(routed({ type: 'submission_running', submissionId: 'sub-1' }), 1_000);
		await expect(
			publishCardEvent(
				routed({
					type: 'submission_settled',
					submissionId: 'sub-1',
					outcome: 'failed',
					error: 'boom',
				}),
				2_000,
			),
		).rejects.toThrow('slack down');

		expect(persisted.at(-1)?.status).toBe('failed');
		expect(persisted.at(-1)?.notifyPosted).not.toBe(true);
	});

	test('skips Slack when no token is bound', async () => {
		const calls = stubSlackApi();

		const persisted: RunCardState[] = [];
		bindRunCard({
			instanceId: 'conversation-1',
			channelId: 'C1',
			threadTs: '1.2',
			state: null,
			persist: (state) => {
				persisted.push(state);
			},
		});
		await publishCardEvent(routed({ type: 'submission_running', submissionId: 'sub-1' }), 1_000);
		expect(persisted[0]?.status).toBe('working');
		expect(persisted[0]?.messageTs).toBeNull();
		expect(calls).toEqual([]);
	});
});
