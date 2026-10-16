import { describe, expect, test } from 'vitest';
import type { Automation } from './automation.ts';
import {
	AUTOMATION_ACTION,
	buttonValue,
	ownerNotice,
	parseButtonValue,
	runMessage,
} from './blocks.ts';

const digest: Automation = {
	id: 'a1',
	kind: 'agent',
	title: 'Merged PRs',
	prompt: "Post yesterday's merged PRs.",
	scope: 'channel',
	destinationChannelId: 'C_ENG',
	schedule: { kind: 'recurring', cron: '0 9 * * 1-5' },
	timezone: 'Asia/Kolkata',
	ownerUserId: 'U_OWNER',
	status: 'active',
	consecutiveFailures: 0,
	createdAt: '2026-10-14T00:00:00.000Z',
	updatedAt: '2026-10-14T00:00:00.000Z',
};

const reminder: Automation = {
	...digest,
	kind: 'reminder',
	title: 'Tickets',
	prompt: 'Book <tickets> & pay',
	scope: 'personal',
	destinationChannelId: 'D_OWNER',
	schedule: { kind: 'once', runAt: '2026-10-15T12:30:00.000Z' },
};

function actionIds(rendered: { blocks: unknown[] }): string[] {
	return [...JSON.stringify(rendered.blocks).matchAll(/"action_id":"([a-z_]+)"/g)].map(
		(match) => match[1] ?? '',
	);
}

describe('runMessage', () => {
	test('an agent run header names the automation and its owner, with Pause and Edit', () => {
		const header = runMessage(digest);

		expect(header.text).toBe('⏰ *Merged PRs* · automation by <@U_OWNER>');
		expect(actionIds(header)).toEqual([AUTOMATION_ACTION.pause, AUTOMATION_ACTION.edit]);
	});

	test('a personal reminder mentions the owner and escapes the text', () => {
		const message = runMessage(reminder);

		expect(message.text).toBe('<@U_OWNER> ⏰ Book &lt;tickets&gt; &amp; pay');
		expect(JSON.stringify(message.blocks)).toContain('Reminder · Tickets');
	});

	test('a channel reminder does not mention the owner in its lead', () => {
		expect(runMessage({ ...reminder, scope: 'channel' }).text).toBe(
			'⏰ Book &lt;tickets&gt; &amp; pay',
		);
	});

	test('the buttons follow the status', () => {
		expect(actionIds(runMessage({ ...digest, status: 'paused' }))).toEqual([
			AUTOMATION_ACTION.resume,
			AUTOMATION_ACTION.edit,
		]);
		expect(actionIds(runMessage({ ...digest, status: 'completed' }))).toEqual([
			AUTOMATION_ACTION.edit,
		]);
		expect(actionIds(runMessage({ ...digest, status: 'deleted' }))).toEqual([]);
	});
});

describe('ownerNotice', () => {
	test('offers Resume for a stopped automation, in list surface', () => {
		const notice = ownerNotice({
			automation: { ...digest, status: 'blocked' },
			message: 'Your automation is blocked.',
		});

		expect(notice.text).toBe('Your automation is blocked.');
		expect(actionIds(notice)).toEqual([AUTOMATION_ACTION.resume]);
		expect(JSON.stringify(notice.blocks)).toContain(
			JSON.stringify(buttonValue('a1', 'list')).slice(1, -1),
		);
	});
});

describe('button values', () => {
	test('round-trip, and reject anything else', () => {
		expect(parseButtonValue(buttonValue('a1', 'header'))).toEqual({ id: 'a1', surface: 'header' });
		expect(parseButtonValue('{"id":"a1","surface":"elsewhere"}')).toBeUndefined();
		expect(parseButtonValue('not json')).toBeUndefined();
	});
});
