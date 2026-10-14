import { describe, expect, test } from 'vitest';
import { openTestDatabase } from '../testing/d1.ts';
import type { AutomationFields, NewAutomation } from './automation.ts';
import { createD1AutomationStore } from './d1-automation-store.ts';

const AT = '2026-10-14T03:00:00.000Z';

const fields: AutomationFields = {
	kind: 'agent',
	title: 'Merged PRs',
	prompt: "Post yesterday's merged PRs.",
	scope: 'channel',
	destinationChannelId: 'C_ENG',
	repo: 'https://github.com/acme/api.git',
	schedule: { kind: 'recurring', cron: '0 9 * * 1-5' },
	timezone: 'Asia/Kolkata',
};

function newAutomation(overrides: Partial<NewAutomation> = {}): NewAutomation {
	return {
		...fields,
		id: 'a1',
		ownerUserId: 'U_OWNER',
		nextRunAt: '2026-10-14T03:30:00.000Z',
		createdAt: AT,
		...overrides,
	};
}

async function store() {
	const db = await openTestDatabase();

	return createD1AutomationStore(db);
}

describe('automations', () => {
	test('create stores every field and starts active', async () => {
		const s = await store();
		const created = await s.automations.create(newAutomation());
		const read = await s.automations.get('a1');

		expect(created).toEqual({
			...fields,
			id: 'a1',
			ownerUserId: 'U_OWNER',
			status: 'active',
			nextRunAt: '2026-10-14T03:30:00.000Z',
			consecutiveFailures: 0,
			createdAt: AT,
			updatedAt: AT,
		});
		expect(read).toEqual(created);
	});

	test('a one-off keeps run_at and no cron', async () => {
		const s = await store();
		const once = { kind: 'once', runAt: '2026-10-15T12:30:00.000Z' } as const;

		await s.automations.create(newAutomation({ schedule: once, repo: undefined }));

		const read = await s.automations.get('a1');

		expect(read).toMatchObject({ schedule: once, repo: undefined });
	});

	test('due returns active rows at or before now, oldest first', async () => {
		const s = await store();

		await s.automations.create(
			newAutomation({ id: 'late', nextRunAt: '2026-10-14T02:00:00.000Z' }),
		);
		await s.automations.create(newAutomation({ id: 'now', nextRunAt: AT }));
		await s.automations.create(
			newAutomation({ id: 'future', nextRunAt: '2026-10-14T04:00:00.000Z' }),
		);
		await s.automations.create(
			newAutomation({ id: 'paused', nextRunAt: '2026-10-14T01:00:00.000Z' }),
		);
		await s.automations.setStatus({ id: 'paused', status: 'paused', at: AT });

		const due = await s.automations.due({ now: AT, limit: 50 });

		expect(due.map((automation) => automation.id)).toEqual(['late', 'now']);
	});

	test('advance moves only from the expected next run, and completes a one-off', async () => {
		const s = await store();

		await s.automations.create(newAutomation());

		const stale = await s.automations.advance({ id: 'a1', from: 'stale', nextRunAt: 'x', at: AT });

		const advanced = await s.automations.advance({
			id: 'a1',
			from: '2026-10-14T03:30:00.000Z',
			nextRunAt: '2026-10-15T03:30:00.000Z',
			at: AT,
		});

		const moved = await s.automations.get('a1');

		expect(stale).toBe(false);
		expect(advanced).toBe(true);
		expect(moved).toMatchObject({
			status: 'active',
			lastRunAt: '2026-10-14T03:30:00.000Z',
			nextRunAt: '2026-10-15T03:30:00.000Z',
		});

		await s.automations.advance({ id: 'a1', from: '2026-10-15T03:30:00.000Z', at: AT });

		const done = await s.automations.get('a1');

		expect(done?.status).toBe('completed');
		expect(done?.nextRunAt).toBeUndefined();
	});

	test('update replaces fields, next run and status', async () => {
		const s = await store();

		await s.automations.create(newAutomation());

		const updated = await s.automations.update({
			id: 'a1',
			fields: { ...fields, title: 'Renamed', schedule: { kind: 'recurring', cron: '0 10 * * *' } },
			nextRunAt: '2026-10-14T04:30:00.000Z',
			status: 'active',
			at: '2026-10-14T03:10:00.000Z',
		});

		expect(updated).toMatchObject({
			title: 'Renamed',
			schedule: { kind: 'recurring', cron: '0 10 * * *' },
			nextRunAt: '2026-10-14T04:30:00.000Z',
			updatedAt: '2026-10-14T03:10:00.000Z',
		});
	});

	test('three failures pause an active automation; resuming resets the count', async () => {
		const s = await store();

		await s.automations.create(newAutomation());
		await s.automations.recordFailure({ id: 'a1', at: AT, pauseAt: 3 });
		await s.automations.recordFailure({ id: 'a1', at: AT, pauseAt: 3 });

		const third = await s.automations.recordFailure({ id: 'a1', at: AT, pauseAt: 3 });
		const resumed = await s.automations.setStatus({ id: 'a1', status: 'active', at: AT });

		expect(third).toMatchObject({ status: 'paused', consecutiveFailures: 3 });
		expect(resumed).toMatchObject({ status: 'active', consecutiveFailures: 0 });
	});

	test('a success resets the failure count', async () => {
		const s = await store();

		await s.automations.create(newAutomation());
		await s.automations.recordFailure({ id: 'a1', at: AT, pauseAt: 3 });
		await s.automations.recordSuccess({ id: 'a1', at: AT });

		const read = await s.automations.get('a1');

		expect(read?.consecutiveFailures).toBe(0);
	});

	test('pausing keeps the next run unless one is given', async () => {
		const s = await store();

		await s.automations.create(newAutomation());

		const paused = await s.automations.setStatus({ id: 'a1', status: 'paused', at: AT });

		expect(paused).toMatchObject({ status: 'paused', nextRunAt: '2026-10-14T03:30:00.000Z' });
	});

	test('a deleted automation does not change status or fields', async () => {
		const s = await store();

		await s.automations.create(newAutomation());
		await s.automations.setStatus({ id: 'a1', status: 'deleted', at: AT });

		const resumed = await s.automations.setStatus({ id: 'a1', status: 'active', at: AT });

		const updated = await s.automations.update({
			id: 'a1',
			fields,
			nextRunAt: AT,
			status: 'active',
			at: AT,
		});

		expect(resumed).toBeUndefined();
		expect(updated).toBeUndefined();
	});

	test("visibleTo shows the user's personal ones and this channel's channel ones", async () => {
		const s = await store();

		const rows: Partial<NewAutomation>[] = [
			{ id: 'mine', scope: 'personal', ownerUserId: 'U1', destinationChannelId: 'D1' },
			{ id: 'theirs', scope: 'personal', ownerUserId: 'U2', destinationChannelId: 'D2' },
			{ id: 'here', ownerUserId: 'U2', destinationChannelId: 'C_HERE' },
			{ id: 'elsewhere', ownerUserId: 'U1', destinationChannelId: 'C_OTHER' },
			{ id: 'gone', scope: 'personal', ownerUserId: 'U1', destinationChannelId: 'D1' },
		];

		for (const row of rows) {
			await s.automations.create(newAutomation(row));
		}

		await s.automations.setStatus({ id: 'gone', status: 'deleted', at: AT });

		const visible = await s.automations.visibleTo({ userId: 'U1', channelId: 'C_HERE' });

		expect(visible.map((automation) => automation.id).toSorted()).toEqual(['here', 'mine']);
	});
});

