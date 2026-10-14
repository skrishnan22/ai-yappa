import { Cron } from 'croner';
import cronstrue from 'cronstrue';
import { errorMessage } from '../json.ts';

// A recurring schedule is a five-field cron pattern; a one-off is one instant.
// Recurring patterns use an IANA timezone; stored instants are UTC ISO.
// croner only calculates times here; its timers are never used.
export type Schedule = { kind: 'recurring'; cron: string } | { kind: 'once'; runAt: string };

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

export function describeSchedule(schedule: Schedule, timezone: string): string {
	if (schedule.kind === 'once') return `Once, ${formatRunTime(schedule.runAt, timezone)}`;

	try {
		return `${cronstrue.toString(schedule.cron, { use24HourTimeFormat: true })} (${timezone})`;
	} catch {
		// Croner accepts extensions that cronstrue cannot describe, such as +weekday.
		return `Cron \`${schedule.cron}\` (${timezone})`;
	}
}

export function formatRunTime(iso: string, timezone: string): string {
	return new Intl.DateTimeFormat('en-IN', {
		timeZone: timezone,
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
		timeZoneName: 'short',
	}).format(new Date(iso));
}
