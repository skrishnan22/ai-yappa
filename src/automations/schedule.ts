import { Cron } from 'croner';
import { errorMessage } from '../json.ts';

// A recurring schedule is a five-field cron pattern; a one-off is one instant.
// Both are read in the automation's IANA timezone; stored instants are UTC ISO.
// croner only calculates times here; its timers are never used.
export type Schedule = { kind: 'recurring'; cron: string } | { kind: 'once'; runAt: string };

export type Preset =
	| { preset: 'daily' | 'weekdays'; hour: number; minute: number }
	| { preset: 'weekly'; hour: number; minute: number; days: number[] };

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const PRESET_PATTERN = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6](?:,[0-6])*)$/;

// en-US names US zones, en-IN names IST, en-GB names BST/CEST; elsewhere GMT+n.
const ZONE_LOCALES = ['en-US', 'en-IN', 'en-GB'];

type Parts = Partial<Record<Intl.DateTimeFormatPartTypes, string>>;

export function isValidTimezone(timezone: string): boolean {
	if (!timezone) return false;

	try {
		Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions();

		return true;
	} catch {
		return false;
	}
}

// Undefined when the schedule can run; otherwise what to tell the person.
export function scheduleError(schedule: Schedule, timezone: string, now: Date): string | undefined {
	if (!isValidTimezone(timezone)) {
		return `${timezone} is not a time zone. Use an IANA name such as Asia/Kolkata.`;
	}

	if (schedule.kind === 'once') {
		const at = Date.parse(schedule.runAt);

		if (Number.isNaN(at)) return `${schedule.runAt} is not a date and time.`;

		return at > now.getTime() ? undefined : 'That time has already passed.';
	}

	if (schedule.cron.trim().split(/\s+/).length !== 5) {
		return 'Use a five-field cron pattern: minute hour day-of-month month day-of-week.';
	}

	try {
		const next = new Cron(schedule.cron, { timezone }).nextRun(now);

		return next ? undefined : `${schedule.cron} never runs.`;
	} catch (error) {
		return `${schedule.cron} is not a cron pattern: ${errorMessage(error)}`;
	}
}

// The first run strictly after `after`; undefined when none remains.
export function nextRunAfter(
	schedule: Schedule,
	timezone: string,
	after: Date,
): string | undefined {
	if (schedule.kind === 'once') {
		return Date.parse(schedule.runAt) > after.getTime()
			? new Date(schedule.runAt).toISOString()
			: undefined;
	}

	return new Cron(schedule.cron, { timezone }).nextRun(after)?.toISOString();
}

export function upcomingRuns(
	schedule: Schedule,
	timezone: string,
	after: Date,
	count: number,
): string[] {
	if (schedule.kind === 'once') {
		const next = nextRunAfter(schedule, timezone, after);

		return next ? [next] : [];
	}

	return new Cron(schedule.cron, { timezone })
		.nextRuns(count, after)
		.map((run) => run.toISOString());
}

export function describeSchedule(schedule: Schedule, timezone: string, now: Date): string {
	if (schedule.kind === 'once') return `Once, ${formatRunTime(schedule.runAt, timezone)}`;

	const preset = presetOf(schedule.cron);

	if (!preset) return `Cron \`${schedule.cron}\` (${timezone})`;

	const at = `${pad(preset.hour)}:${pad(preset.minute)} ${zoneLabel(timezone, now)}`;

	switch (preset.preset) {
		case 'daily':
			return `Daily at ${at}`;
		case 'weekdays':
			return `Weekdays at ${at}`;
		case 'weekly':
			return `Weekly on ${preset.days.map((day) => DAY_NAMES[day]).join(', ')} at ${at}`;
		default: {
			const _exhaustive: never = preset;

			return _exhaustive;
		}
	}
}

// e.g. "Mon 19 Oct, 09:00 IST".
export function formatRunTime(iso: string, timezone: string): string {
	const at = new Date(iso);

	const parts = partsIn(at, timezone, {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	});

	return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute} ${zoneLabel(timezone, at)}`;
}

// The zone's short name at `at` (IST, EDT, BST), else its GMT offset.
export function zoneLabel(timezone: string, at: Date): string {
	const names = ZONE_LOCALES.map(
		(locale) =>
			new Intl.DateTimeFormat(locale, { timeZone: timezone, timeZoneName: 'short' })
				.formatToParts(at)
				.find((part) => part.type === 'timeZoneName')?.value ?? timezone,
	);

	return names.find((name) => !/^GMT[+-]/.test(name)) ?? names[0] ?? timezone;
}

// The modal's presets; anything else is a custom pattern.
export function presetOf(cron: string): Preset | undefined {
	const match = PRESET_PATTERN.exec(cron.trim());

	if (!match) return undefined;

	const minute = Number(match[1]);
	const hour = Number(match[2]);
	const days = match[3] ?? '';

	if (minute > 59 || hour > 23) return undefined;

	if (days === '*') return { preset: 'daily', hour, minute };

	if (days === '1-5') return { preset: 'weekdays', hour, minute };

	const list = [...new Set(days.split(',').map(Number))].toSorted((a, b) => a - b);

	return { preset: 'weekly', hour, minute, days: list };
}

export function presetCron(preset: Preset): string {
	return `${preset.minute} ${preset.hour} * * ${presetDays(preset)}`;
}

function presetDays(preset: Preset): string {
	switch (preset.preset) {
		case 'daily':
			return '*';
		case 'weekdays':
			return '1-5';
		case 'weekly':
			return preset.days.join(',');
		default: {
			const _exhaustive: never = preset;

			return _exhaustive;
		}
	}
}

// A local date (YYYY-MM-DD) and time (HH:MM) in `timezone` as a UTC instant.
// The second pass settles the offset when the first guess crosses a DST change.
export function zonedTimeToUtc(date: string, time: string, timezone: string): string {
	const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
	const [hour = 0, minute = 0] = time.split(':').map(Number);
	const wall = Date.UTC(year, month - 1, day, hour, minute);
	const first = wall - offsetMs(wall, timezone);

	return new Date(wall - offsetMs(first, timezone)).toISOString();
}

// A local date (YYYY-MM-DD) and time (HH:MM), as the modal's pickers use them.
export type WallTime = { date: string; time: string };

export function wallTimeIn(iso: string, timezone: string): WallTime {
	const parts = partsIn(new Date(iso), timezone, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	});

	return {
		date: `${parts.year}-${parts.month}-${parts.day}`,
		time: `${parts.hour}:${parts.minute}`,
	};
}

// How far `timezone`'s wall clock is ahead of UTC at `at`.
function offsetMs(at: number, timezone: string): number {
	const parts = partsIn(new Date(at), timezone, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
	});

	const asUtc = Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		Number(parts.hour),
		Number(parts.minute),
		Number(parts.second),
	);

	return asUtc - Math.floor(at / 1000) * 1000;
}

function partsIn(at: Date, timezone: string, options: Intl.DateTimeFormatOptions): Parts {
	const parts: Parts = {};
	const format = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, ...options });

	for (const part of format.formatToParts(at)) {
		parts[part.type] = part.value;
	}

	return parts;
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}