describe('runs', () => {
	test('a fire is claimed once', async () => {
		const s = await store();
		const claim = { automationId: 'a1', fireTime: AT, createdAt: AT };
		const first = await s.runs.claim(claim);
		const second = await s.runs.claim(claim);

		expect(first).toBe(true);
		expect(second).toBe(false);
	});

	test('finish records a posted or failed outcome', async () => {
		const s = await store();

		await s.runs.claim({ automationId: 'a1', fireTime: AT, createdAt: AT });
		await s.runs.finish({
			automationId: 'a1',
			fireTime: AT,
			status: 'failed',
			reason: 'no channel',
		});

		const runs = await s.runs.list('a1');

		expect(runs).toEqual([
			{ automationId: 'a1', fireTime: AT, status: 'failed', reason: 'no channel', createdAt: AT },
		]);
	});

	test('settle matches only a dispatched run, once', async () => {
		const s = await store();

		await s.runs.claim({ automationId: 'a1', fireTime: AT, createdAt: AT });
		await s.runs.dispatched({
			automationId: 'a1',
			fireTime: AT,
			conversationId: 'conv',
			submissionId: 'sub-1',
		});

		const other = await s.runs.settle({ submissionId: 'sub-other', status: 'succeeded' });

		const settled = await s.runs.settle({
			submissionId: 'sub-1',
			status: 'failed',
			reason: 'boom',
		});

		const again = await s.runs.settle({ submissionId: 'sub-1', status: 'succeeded' });

		expect(other).toBeUndefined();
		expect(settled).toMatchObject({
			automationId: 'a1',
			status: 'failed',
			reason: 'boom',
			conversationId: 'conv',
		});
		expect(again).toBeUndefined();
	});
});
