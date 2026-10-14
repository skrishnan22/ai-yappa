import { afterEach, describe, expect, test, vi } from 'vitest';
import { __resetSlackClientForTests, getSlackClient } from '../channels/slack-reply.ts';
import { stringParam, stubSlackApi } from '../channels/testing/slack-api-stub.ts';
import { openTestDatabase } from '../testing/d1.ts';
import type { AutomationStore, NewAutomation } from './automation.ts';
import { createD1AutomationStore } from './d1-automation-store.ts';
import { recordRunSettled } from './outcome.ts';

const AT = '2026-10-14T04:00:00.000Z';

const digest: NewAutomation = {
	id: 'a1',
	kind: 'agent',
	title: 'Digest',
	prompt: 'AI news',
	scope: 'personal',
	destinationChannelId: 'D_OWNER',
	schedule: { kind: 'recurring', cron: '0 9 * * *' },
	timezone: 'Asia/Kolkata',
	ownerUserId: 'U_OWNER',
	nextRunAt: AT,
	createdAt: AT,
};

afterEach(() => {
	vi.unstubAllGlobals();
	__resetSlackClientForTests();
});

async function setup() {
	const db = await openTestDatabase();
	const store = createD1AutomationStore(db);

	// conversations.open reads `channel`; chat.postMessage reads `ts`.
	const calls = stubSlackApi(async () => ({ ok: true, channel: { id: 'D_OWNER' }, ts: '1.1' }));

	await store.automations.create(digest);

	return { store, calls, slack: getSlackClient('xoxb-test') };
}

// A fire the scheduler dispatched, waiting for its submission to settle.
async function dispatchedRun(store: AutomationStore, fireTime: string): Promise<string> {
	const submissionId = `sub-${fireTime}`;

	await store.runs.claim({ automationId: 'a1', fireTime, createdAt: AT });
	await store.runs.dispatched({
		automationId: 'a1',
		fireTime,
		conversationId: 'conv',
		submissionId,
	});

	return submissionId;
}

describe('recordRunSettled', () => {
	test('three failed settles pause the automation and DM the owner once', async () => {
		const { store, calls, slack } = await setup();

		for (const fireTime of ['t1', 't2', 't3', 't4']) {
			const submissionId = await dispatchedRun(store, fireTime);

			await recordRunSettled({
				store,
				slack,
				submissionId,
				outcome: 'failed',
				error: 'boom',
				at: AT,
			});
		}

		const automation = await store.automations.get('a1');
		const notices = calls.filter((call) => call.method === 'chat.postMessage');

		expect(automation).toMatchObject({ status: 'paused', consecutiveFailures: 4 });
		expect(notices).toHaveLength(1);
		expect(notices[0]?.params.channel).toBe('D_OWNER');
		expect(notices[0] && stringParam(notices[0], 'text')).toContain('3 failed runs');
	});

	test('an aborted run counts as a failure, and records why', async () => {
		const { store, slack } = await setup();
		const submissionId = await dispatchedRun(store, 't1');

		await recordRunSettled({
			store,
			slack,
			submissionId,
			outcome: 'aborted',
			error: 'stopped',
			at: AT,
		});

		const automation = await store.automations.get('a1');
		const runs = await store.runs.list('a1');

		expect(automation?.consecutiveFailures).toBe(1);
		expect(runs).toMatchObject([{ status: 'failed', reason: 'stopped' }]);
	});

	test('a success resets the failure count', async () => {
		const { store, slack } = await setup();

		await store.automations.recordFailure({ id: 'a1', at: AT, pauseAt: 3 });

		const submissionId = await dispatchedRun(store, 't1');

		await recordRunSettled({ store, slack, submissionId, outcome: 'completed', at: AT });

		const automation = await store.automations.get('a1');

		expect(automation?.consecutiveFailures).toBe(0);
	});

	test('a submission that is not a fire changes nothing', async () => {
		const { store, calls, slack } = await setup();

		await dispatchedRun(store, 't1');
		await recordRunSettled({
			store,
			slack,
			submissionId: 'a-human-reply',
			outcome: 'failed',
			at: AT,
		});

		const automation = await store.automations.get('a1');

		expect(automation?.consecutiveFailures).toBe(0);
		expect(calls).toEqual([]);
	});

	test('without a Slack client the failure still counts', async () => {
		const { store } = await setup();

		for (const fireTime of ['t1', 't2', 't3']) {
			const submissionId = await dispatchedRun(store, fireTime);

			await recordRunSettled({ store, slack: undefined, submissionId, outcome: 'failed', at: AT });
		}

		const automation = await store.automations.get('a1');

		expect(automation?.status).toBe('paused');
	});
});
