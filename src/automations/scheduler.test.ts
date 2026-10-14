import { afterEach, describe, expect, test, vi } from 'vitest';
import { __resetSlackClientForTests, getSlackClient } from '../channels/slack-reply.ts';
import { stringParam, stubSlackApi } from '../channels/testing/slack-api-stub.ts';
import type { JsonObject } from '../json.ts';
import { openTestDatabase } from '../testing/d1.ts';
import type { AutomationStore, NewAutomation } from './automation.ts';
import { createD1AutomationStore } from './d1-automation-store.ts';
import { runDueAutomations, runNow, type SchedulerDeps, type StartRun } from './scheduler.ts';

// A tick just after 09:00 IST on Wednesday 14 Oct 2026.
const NOW = new Date('2026-10-14T03:30:20.000Z');

function automation(overrides: Partial<NewAutomation> = {}): NewAutomation {
	return {
		id: 'a1',
		kind: 'agent',
		title: 'Merged PRs',
		prompt: "Post yesterday's merged PRs.",
		scope: 'channel',
		destinationChannelId: 'C_ENG',
		repo: 'https://github.com/acme/api.git',
		schedule: { kind: 'recurring', cron: '0 9 * * 1-5' },
		timezone: 'Asia/Kolkata',
		ownerUserId: 'U_OWNER',
		nextRunAt: '2026-10-14T03:30:00.000Z',
		createdAt: '2026-10-13T00:00:00.000Z',
		...overrides,
	};
}

type SlackState = { ownerDeleted?: boolean; postError?: string };

async function setup({ ownerDeleted = false, postError }: SlackState = {}) {
	const db = await openTestDatabase();
	const store: AutomationStore = createD1AutomationStore(db);

	const calls = stubSlackApi(async (call): Promise<JsonObject> => {
		if (call.method === 'users.info') {
			return { ok: true, user: { id: 'U_OWNER', deleted: ownerDeleted } };
		}

		if (call.method === 'chat.postMessage' && postError && call.params.channel === 'C_ENG') {
			return { ok: false, error: postError };
		}

		// conversations.open reads `channel`; chat.postMessage reads `ts`.
		return { ok: true, channel: { id: 'D_OWNER' }, ts: '100.1' };
	});

	const started: Parameters<StartRun>[0][] = [];

	const deps: SchedulerDeps = {
		store,
		slack: getSlackClient('xoxb-test'),
		startRun: async (run) => {
			started.push(run);

			return { conversationId: `conv-${started.length}`, submissionId: `sub-${started.length}` };
		},
		now: () => NOW,
	};

	return { store, calls, started, deps };
}

afterEach(() => {
	vi.unstubAllGlobals();
	__resetSlackClientForTests();
});

