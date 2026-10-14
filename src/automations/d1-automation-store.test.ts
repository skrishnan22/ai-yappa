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

	test('scheduled claim advances a recurring automation once and rejects stale fires', async () => {
		const s = await store();
		await s.automations.create(newAutomation());

		const claim = {
			automationId: 'a1',
			fireTime: '2026-10-14T03:30:00.000Z',
			nextRunAt: '2026-10-15T03:30:00.000Z',
			at: AT,
		};

		const stale = await s.runs.claimScheduled({ ...claim, fireTime: 'stale' });

		const [first, second] = await Promise.all([
			s.runs.claimScheduled(claim),
			s.runs.claimScheduled(claim),
		]);

		const moved = await s.automations.get('a1');
		const runs = await s.runs.list('a1');
		expect(stale).toBe(false);
		expect(first).not.toBe(second);
		expect(moved).toMatchObject({
			status: 'active',
			lastRunAt: claim.fireTime,
			nextRunAt: claim.nextRunAt,
		});
		expect(runs).toEqual([
			{ automationId: 'a1', fireTime: claim.fireTime, status: 'claimed', createdAt: AT },
		]);
	});

	test('scheduled claim completes an actual one-off', async () => {
		const s = await store();
		await s.automations.create(
			newAutomation({ schedule: { kind: 'once', runAt: AT }, nextRunAt: AT }),
		);
		const claimed = await s.runs.claimScheduled({ automationId: 'a1', fireTime: AT, at: AT });
		const done = await s.automations.get('a1');
		expect(claimed).toBe(true);
		expect(done).toMatchObject({ status: 'completed', lastRunAt: AT, nextRunAt: undefined });
	});

	test.each(['paused', 'blocked', 'deleted'] as const)(
		'scheduled claim cannot overwrite %s',
		async (status) => {
			const s = await store();
			await s.automations.create(
				newAutomation({ schedule: { kind: 'once', runAt: AT }, nextRunAt: AT }),
			);
			await s.automations.setStatus({ id: 'a1', status, at: AT });
			const claimed = await s.runs.claimScheduled({ automationId: 'a1', fireTime: AT, at: AT });
			const row = await s.automations.get('a1');
			const runs = await s.runs.list('a1');
			expect(claimed).toBe(false);
			expect(row).toMatchObject({ status, nextRunAt: AT, lastRunAt: undefined });
			expect(runs).toEqual([]);
		},
	);

	test('failed advancement rolls back the claim so the next tick can retry', async () => {
		const db = await openTestDatabase();
		const s = createD1AutomationStore(db);
		await s.automations.create(newAutomation());
		await db
			.prepare(
				"CREATE TRIGGER reject_advance BEFORE UPDATE ON automations BEGIN SELECT RAISE(ABORT, 'advance failed'); END",
			)
			.run();

		const claim = {
			automationId: 'a1',
			fireTime: '2026-10-14T03:30:00.000Z',
			nextRunAt: '2026-10-15T03:30:00.000Z',
			at: AT,
		};

		await expect(s.runs.claimScheduled(claim)).rejects.toThrow('advance failed');
		const runs = await s.runs.list('a1');
		const row = await s.automations.get('a1');
		expect(runs).toEqual([]);
		expect(row?.nextRunAt).toBe(claim.fireTime);
		await db.prepare('DROP TRIGGER reject_advance').run();
		const retried = await s.runs.claimScheduled(claim);
		expect(retried).toBe(true);
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

	test('a taken fire does not advance even when its automation still matches', async () => {
		const s = await store();
		await s.automations.create(newAutomation());
		const fireTime = '2026-10-14T03:30:00.000Z';
		await s.runs.claim({ automationId: 'a1', fireTime, createdAt: AT });

		const claimed = await s.runs.claimScheduled({
			automationId: 'a1',
			fireTime,
			nextRunAt: '2026-10-15T03:30:00.000Z',
			at: AT,
		});

		const row = await s.automations.get('a1');
		expect(claimed).toBe(false);
		expect(row).toMatchObject({ nextRunAt: fireTime, lastRunAt: undefined, status: 'active' });
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
