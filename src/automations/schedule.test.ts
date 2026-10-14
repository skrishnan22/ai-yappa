import { describe, expect, test } from 'vitest';
import {
	describeSchedule,
	formatRunTime,
	nextRunAfter,
	scheduleError,
	upcomingRuns,
} from './schedule.ts';

const IST = 'Asia/Kolkata';

const NEW_YORK = 'America/New_York';

// Wednesday 14 Oct 2026, 08:30 IST.
const now = new Date('2026-10-14T03:00:00.000Z');

const weekdays = { kind: 'recurring', cron: '0 9 * * 1-5' } as const;

describe('nextRunAfter', () => {
	test('a weekday 09:00 IST schedule runs at 03:30 UTC on the next weekday', () => {
		expect(nextRunAfter(weekdays, IST, now)).toBe('2026-10-14T03:30:00.000Z');
		// Friday after 09:00 runs next on Monday.
		expect(nextRunAfter(weekdays, IST, new Date('2026-10-16T05:00:00.000Z'))).toBe(
			'2026-10-19T03:30:00.000Z',
		);
	});

	test('a run exactly at `after` is not the next run', () => {
		expect(
			nextRunAfter(
				{ kind: 'recurring', cron: '0 9 * * *' },
				IST,
				new Date('2026-10-14T03:30:00.000Z'),
			),
		).toBe('2026-10-15T03:30:00.000Z');
	});

	test('keeps local time across a DST change', () => {
		// US clocks go back on 1 Nov 2026: 09:00 EDT is 13:00Z, 09:00 EST is 14:00Z.
		expect(
			upcomingRuns(
				{ kind: 'recurring', cron: '0 9 * * *' },
				NEW_YORK,
				new Date('2026-10-31T12:00:00.000Z'),
				2,
			),
		).toEqual(['2026-10-31T13:00:00.000Z', '2026-11-01T14:00:00.000Z']);
	});

	test('a one-off runs once, then never', () => {
		const once = { kind: 'once', runAt: '2026-10-15T12:30:00.000Z' } as const;

		expect(nextRunAfter(once, IST, now)).toBe('2026-10-15T12:30:00.000Z');
		expect(nextRunAfter(once, IST, new Date('2026-10-15T12:30:00.000Z'))).toBeUndefined();
		expect(upcomingRuns(once, IST, now, 3)).toEqual(['2026-10-15T12:30:00.000Z']);
	});
});

describe('scheduleError', () => {
	test('accepts a five-field pattern and a future one-off', () => {
		expect(scheduleError(weekdays, IST, now)).toBeUndefined();
		expect(
			scheduleError({ kind: 'once', runAt: '2026-10-15T12:30:00.000Z' }, IST, now),
		).toBeUndefined();
	});

	test('refuses six-field patterns, bad values, past one-offs and unknown zones', () => {
		expect(scheduleError({ kind: 'recurring', cron: '0 0 9 * * 1' }, IST, now)).toMatch(
			/five-field/,
		);
		expect(scheduleError({ kind: 'recurring', cron: '61 9 * * *' }, IST, now)).toMatch(
			/not a cron pattern/,
		);
		expect(scheduleError({ kind: 'once', runAt: '2026-10-13T12:30:00.000Z' }, IST, now)).toMatch(
			/already passed/,
		);
		expect(scheduleError({ kind: 'once', runAt: 'tomorrow' }, IST, now)).toMatch(/not a date/);
		expect(scheduleError(weekdays, 'Mars/Olympus', now)).toMatch(/not a time zone/);
	});
});

describe('describeSchedule', () => {
	test('describes recurring patterns with their timezone', () => {
		expect(describeSchedule(weekdays, IST)).toBe('At 09:00, Monday through Friday (Asia/Kolkata)');
		expect(describeSchedule({ kind: 'recurring', cron: '*/15 9-17 * * 1-5' }, IST)).toBe(
			'Every 15 minutes, between 09:00 and 17:59, Monday through Friday (Asia/Kolkata)',
		);
	});

	test('shows valid Croner extensions as cron when the describer cannot interpret them', () => {
		const schedule = { kind: 'recurring', cron: '0 9 1 * +1' } as const;

		expect(scheduleError(schedule, IST, now)).toBeUndefined();
		expect(describeSchedule(schedule, IST)).toBe('Cron `0 9 1 * +1` (Asia/Kolkata)');
	});

	test('describes a one-off in its timezone', () => {
		expect(describeSchedule({ kind: 'once', runAt: '2026-10-15T12:30:00.000Z' }, IST)).toBe(
			'Once, Thu, 15 Oct, 18:00 IST',
		);
	});
});

test('formats a run time in the zone', () => {
	expect(formatRunTime('2026-10-19T03:30:00.000Z', IST)).toBe('Mon, 19 Oct, 09:00 IST');
});