describe('runDueAutomations', () => {
	test('posts a header, dispatches in its thread, and advances the schedule', async () => {
		const { store, calls, started, deps } = await setup();

		await store.automations.create(automation());
		await runDueAutomations(deps);

		const header = calls.find((call) => call.method === 'chat.postMessage');
		const advanced = await store.automations.get('a1');
		const runs = await store.runs.list('a1');

		expect(header?.params.channel).toBe('C_ENG');
		expect(header && stringParam(header, 'text')).toContain('Merged PRs');
		expect(started).toEqual([
			{
				automation: expect.objectContaining({ id: 'a1' }),
				threadTs: '100.1',
				fireTime: '2026-10-14T03:30:00.000Z',
			},
		]);
		expect(advanced).toMatchObject({
			lastRunAt: '2026-10-14T03:30:00.000Z',
			nextRunAt: '2026-10-15T03:30:00.000Z',
		});
		expect(runs).toMatchObject([
			{ status: 'dispatched', conversationId: 'conv-1', submissionId: 'sub-1' },
		]);
	});

	test('two ticks over the same due row fire once', async () => {
		const { store, started, deps } = await setup();

		await store.automations.create(automation());
		await Promise.all([runDueAutomations(deps), runDueAutomations(deps)]);

		expect(started).toHaveLength(1);
	});

	test('several missed fires produce one run and no backlog', async () => {
		const { store, started, deps } = await setup();

		// Last due on the previous Friday.
		await store.automations.create(automation({ nextRunAt: '2026-10-09T03:30:00.000Z' }));
		await runDueAutomations(deps);
		await runDueAutomations(deps);

		const advanced = await store.automations.get('a1');

		expect(started).toHaveLength(1);
		expect(advanced?.nextRunAt).toBe('2026-10-15T03:30:00.000Z');
	});

	test('a row that is not yet due is left alone', async () => {
		const { store, calls, started, deps } = await setup();

		await store.automations.create(automation({ nextRunAt: '2026-10-14T03:31:00.000Z' }));
		await runDueAutomations(deps);

		expect(started).toEqual([]);
		expect(calls).toEqual([]);
	});

	test('a one-off reminder posts to the DM without dispatch, and completes', async () => {
		const { store, calls, started, deps } = await setup();

		await store.automations.create(
			automation({
				kind: 'reminder',
				scope: 'personal',
				destinationChannelId: 'D_OWNER',
				repo: undefined,
				prompt: 'Book tickets',
				schedule: { kind: 'once', runAt: '2026-10-14T03:30:00.000Z' },
			}),
		);
		await runDueAutomations(deps);

		const post = calls.find((call) => call.method === 'chat.postMessage');
		const completed = await store.automations.get('a1');
		const runs = await store.runs.list('a1');

		expect(post?.params.channel).toBe('D_OWNER');
		expect(post && stringParam(post, 'text')).toBe('<@U_OWNER> ⏰ Book tickets');
		expect(started).toEqual([]);
		expect(completed?.status).toBe('completed');
		expect(runs).toMatchObject([{ status: 'posted' }]);
	});

	test('a deactivated owner blocks the automation and gets a DM', async () => {
		const { store, calls, started, deps } = await setup({ ownerDeleted: true });

		await store.automations.create(automation());
		await runDueAutomations(deps);

		const blocked = await store.automations.get('a1');
		const runs = await store.runs.list('a1');
		const posts = calls.filter((call) => call.method === 'chat.postMessage');

		expect(started).toEqual([]);
		expect(blocked?.status).toBe('blocked');
		expect(runs).toMatchObject([{ status: 'failed' }]);
		expect(posts.map((call) => call.params.channel)).toEqual(['D_OWNER']);
	});

	test('a channel the bot left blocks the automation', async () => {
		const { store, started, deps } = await setup({ postError: 'not_in_channel' });

		await store.automations.create(automation());
		await runDueAutomations(deps);

		const blocked = await store.automations.get('a1');
		const runs = await store.runs.list('a1');

		expect(started).toEqual([]);
		expect(blocked?.status).toBe('blocked');
		expect(runs).toMatchObject([{ status: 'failed', reason: expect.stringContaining('<#C_ENG>') }]);
	});

	test('a dispatch failure counts toward the pause', async () => {
		const { store, deps } = await setup();

		await store.automations.create(automation());
		await runDueAutomations({
			...deps,
			startRun: async () => {
				throw new Error('queue down');
			},
		});

		const counted = await store.automations.get('a1');
		const runs = await store.runs.list('a1');

		expect(counted).toMatchObject({ status: 'active', consecutiveFailures: 1 });
		expect(runs).toMatchObject([{ status: 'failed', reason: 'queue down' }]);
	});

	test('one broken automation does not stop the others', async () => {
		const { store, started, deps } = await setup();

		await store.automations.create(automation({ id: 'a1' }));
		await store.automations.create(automation({ id: 'a2' }));

		await runDueAutomations({
			...deps,
			startRun: async (run) => {
				if (run.automation.id === 'a1') throw new Error('queue down');

				return deps.startRun(run);
			},
		});

		expect(started.map((run) => run.automation.id)).toEqual(['a2']);
	});
});

describe('runNow', () => {
	test('fires at now without moving the schedule', async () => {
		const { store, started, deps } = await setup();

		const created = await store.automations.create(
			automation({ nextRunAt: '2026-10-15T03:30:00.000Z' }),
		);

		const fired = await runNow({ automation: created, deps });
		const unchanged = await store.automations.get('a1');

		expect(fired).toBe(true);
		expect(started[0]?.fireTime).toBe(NOW.toISOString());
		expect(unchanged?.nextRunAt).toBe('2026-10-15T03:30:00.000Z');
	});
});
