import { describe, expect, test } from 'vitest';
import {
	describeSchedule,
	formatRunTime,
	nextRunAfter,
	presetCron,
	presetOf,
	scheduleError,
	upcomingRuns,
	wallTimeIn,
	zonedTimeToUtc,
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
	test('names presets in words with the zone abbreviation', () => {
		expect(describeSchedule(weekdays, IST, now)).toBe('Weekdays at 09:00 IST');
		expect(describeSchedule({ kind: 'recurring', cron: '30 7 * * *' }, IST, now)).toBe(
			'Daily at 07:30 IST',
		);
		expect(describeSchedule({ kind: 'recurring', cron: '0 18 * * 4,1' }, NEW_YORK, now)).toBe(
			'Weekly on Mon, Thu at 18:00 EDT',
		);
	});

	test('shows a custom pattern as-is and a one-off as a time', () => {
		expect(describeSchedule({ kind: 'recurring', cron: '*/15 9-17 * * 1-5' }, IST, now)).toBe(
			'Cron `*/15 9-17 * * 1-5` (Asia/Kolkata)',
		);
		expect(describeSchedule({ kind: 'once', runAt: '2026-10-15T12:30:00.000Z' }, IST, now)).toBe(
			'Once, Thu 15 Oct, 18:00 IST',
		);
	});
});

describe('presets', () => {
	test('round-trip through cron', () => {
		for (const cron of ['0 9 * * *', '0 9 * * 1-5', '15 18 * * 1,4']) {
			const preset = presetOf(cron);

			expect(preset).toBeDefined();
			expect(preset && presetCron(preset)).toBe(cron);
		}
	});

	test('anything else is custom', () => {
		expect(presetOf('*/15 9-17 * * 1-5')).toBeUndefined();
		expect(presetOf('0 9 1 * *')).toBeUndefined();
		expect(presetOf('0 24 * * *')).toBeUndefined();
	});
});

describe('wall time', () => {
	test('converts a local date and time to UTC and back', () => {
		expect(zonedTimeToUtc('2026-10-15', '18:00', IST)).toBe('2026-10-15T12:30:00.000Z');
		expect(zonedTimeToUtc('2026-11-01', '09:00', NEW_YORK)).toBe('2026-11-01T14:00:00.000Z');
		expect(zonedTimeToUtc('2026-10-31', '09:00', NEW_YORK)).toBe('2026-10-31T13:00:00.000Z');
		expect(wallTimeIn('2026-10-15T12:30:00.000Z', IST)).toEqual({
			date: '2026-10-15',
			time: '18:00',
		});
	});

	test('formats a run time in the zone', () => {
		expect(formatRunTime('2026-10-19T03:30:00.000Z', IST)).toBe('Mon 19 Oct, 09:00 IST');
	});
});
