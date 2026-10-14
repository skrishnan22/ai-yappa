# Scheduled Automations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native; chosen 2026-10-14) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision 2026-10-14: no drafts, no confirmation.** The model creates the automation directly and replies with what it created; people fix it afterwards with Edit, Pause, Run now, and Delete. These deltas override the task text below. Each affected task is rewritten in place when its PR starts.
>
> - **PR #63 store correction:** scheduled ticks must use `runs.claimScheduled({ automationId, fireTime, nextRunAt, at })` and return when it is false. It atomically claims and advances only an active row whose next run still matches. The separate `automations.advance` API is removed; older claim/advance snippets below are superseded. `runs.claim` is only for Run now, which leaves the schedule unchanged.
> - **PR #63 outcome grouping:** `runs.recordOutcome` replaces `runs.finish`, `runs.settle`, `automations.recordSuccess`, and `automations.recordFailure`. Pass either `{ submissionId, status: succeeded|failed, reason?, at, pauseAt }` for a dispatched submission, or `{ automationId, fireTime, status: posted|failed, reason?, at, pauseAt }` for a claimed fire. It records the outcome and updates the failure counter in one transaction, returning the updated automation once (undefined for unrelated or repeated outcomes). Historical store/test snippets below are superseded by the current source; the outcome and scheduler examples use the grouped API.
> - **Task 1 simplification:** keep schedule validation, next-run calculations, cronstrue descriptions, and Intl run-time formatting. `describeSchedule(schedule, timezone)` no longer takes `now`. Remove `Preset`, `presetOf`, `presetCron`, `zoneLabel`, `WallTime`, `wallTimeIn`, and `zonedTimeToUtc`; they have no production callers. The modal design and its date/time handling will be settled in Task 10 rather than implemented speculatively here.
> - **Task 2:** no `automation_drafts` table, no `AutomationDraft`/`NewDraft` types, no `drafts` store methods or tests.
> - **Task 6:** `CardState` is just the created automation. `automationCard({ automation, now })` always shows the status line and Pause/Resume, Run now, Edit, and Delete.
> - **Task 7:** the tool is `create_automation`. It always creates, then posts the card. There is no `automationConfirmation` in `src/config.ts`. The gate is `mountsCreateAutomation`.
> - **Task 8:** drop Create and Cancel. This PR becomes interaction routing plus Task 9's Pause, Resume, Run now, and Delete.
> - **Task 10:** modal targets are only `automation` and `new`.
> - **Removed deviations:** 4 (promote batch) and 5 (draft columns). **Removed review focus:** "one-off passes before Create".

**Goal:** People create recurring or one-off work for Yappa from Slack (an agent run or a plain reminder). A heartbeat cron fires it into a fresh thread or a DM, and every state change goes through deterministic code.

**Architecture:** Automations, their runs, and drafts are D1 rows. A `* * * * *` Cron Trigger calls `runDueAutomations`. It claims each due row (the dedupe key is `automation_id, fire_time`), advances `next_run_at` with croner, re-authorizes the owner, and either posts a reminder or posts a header and dispatches a Coworker through the shared `startConversation`. The model can only call `draft_automation`, which writes a draft and posts a confirmation card. Create, Edit, Pause, Resume, Run now, and Delete are Slack interactions handled in code, with the authorization table checked on every click.

**Tech Stack:** TypeScript, Flue (`@flue/runtime`, `@flue/slack`), croner 10 (calculator only), valibot, `@slack/web-api`, Cloudflare D1 + Cron Triggers, Vitest with a real Miniflare D1.

**Spec:** `docs/superpowers/specs/2026-10-13-scheduled-automations-design.md`

## Global Constraints

- The model only proposes. Code sets the owner (from trusted delivery attributes), timezone (Slack `tz`), destination, and repo access (GitHub App installation). Code alone writes automation state.
- `automationConfirmation` in `src/config.ts` defaults to `true`.
- Times are stored as UTC ISO strings. Schedules are 5-field cron patterns or one `run_at` instant, evaluated in an IANA timezone.
- croner is used only for `nextRun`, `nextRuns`, and pattern validation. Never use its timers.
- Missed fires collapse to one run. No backlog replay, and paused periods are not replayed.
- No rate or concurrency guards in v1. The per-tick `LIMIT 50` is paging, not a guard; leftover rows are still due on the next tick.
- Interactions write D1 before responding. Redraws and dispatches run under `defer` (`waitUntil`), as in ADR 0023.
- External Slack Connect users are refused. Bots are ignored.
- Repo values are HTTPS clone URLs (`https://github.com/<owner>/<name>.git`).
- Destructure object parameters. Check optional values by truthiness (`AGENTS.md` Conventions).
- Every batch ends green: `pnpm test`, `pnpm run check:types`, `pnpm run lint`, `pnpm run fmt:check`.

## Deviations from the spec (decided while planning)

1. **`claimed` run status.** The claim inserts the run before its outcome is known, so `automation_runs.status` also allows `claimed`.
2. **The workspace team id comes from `auth.test`** (cached per isolate). The scheduler needs it to build the instance id, and interactions need it to refuse external users. One deployment serves one workspace (ADR 0001).
3. **Postability is checked by posting.** "The bot can still post there" is the header or reminder post itself: `not_in_channel`, `channel_not_found`, or `is_archived` blocks the automation. This needs no `channels:read` scope.
4. **Create is one D1 batch** (`drafts.promote`): insert the automation from the draft row, then consume the draft. The second click inserts nothing.
5. **`automation_drafts` gets `automation_id` and `updated_at`.** The card redraws in its created state from the draft.
6. **Resume resets `consecutive_failures`**, so a resumed automation gets three more tries.
7. **`draft_automation` counts as the thread reply** (like `ask_decision`), because it posts the card.
8. **A channel automation created from the modal posts its created card in the destination.** A channel the bot is not in fails at submit with an inline error instead of blocking at the first fire.

## Review Focus

- A one-off whose `run_at` passes before the drafter clicks Create is refused with "edit it" and nothing is created. Test in Task 8.
- `scope: 'channel'` drafted from a DM is refused with an explanation, not stored with a DM destination. Test in Task 7.
- The model sends `run_at` without an offset (`2026-10-15T18:00`). The tool refuses it instead of reading it as UTC. Test in Task 7.
- Resuming a paused one-off whose time has passed leaves it paused and says to edit it. Test in Task 9.
- Editing a `completed` one-off to a future time makes it `active` again with that `next_run_at`. Test in Task 10.

Known v1 limitation: if a fire's submission settles before the scheduler writes its `submission_id` (a dispatch-time failure within milliseconds), the outcome is not recorded and the run stays `dispatched`. The next fire is unaffected.

## PRs

Native execution. One small PR at a time from `main`; stop after each for the user's review and merge before starting the next.

1. **Schedule math** (Task 1): pure functions with croner. Nothing uses them yet.
2. **Automation tables and store** (Task 2): migration 0005 plus the D1 store. Nothing uses it yet.
3. **Extract `startConversation`** (Task 3): a refactor with no behavior change.
4. **Scheduler** (Task 4): firing, re-authorization, blocking, and failure counting. Not wired to the cron yet.
5. **Heartbeat** (Task 5): the cron, run start, and run outcomes. Live, but empty until PR 6.
6. **`create_automation`** (Tasks 6–7): validation, the card, the tool, and the Coworker wiring.
7. **Manage buttons** (Tasks 8–9): interaction routing plus Pause, Resume, Run now, and Delete.
8. **Edit modal** (Task 10): Edit plus `/aiyappa automations new`.
9. **List** (Task 11): `/aiyappa automations`.
10. **Docs and manifest** (Task 12).

## File map

| File | Responsibility |
| ---- | -------------- |
| `migrations/0005_automations.sql` | `automations`, `automation_runs`, `automation_drafts` |
| `src/automations/schedule.ts` | Pure schedule math and wording (croner + Intl) |
| `src/automations/automation.ts` | Domain types and the `AutomationStore` interface |
| `src/automations/d1-automation-store.ts` | D1 implementation |
| `src/automations/automation-store.ts` | Per-isolate store holder (like `planning-store.ts`) |
| `src/automations/fields.ts` | Field validation shared by the tool and the modal |
| `src/automations/blocks.ts` | Block Kit: run header/reminder, owner notice, card, list; action ids |
| `src/automations/slack-people.ts` | `ownerTimezone`, `openDirectMessage`, `isDirectMessageChannel` |
| `src/automations/outcome.ts` | Failure counting, pause at 3, owner DMs, settle recording |
| `src/automations/scheduler.ts` | `runDueAutomations`, `fireAutomation`, `runNow` |
| `src/automations/workspace.ts` | Cached `auth.test` team id |
| `src/automations/start-run.ts` | Builds the `startConversation` call for a fire |
| `src/automations/access.ts` | The authorization table |
| `src/automations/modal.ts` | Edit/new modal build and parse |
| `src/conversations/start.ts` | `startConversation`, `modelRouteForDispatch` |
| `src/channels/mrkdwn.ts` | `escapeMrkdwn`, `clip`, `sectionBlock`, `contextBlock` (moved from `card-blocks.ts`) |
| `src/channels/automation-interactions.ts` | Button and modal handlers |
| `src/agents/automation-tools.ts` | `draft_automation`, `deliverySender` |

---

## Batch 1: Schedules and storage

### Task 1: Schedule math and wording

**Files:**
- Modify: `package.json` (add `croner`)
- Create: `src/automations/schedule.ts`
- Test: `src/automations/schedule.test.ts`

**Interfaces:**
- Produces:
  - `type Schedule = { kind: 'recurring'; cron: string } | { kind: 'once'; runAt: string }`
  - `type Preset = { preset: 'daily' | 'weekdays'; hour: number; minute: number } | { preset: 'weekly'; hour: number; minute: number; days: number[] }`
  - `isValidTimezone(timezone: string): boolean`
  - `scheduleError(schedule: Schedule, timezone: string, now: Date): string | undefined`
  - `nextRunAfter(schedule: Schedule, timezone: string, after: Date): string | undefined` (strictly after `after`)
  - `upcomingRuns(schedule: Schedule, timezone: string, after: Date, count: number): string[]`
  - `describeSchedule(schedule: Schedule, timezone: string, now: Date): string`
  - `formatRunTime(iso: string, timezone: string): string` (e.g. `Mon 19 Oct, 09:00 IST`)
  - `zoneLabel(timezone: string, at: Date): string`
  - `presetOf(cron: string): Preset | undefined`, `presetCron(preset: Preset): string`
  - `zonedTimeToUtc(date: string, time: string, timezone: string): string` (`YYYY-MM-DD`, `HH:MM`)
  - `wallTimeIn(iso: string, timezone: string): { date: string; time: string }`

- [ ] **Step 1: Add croner**

Run: `pnpm add croner@^10.0.1`
Expected: `croner` appears under `dependencies` in `package.json`.

- [ ] **Step 2: Write the failing test**

```ts
// src/automations/schedule.test.ts
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
		expect(scheduleError({ kind: 'once', runAt: '2026-10-15T12:30:00.000Z' }, IST, now)).toBeUndefined();
	});

	test('refuses six-field patterns, bad values, past one-offs and unknown zones', () => {
		expect(scheduleError({ kind: 'recurring', cron: '0 0 9 * * 1' }, IST, now)).toMatch(/five-field/);
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
			expect(presetCron(preset!)).toBe(cron);
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
		expect(wallTimeIn('2026-10-15T12:30:00.000Z', IST)).toEqual({ date: '2026-10-15', time: '18:00' });
	});

	test('formats a run time in the zone', () => {
		expect(formatRunTime('2026-10-19T03:30:00.000Z', IST)).toBe('Mon 19 Oct, 09:00 IST');
	});
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run src/automations/schedule.test.ts`
Expected: FAIL, because `./schedule.ts` does not exist.

- [ ] **Step 4: Implement**

```ts
// src/automations/schedule.ts
import { Cron } from 'croner';
import { errorMessage } from '../json.ts';

// A recurring schedule is a five-field cron pattern; a one-off is one instant.
// Both are read in the automation's IANA timezone; stored instants are UTC ISO.
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
export function nextRunAfter(schedule: Schedule, timezone: string, after: Date): string | undefined {
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

export function zoneLabel(timezone: string, at: Date): string {
	const names = ZONE_LOCALES.map(
		(locale) =>
			new Intl.DateTimeFormat(locale, { timeZone: timezone, timeZoneName: 'short' })
				.formatToParts(at)
				.find((part) => part.type === 'timeZoneName')?.value ?? timezone,
	);

	return names.find((name) => !/^GMT[+-]/.test(name)) ?? names[0] ?? timezone;
}

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
	const days =
		preset.preset === 'daily' ? '*' : preset.preset === 'weekdays' ? '1-5' : preset.days.join(',');

	return `${preset.minute} ${preset.hour} * * ${days}`;
}

// A local date and time in `timezone` as a UTC instant. The second pass
// settles the offset when the first guess lands across a DST change.
export function zonedTimeToUtc(date: string, time: string, timezone: string): string {
	const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
	const [hour = 0, minute = 0] = time.split(':').map(Number);
	const wall = Date.UTC(year, month - 1, day, hour, minute);
	const first = wall - offsetMs(wall, timezone);

	return new Date(wall - offsetMs(first, timezone)).toISOString();
}

export function wallTimeIn(iso: string, timezone: string): { date: string; time: string } {
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

	for (const part of new Intl.DateTimeFormat('en-GB', { timeZone: timezone, ...options }).formatToParts(
		at,
	)) {
		parts[part.type] = part.value;
	}

	return parts;
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/automations/schedule.test.ts`
Expected: PASS. If the `EDT` assertion fails on this Node's ICU, print `zoneLabel('America/New_York', now)` and fix the locale order, not the test's intent (US zones read as EDT/EST).

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/automations/schedule.ts src/automations/schedule.test.ts
git commit -m "Add automation schedule math with croner"
```

### Task 2: Automation tables and store

**Files:**
- Create: `migrations/0005_automations.sql`
- Create: `src/automations/automation.ts`
- Create: `src/automations/d1-automation-store.ts`
- Create: `src/automations/automation-store.ts`
- Test: `src/automations/d1-automation-store.test.ts`

**Interfaces:**
- Consumes: `Schedule` (Task 1); `D1Database`, `D1Statement` from `src/memory/d1.ts`; `openTestDatabase()` from `src/testing/d1.ts`.
- Produces (all exported from `src/automations/automation.ts`):

```ts
export type AutomationKind = 'agent' | 'reminder';
export type AutomationScope = 'personal' | 'channel';
export type AutomationStatus = 'active' | 'paused' | 'blocked' | 'completed' | 'deleted';
export type RunStatus = 'claimed' | 'dispatched' | 'posted' | 'failed' | 'succeeded';
export type AutomationFields = { kind; title; prompt; scope; destinationChannelId; repo?; schedule: Schedule; timezone };
export type Automation = AutomationFields & { id; ownerUserId; status; nextRunAt?; lastScheduledAt?; consecutiveFailures; createdAt; updatedAt };
export type AutomationDraft = AutomationFields & { id; draftedBy; channelId; threadTs; cardTs?; automationId?; consumedAt?; createdAt; updatedAt };
export type NewDraft = AutomationFields & { id; draftedBy; channelId; threadTs; createdAt };
export type NewAutomation = AutomationFields & { id; ownerUserId; nextRunAt: string; createdAt };
export type AutomationRun = { automationId; fireTime; status: RunStatus; conversationId?; submissionId?; reason?; createdAt };
export type AutomationStore = { drafts; automations; runs }; // methods below
```

  `createD1AutomationStore(db: D1Database): AutomationStore`; `setAutomationStore(store | undefined)`, `automationStore(): AutomationStore | undefined`.

- [ ] **Step 1: Write the migration**

```sql
-- Scheduled automations (docs/superpowers/specs/2026-10-13-scheduled-automations-design.md).

CREATE TABLE automations (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'reminder')),
  owner_user_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'channel')),
  destination_channel_id TEXT NOT NULL,
  repo TEXT,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule TEXT, -- five-field cron; NULL for a one-off
  run_at TEXT, -- the one-off instant (UTC ISO); NULL for recurring
  timezone TEXT NOT NULL,
  next_run_at TEXT,
  last_scheduled_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'blocked', 'completed', 'deleted')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT automation_schedule CHECK ((schedule IS NULL) <> (run_at IS NULL))
);

-- The heartbeat reads `status = 'active' AND next_run_at <= now`.
CREATE INDEX automations_due ON automations (status, next_run_at);
CREATE INDEX automations_by_owner ON automations (owner_user_id);
CREATE INDEX automations_by_destination ON automations (destination_channel_id);

-- One row per fire. (automation_id, fire_time) is the dedupe key: a second
-- tick that read the same due row fails to claim it. Kept after deletion.
CREATE TABLE automation_runs (
  automation_id TEXT NOT NULL,
  fire_time TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'dispatched', 'posted', 'failed', 'succeeded')),
  conversation_id TEXT,
  submission_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (automation_id, fire_time)
);

CREATE INDEX automation_runs_by_submission ON automation_runs (submission_id);

-- A proposed automation. Slack button values cannot hold a long prompt, so
-- the card carries the draft id. Consumed exactly once, by Create or Cancel.
CREATE TABLE automation_drafts (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'reminder')),
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'channel')),
  destination_channel_id TEXT NOT NULL,
  repo TEXT,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule TEXT,
  run_at TEXT,
  timezone TEXT NOT NULL,
  drafted_by TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  card_ts TEXT,
  automation_id TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT draft_schedule CHECK ((schedule IS NULL) <> (run_at IS NULL))
);
```

- [ ] **Step 2: Write the domain types**

```ts
// src/automations/automation.ts
import type { Schedule } from './schedule.ts';

export type AutomationKind = 'agent' | 'reminder';

export type AutomationScope = 'personal' | 'channel';

export type AutomationStatus = 'active' | 'paused' | 'blocked' | 'completed' | 'deleted';

export type RunStatus = 'claimed' | 'dispatched' | 'posted' | 'failed' | 'succeeded';

// What a person chooses. Code fills the owner and checks every field.
export type AutomationFields = {
	kind: AutomationKind;
	title: string;
	prompt: string; // the instruction, or the reminder text
	scope: AutomationScope;
	destinationChannelId: string; // the owner's DM for personal scope
	repo?: string; // HTTPS clone URL; agent runs only
	schedule: Schedule;
	timezone: string; // IANA
};

export type Automation = AutomationFields & {
	id: string;
	ownerUserId: string;
	status: AutomationStatus;
	nextRunAt?: string;
	lastScheduledAt?: string;
	consecutiveFailures: number;
	createdAt: string;
	updatedAt: string;
};

export type AutomationDraft = AutomationFields & {
	id: string;
	draftedBy: string;
	channelId: string; // where the card is
	threadTs: string;
	cardTs?: string;
	automationId?: string; // set by Create
	consumedAt?: string; // set by Create or Cancel
	createdAt: string;
	updatedAt: string;
};

export type NewDraft = AutomationFields & {
	id: string;
	draftedBy: string;
	channelId: string;
	threadTs: string;
	createdAt: string;
};

export type NewAutomation = AutomationFields & {
	id: string;
	ownerUserId: string;
	nextRunAt: string;
	createdAt: string;
};

export type AutomationRun = {
	automationId: string;
	fireTime: string;
	status: RunStatus;
	conversationId?: string;
	submissionId?: string;
	reason?: string;
	createdAt: string;
};

export type AutomationStore = {
	drafts: {
		create(draft: NewDraft): Promise<AutomationDraft>;
		get(id: string): Promise<AutomationDraft | undefined>;
		setCardTs(args: { id: string; cardTs: string }): Promise<void>;
		// Only an unconsumed draft changes.
		update(args: {
			id: string;
			fields: AutomationFields;
			at: string;
		}): Promise<AutomationDraft | undefined>;
		// Cancel. True only for the call that consumed it.
		consume(args: { id: string; at: string }): Promise<boolean>;
		// Create: one batch inserts the automation from the draft and consumes
		// it. Undefined when the draft was already consumed.
		promote(args: {
			id: string;
			automationId: string;
			nextRunAt: string;
			at: string;
		}): Promise<Automation | undefined>;
	};
	automations: {
		create(automation: NewAutomation): Promise<Automation>;
		get(id: string): Promise<Automation | undefined>;
		due(args: { now: string; limit: number }): Promise<Automation[]>;
		// The user's personal automations and the channel's channel automations, not deleted.
		visibleTo(args: { userId: string; channelId: string }): Promise<Automation[]>;
		// Moves a claimed fire on: last_scheduled_at = from, next_run_at = nextRunAt, or
		// completed when there is none. Only while next_run_at is still `from`.
		advance(args: { id: string; from: string; nextRunAt?: string; at: string }): Promise<boolean>;
		update(args: {
			id: string;
			fields: AutomationFields;
			nextRunAt: string;
			status: AutomationStatus;
			at: string;
		}): Promise<Automation | undefined>;
		// Never changes a deleted automation. `active` resets the failure count.
		// next_run_at changes only when given.
		setStatus(args: {
			id: string;
			status: AutomationStatus;
			nextRunAt?: string;
			at: string;
		}): Promise<Automation | undefined>;
		recordSuccess(args: { id: string; at: string }): Promise<void>;
		// Increments the failure count; an active automation pauses at `pauseAt`.
		recordFailure(args: { id: string; at: string; pauseAt: number }): Promise<Automation | undefined>;
	};
	runs: {
		claim(args: { automationId: string; fireTime: string; createdAt: string }): Promise<boolean>;
		dispatched(args: {
			automationId: string;
			fireTime: string;
			conversationId: string;
			submissionId: string;
		}): Promise<void>;
		finish(args: {
			automationId: string;
			fireTime: string;
			status: 'posted' | 'failed';
			reason?: string;
		}): Promise<void>;
		// Settles a dispatched run by its submission; undefined for any other submission.
		settle(args: {
			submissionId: string;
			status: 'succeeded' | 'failed';
			reason?: string;
		}): Promise<AutomationRun | undefined>;
		list(automationId: string): Promise<AutomationRun[]>;
	};
};
```

- [ ] **Step 3: Write the failing store test**

```ts
// src/automations/d1-automation-store.test.ts
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
	return createD1AutomationStore(await openTestDatabase());
}

describe('drafts', () => {
	test('promote creates the automation once and consumes the draft', async () => {
		const s = await store();

		await s.drafts.create({ ...fields, id: 'd1', draftedBy: 'U_OWNER', channelId: 'C_ENG', threadTs: '1.0', createdAt: AT });

		const created = await s.drafts.promote({ id: 'd1', automationId: 'a1', nextRunAt: '2026-10-14T03:30:00.000Z', at: AT });

		expect(created).toMatchObject({ ...fields, id: 'a1', ownerUserId: 'U_OWNER', status: 'active', consecutiveFailures: 0 });
		expect(await s.drafts.promote({ id: 'd1', automationId: 'a2', nextRunAt: '2026-10-14T03:30:00.000Z', at: AT })).toBeUndefined();
		expect(await s.automations.get('a2')).toBeUndefined();
		expect(await s.drafts.get('d1')).toMatchObject({ automationId: 'a1', consumedAt: AT });
	});

	test('a consumed draft is not updated or consumed again', async () => {
		const s = await store();

		await s.drafts.create({ ...fields, id: 'd1', draftedBy: 'U_OWNER', channelId: 'C_ENG', threadTs: '1.0', createdAt: AT });

		expect(await s.drafts.update({ id: 'd1', fields: { ...fields, title: 'Renamed' }, at: AT })).toMatchObject({ title: 'Renamed' });
		expect(await s.drafts.consume({ id: 'd1', at: AT })).toBe(true);
		expect(await s.drafts.consume({ id: 'd1', at: AT })).toBe(false);
		expect(await s.drafts.update({ id: 'd1', fields, at: AT })).toBeUndefined();
	});

	test('a one-off keeps run_at and no cron', async () => {
		const s = await store();
		const once = { kind: 'once', runAt: '2026-10-15T12:30:00.000Z' } as const;

		await s.drafts.create({ ...fields, schedule: once, id: 'd1', draftedBy: 'U', channelId: 'C', threadTs: '1.0', createdAt: AT });

		expect((await s.drafts.get('d1'))?.schedule).toEqual(once);
	});
});

describe('automations', () => {
	test('due returns active rows at or before now, oldest first', async () => {
		const s = await store();

		await s.automations.create(newAutomation({ id: 'late', nextRunAt: '2026-10-14T02:00:00.000Z' }));
		await s.automations.create(newAutomation({ id: 'now', nextRunAt: AT }));
		await s.automations.create(newAutomation({ id: 'future', nextRunAt: '2026-10-14T04:00:00.000Z' }));
		await s.automations.create(newAutomation({ id: 'paused', nextRunAt: '2026-10-14T01:00:00.000Z' }));
		await s.automations.setStatus({ id: 'paused', status: 'paused', at: AT });

		const due = await s.automations.due({ now: AT, limit: 50 });

		expect(due.map((a) => a.id)).toEqual(['late', 'now']);
	});

	test('advance moves only from the expected next run, and completes a one-off', async () => {
		const s = await store();

		await s.automations.create(newAutomation());

		expect(await s.automations.advance({ id: 'a1', from: 'stale', nextRunAt: 'x', at: AT })).toBe(false);
		expect(await s.automations.advance({ id: 'a1', from: '2026-10-14T03:30:00.000Z', nextRunAt: '2026-10-15T03:30:00.000Z', at: AT })).toBe(true);
		expect(await s.automations.get('a1')).toMatchObject({ status: 'active', lastScheduledAt: '2026-10-14T03:30:00.000Z', nextRunAt: '2026-10-15T03:30:00.000Z' });

		await s.automations.advance({ id: 'a1', from: '2026-10-15T03:30:00.000Z', at: AT });

		const done = await s.automations.get('a1');

		expect(done?.status).toBe('completed');
		expect(done?.nextRunAt).toBeUndefined();
	});

	test('three failures pause an active automation; resuming resets the count', async () => {
		const s = await store();

		await s.automations.create(newAutomation());

		await s.automations.recordFailure({ id: 'a1', at: AT, pauseAt: 3 });
		await s.automations.recordFailure({ id: 'a1', at: AT, pauseAt: 3 });

		const third = await s.automations.recordFailure({ id: 'a1', at: AT, pauseAt: 3 });

		expect(third).toMatchObject({ status: 'paused', consecutiveFailures: 3 });
		expect(await s.automations.setStatus({ id: 'a1', status: 'active', at: AT })).toMatchObject({ status: 'active', consecutiveFailures: 0 });
	});

	test('a deleted automation does not change status or fields', async () => {
		const s = await store();

		await s.automations.create(newAutomation());
		await s.automations.setStatus({ id: 'a1', status: 'deleted', at: AT });

		expect(await s.automations.setStatus({ id: 'a1', status: 'active', at: AT })).toBeUndefined();
		expect(await s.automations.update({ id: 'a1', fields, nextRunAt: AT, status: 'active', at: AT })).toBeUndefined();
	});

	test("visibleTo shows the user's personal ones and this channel's channel ones", async () => {
		const s = await store();

		await s.automations.create(newAutomation({ id: 'mine', scope: 'personal', ownerUserId: 'U1', destinationChannelId: 'D1' }));
		await s.automations.create(newAutomation({ id: 'theirs', scope: 'personal', ownerUserId: 'U2', destinationChannelId: 'D2' }));
		await s.automations.create(newAutomation({ id: 'here', ownerUserId: 'U2', destinationChannelId: 'C_HERE' }));
		await s.automations.create(newAutomation({ id: 'elsewhere', ownerUserId: 'U1', destinationChannelId: 'C_OTHER' }));
		await s.automations.create(newAutomation({ id: 'gone', scope: 'personal', ownerUserId: 'U1', destinationChannelId: 'D1' }));
		await s.automations.setStatus({ id: 'gone', status: 'deleted', at: AT });

		const visible = await s.automations.visibleTo({ userId: 'U1', channelId: 'C_HERE' });

		expect(visible.map((a) => a.id).toSorted()).toEqual(['here', 'mine']);
	});
});

describe('runs', () => {
	test('a fire is claimed once', async () => {
		const s = await store();
		const claim = { automationId: 'a1', fireTime: AT, createdAt: AT };

		expect(await s.runs.claim(claim)).toBe(true);
		expect(await s.runs.claim(claim)).toBe(false);
	});

	test('settle matches only a dispatched run, once', async () => {
		const s = await store();

		await s.runs.claim({ automationId: 'a1', fireTime: AT, createdAt: AT });
		await s.runs.dispatched({ automationId: 'a1', fireTime: AT, conversationId: 'conv', submissionId: 'sub-1' });

		expect(await s.runs.settle({ submissionId: 'sub-other', status: 'succeeded' })).toBeUndefined();
		expect(await s.runs.settle({ submissionId: 'sub-1', status: 'failed', reason: 'boom' })).toMatchObject({ automationId: 'a1', status: 'failed', reason: 'boom' });
		expect(await s.runs.settle({ submissionId: 'sub-1', status: 'succeeded' })).toBeUndefined();
	});
});
```

(Run `pnpm run fmt` after writing. The long lines above are reformatted, not rewritten.)

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm vitest run src/automations/d1-automation-store.test.ts`
Expected: FAIL, because `./d1-automation-store.ts` does not exist.

- [ ] **Step 5: Implement the store and the holder**

```ts
// src/automations/d1-automation-store.ts
import * as v from 'valibot';
import type { JsonObject } from '../json.ts';
import type { D1Database, D1Value } from '../memory/d1.ts';
import type {
	Automation,
	AutomationDraft,
	AutomationFields,
	AutomationRun,
	AutomationStore,
} from './automation.ts';

const fieldColumns = {
	kind: v.picklist(['agent', 'reminder']),
	scope: v.picklist(['personal', 'channel']),
	destination_channel_id: v.string(),
	repo: v.nullable(v.string()),
	title: v.string(),
	prompt: v.string(),
	schedule: v.nullable(v.string()),
	run_at: v.nullable(v.string()),
	timezone: v.string(),
};

const automationRowSchema = v.object({
	...fieldColumns,
	id: v.string(),
	owner_user_id: v.string(),
	next_run_at: v.nullable(v.string()),
	last_scheduled_at: v.nullable(v.string()),
	status: v.picklist(['active', 'paused', 'blocked', 'completed', 'deleted']),
	consecutive_failures: v.number(),
	created_at: v.string(),
	updated_at: v.string(),
});

const draftRowSchema = v.object({
	...fieldColumns,
	id: v.string(),
	drafted_by: v.string(),
	channel_id: v.string(),
	thread_ts: v.string(),
	card_ts: v.nullable(v.string()),
	automation_id: v.nullable(v.string()),
	consumed_at: v.nullable(v.string()),
	created_at: v.string(),
	updated_at: v.string(),
});

const runRowSchema = v.object({
	automation_id: v.string(),
	fire_time: v.string(),
	status: v.picklist(['claimed', 'dispatched', 'posted', 'failed', 'succeeded']),
	conversation_id: v.nullable(v.string()),
	submission_id: v.nullable(v.string()),
	reason: v.nullable(v.string()),
	created_at: v.string(),
});

// The nine field columns, in this order, are ?2..?10 in every statement below.
const FIELDS = 'kind, scope, destination_channel_id, repo, title, prompt, schedule, run_at, timezone';

const SET_FIELDS =
	'kind = ?2, scope = ?3, destination_channel_id = ?4, repo = ?5, title = ?6, prompt = ?7, schedule = ?8, run_at = ?9, timezone = ?10';

const SQL = {
	insertDraft: `INSERT INTO automation_drafts (id, ${FIELDS}, drafted_by, channel_id, thread_ts, created_at, updated_at)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14) RETURNING *`,
	draft: 'SELECT * FROM automation_drafts WHERE id = ?1',
	setCardTs: 'UPDATE automation_drafts SET card_ts = ?2 WHERE id = ?1',
	updateDraft: `UPDATE automation_drafts SET ${SET_FIELDS}, updated_at = ?11
		WHERE id = ?1 AND consumed_at IS NULL RETURNING *`,
	consumeDraft:
		'UPDATE automation_drafts SET consumed_at = ?2, updated_at = ?2 WHERE id = ?1 AND consumed_at IS NULL',
	promoteInsert: `INSERT INTO automations (id, owner_user_id, ${FIELDS}, next_run_at, status, created_at, updated_at)
		SELECT ?2, drafted_by, ${FIELDS}, ?3, 'active', ?4, ?4
		FROM automation_drafts WHERE id = ?1 AND consumed_at IS NULL`,
	promoteConsume: `UPDATE automation_drafts SET consumed_at = ?3, automation_id = ?2, updated_at = ?3
		WHERE id = ?1 AND consumed_at IS NULL`,
	insertAutomation: `INSERT INTO automations (id, ${FIELDS}, owner_user_id, next_run_at, status, created_at, updated_at)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'active', ?13, ?13) RETURNING *`,
	automation: 'SELECT * FROM automations WHERE id = ?1',
	due: `SELECT * FROM automations WHERE status = 'active' AND next_run_at <= ?1
		ORDER BY next_run_at LIMIT ?2`,
	visible: `SELECT * FROM automations WHERE status <> 'deleted'
		AND ((scope = 'personal' AND owner_user_id = ?1) OR (scope = 'channel' AND destination_channel_id = ?2))
		ORDER BY created_at, id`,
	advance: `UPDATE automations SET last_scheduled_at = ?2, next_run_at = ?3,
		status = CASE WHEN ?3 IS NULL THEN 'completed' ELSE status END, updated_at = ?4
		WHERE id = ?1 AND next_run_at = ?2`,
	update: `UPDATE automations SET ${SET_FIELDS}, next_run_at = ?11, status = ?12, updated_at = ?13
		WHERE id = ?1 AND status <> 'deleted' RETURNING *`,
	setStatus: `UPDATE automations SET status = ?2, next_run_at = COALESCE(?3, next_run_at),
		consecutive_failures = CASE WHEN ?2 = 'active' THEN 0 ELSE consecutive_failures END, updated_at = ?4
		WHERE id = ?1 AND status <> 'deleted' RETURNING *`,
	recordSuccess: 'UPDATE automations SET consecutive_failures = 0, updated_at = ?2 WHERE id = ?1',
	// SET expressions read the row as it was, so both use the old count.
	recordFailure: `UPDATE automations SET consecutive_failures = consecutive_failures + 1,
		status = CASE WHEN status = 'active' AND consecutive_failures + 1 >= ?3 THEN 'paused' ELSE status END,
		updated_at = ?2
		WHERE id = ?1 RETURNING *`,
	claim: `INSERT INTO automation_runs (automation_id, fire_time, status, created_at)
		VALUES (?1, ?2, 'claimed', ?3) ON CONFLICT DO NOTHING`,
	dispatched: `UPDATE automation_runs SET status = 'dispatched', conversation_id = ?3, submission_id = ?4
		WHERE automation_id = ?1 AND fire_time = ?2`,
	finish: 'UPDATE automation_runs SET status = ?3, reason = ?4 WHERE automation_id = ?1 AND fire_time = ?2',
	settle: `UPDATE automation_runs SET status = ?2, reason = ?3
		WHERE submission_id = ?1 AND status = 'dispatched' RETURNING *`,
	runs: 'SELECT * FROM automation_runs WHERE automation_id = ?1 ORDER BY fire_time',
} as const;

function fieldValues(fields: AutomationFields): D1Value[] {
	return [
		fields.kind,
		fields.scope,
		fields.destinationChannelId,
		fields.repo ?? null,
		fields.title,
		fields.prompt,
		fields.schedule.kind === 'recurring' ? fields.schedule.cron : null,
		fields.schedule.kind === 'once' ? fields.schedule.runAt : null,
		fields.timezone,
	];
}

function readFields(row: v.InferOutput<typeof automationRowSchema> | v.InferOutput<typeof draftRowSchema>): AutomationFields {
	return {
		kind: row.kind,
		title: row.title,
		prompt: row.prompt,
		scope: row.scope,
		destinationChannelId: row.destination_channel_id,
		repo: row.repo ?? undefined,
		schedule: row.schedule
			? { kind: 'recurring', cron: row.schedule }
			: { kind: 'once', runAt: row.run_at ?? '' },
		timezone: row.timezone,
	};
}

function readAutomation(raw: JsonObject): Automation {
	const row = v.parse(automationRowSchema, raw);

	return {
		...readFields(row),
		id: row.id,
		ownerUserId: row.owner_user_id,
		status: row.status,
		nextRunAt: row.next_run_at ?? undefined,
		lastScheduledAt: row.last_scheduled_at ?? undefined,
		consecutiveFailures: row.consecutive_failures,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function readDraft(raw: JsonObject): AutomationDraft {
	const row = v.parse(draftRowSchema, raw);

	return {
		...readFields(row),
		id: row.id,
		draftedBy: row.drafted_by,
		channelId: row.channel_id,
		threadTs: row.thread_ts,
		cardTs: row.card_ts ?? undefined,
		automationId: row.automation_id ?? undefined,
		consumedAt: row.consumed_at ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function readRun(raw: JsonObject): AutomationRun {
	const row = v.parse(runRowSchema, raw);

	return {
		automationId: row.automation_id,
		fireTime: row.fire_time,
		status: row.status,
		conversationId: row.conversation_id ?? undefined,
		submissionId: row.submission_id ?? undefined,
		reason: row.reason ?? undefined,
		createdAt: row.created_at,
	};
}

export function createD1AutomationStore(db: D1Database): AutomationStore {
	async function first<T>(sql: string, values: D1Value[], read: (raw: JsonObject) => T): Promise<T | undefined> {
		const { results } = await db.prepare(sql).bind(...values).all();
		const [row] = results;

		return row ? read(row) : undefined;
	}

	async function changed(sql: string, values: D1Value[]): Promise<boolean> {
		const { meta } = await db.prepare(sql).bind(...values).run();

		return meta.changes === 1;
	}

	async function getAutomation(id: string) {
		return first(SQL.automation, [id], readAutomation);
	}

	return {
		drafts: {
			async create(draft) {
				const created = await first(
					SQL.insertDraft,
					[draft.id, ...fieldValues(draft), draft.draftedBy, draft.channelId, draft.threadTs, draft.createdAt],
					readDraft,
				);

				if (!created) throw new Error(`Draft ${draft.id} was not saved.`);

				return created;
			},
			get: (id) => first(SQL.draft, [id], readDraft),
			async setCardTs({ id, cardTs }) {
				await db.prepare(SQL.setCardTs).bind(id, cardTs).run();
			},
			update: ({ id, fields, at }) => first(SQL.updateDraft, [id, ...fieldValues(fields), at], readDraft),
			consume: ({ id, at }) => changed(SQL.consumeDraft, [id, at]),
			async promote({ id, automationId, nextRunAt, at }) {
				// D1 runs a batch as one transaction.
				const [inserted] = await db.batch([
					db.prepare(SQL.promoteInsert).bind(id, automationId, nextRunAt, at),
					db.prepare(SQL.promoteConsume).bind(id, automationId, at),
				]);

				return inserted?.meta.changes === 1 ? getAutomation(automationId) : undefined;
			},
		},
		automations: {
			async create(automation) {
				const created = await first(
					SQL.insertAutomation,
					[
						automation.id,
						...fieldValues(automation),
						automation.ownerUserId,
						automation.nextRunAt,
						automation.createdAt,
					],
					readAutomation,
				);

				if (!created) throw new Error(`Automation ${automation.id} was not saved.`);

				return created;
			},
			get: getAutomation,
			async due({ now, limit }) {
				const { results } = await db.prepare(SQL.due).bind(now, limit).all();

				return results.map(readAutomation);
			},
			async visibleTo({ userId, channelId }) {
				const { results } = await db.prepare(SQL.visible).bind(userId, channelId).all();

				return results.map(readAutomation);
			},
			advance: ({ id, from, nextRunAt, at }) => changed(SQL.advance, [id, from, nextRunAt ?? null, at]),
			update: ({ id, fields, nextRunAt, status, at }) =>
				first(SQL.update, [id, ...fieldValues(fields), nextRunAt, status, at], readAutomation),
			setStatus: ({ id, status, nextRunAt, at }) =>
				first(SQL.setStatus, [id, status, nextRunAt ?? null, at], readAutomation),
			async recordSuccess({ id, at }) {
				await db.prepare(SQL.recordSuccess).bind(id, at).run();
			},
			recordFailure: ({ id, at, pauseAt }) => first(SQL.recordFailure, [id, at, pauseAt], readAutomation),
		},
		runs: {
			claim: ({ automationId, fireTime, createdAt }) =>
				changed(SQL.claim, [automationId, fireTime, createdAt]),
			async dispatched({ automationId, fireTime, conversationId, submissionId }) {
				await db.prepare(SQL.dispatched).bind(automationId, fireTime, conversationId, submissionId).run();
			},
			async finish({ automationId, fireTime, status, reason }) {
				await db.prepare(SQL.finish).bind(automationId, fireTime, status, reason ?? null).run();
			},
			settle: ({ submissionId, status, reason }) =>
				first(SQL.settle, [submissionId, status, reason ?? null], readRun),
			async list(automationId) {
				const { results } = await db.prepare(SQL.runs).bind(automationId).all();

				return results.map(readRun);
			},
		},
	};
}
```

```ts
// src/automations/automation-store.ts
import type { AutomationStore } from './automation.ts';

// Set once per isolate by the Worker entry (`src/cloudflare.ts`). Unset under
// `flue run`, which has no D1, so the Coworker mounts no automation tools there.
let current: AutomationStore | undefined;

export function setAutomationStore(store: AutomationStore | undefined): void {
	current = store;
}

export function automationStore(): AutomationStore | undefined {
	return current;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run src/automations/d1-automation-store.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify the batch and commit**

Run: `pnpm test && pnpm run check:types && pnpm run lint && pnpm run fmt:check`
Expected: all pass. (Run `pnpm run fmt` first if fmt:check fails on line length.)

```bash
git add migrations/0005_automations.sql src/automations/
git commit -m "Store automations, runs and drafts in D1"
```

**Stop: Batch 1 review.**

---

## Batch 2: Firing

### Task 3: Extract `startConversation`

**Files:**
- Create: `src/conversations/start.ts`
- Modify: `src/channels/slack.ts` (move `modelRouteForDispatch`; replace the inline `runtime.dispatch(Coworker, …)` in `admitThread`; `SlackRuntime` builds on `ConversationRuntime`)
- Modify: `src/agents/coworker.ts:66-73` (`initialDataSchema` gains `automationId`)
- Test: `src/conversations/start.test.ts`

**Interfaces:**
- Produces:

```ts
export type ConversationRuntime = { dispatch: typeof dispatch };
export type ConversationStart = {
	id: string; // channel.instanceId(thread)
	thread: { channelId: string; threadTs: string };
	startedBy?: string;
	repo?: string;
	modelChoice?: ModelChoice;
	automationId?: string;
	idempotencyKey: string;
	message: { type: string; body: string; attributes: Record<string, string> };
};
export function startConversation(args: { runtime: ConversationRuntime; start: ConversationStart; now: Date }): ReturnType<typeof dispatch>;
export function modelRouteForDispatch(codexAuth: () => CodexAuthControl): Promise<ModelRoute>;
```

- [ ] **Step 1: Write the failing test**

```ts
// src/conversations/start.test.ts
import { describe, expect, test } from 'vitest';
import { Coworker } from '../agents/coworker.ts';
import { startConversation, type ConversationRuntime } from './start.ts';

describe('startConversation', () => {
	test('dispatches the Coworker with initialData and the signal', async () => {
		const requests: unknown[] = [];

		const runtime: ConversationRuntime = {
			dispatch: async (agent, request) => {
				expect(agent).toBe(Coworker);
				requests.push(request);

				return { submissionId: 'sub-1', uid: 'uid-1', deduplicated: false };
			},
		};

		const receipt = await startConversation({
			runtime,
			now: new Date('2026-10-14T03:30:00.000Z'),
			start: {
				id: 'slack:v1:T1:C1:2.0',
				thread: { channelId: 'C1', threadTs: '2.0' },
				startedBy: 'U_OWNER',
				repo: 'https://github.com/acme/api.git',
				automationId: 'a1',
				idempotencyKey: 'automation:a1:2026-10-14T03:30:00.000Z',
				message: { type: 'automation.fire', body: 'Do it', attributes: { automationId: 'a1' } },
			},
		});

		expect(receipt.submissionId).toBe('sub-1');
		expect(requests).toEqual([
			{
				id: 'slack:v1:T1:C1:2.0',
				idempotencyKey: 'automation:a1:2026-10-14T03:30:00.000Z',
				initialData: {
					channelId: 'C1',
					threadTs: '2.0',
					startedBy: 'U_OWNER',
					startedAt: '2026-10-14T03:30:00.000Z',
					repo: 'https://github.com/acme/api.git',
					modelChoice: undefined,
					automationId: 'a1',
				},
				message: { kind: 'signal', type: 'automation.fire', body: 'Do it', attributes: { automationId: 'a1' } },
			},
		]);
	});
});
```

If the fake's return type does not satisfy `typeof dispatch`, copy the receipt shape that `recordingRuntime()` in `src/channels/slack.test.ts` returns.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/conversations/start.test.ts`
Expected: FAIL, because `./start.ts` does not exist.

- [ ] **Step 3: Implement**

```ts
// src/conversations/start.ts
import type { dispatch } from '@flue/runtime';
import { Coworker } from '../agents/coworker.ts';
import type { ModelChoice } from '../agents/model-choice.ts';
import { type ModelRoute, modelRouteFor } from '../agents/model-route.ts';
import type { CodexAuthControl } from '../integrations/codex-auth/codex-auth.ts';
import { errorMessage } from '../json.ts';

export type ConversationRuntime = { dispatch: typeof dispatch };

export type ConversationStart = {
	id: string;
	thread: { channelId: string; threadTs: string };
	startedBy?: string;
	repo?: string;
	modelChoice?: ModelChoice;
	automationId?: string;
	idempotencyKey: string;
	message: { type: string; body: string; attributes: Record<string, string> };
};

// Slack mentions, DMs and automation fires all start a Coworker here. Flue
// records initialData only when the dispatch creates the conversation.
export function startConversation({
	runtime,
	start,
	now,
}: {
	runtime: ConversationRuntime;
	start: ConversationStart;
	now: Date;
}): ReturnType<typeof dispatch> {
	return runtime.dispatch(Coworker, {
		id: start.id,
		idempotencyKey: start.idempotencyKey,
		initialData: {
			channelId: start.thread.channelId,
			threadTs: start.thread.threadTs,
			startedBy: start.startedBy,
			startedAt: now.toISOString(),
			repo: start.repo,
			modelChoice: start.modelChoice,
			automationId: start.automationId,
		},
		message: { kind: 'signal', ...start.message },
	});
}

// Falls back to OpenCode Go when `CodexAuth` cannot answer, so a broken
// ChatGPT connection never blocks Slack or a scheduled run.
export async function modelRouteForDispatch(codexAuth: () => CodexAuthControl): Promise<ModelRoute> {
	try {
		const status = await codexAuth().status();

		return modelRouteFor(status);
	} catch (error) {
		console.warn(`[dispatch] CodexAuth status failed; routing to OpenCode Go: ${errorMessage(error)}`);

		return 'opencode-go';
	}
}
```

In `src/agents/coworker.ts`, add to `initialDataSchema`:

```ts
	// Set when an automation fire started this conversation.
	automationId: v.optional(v.string()),
```

In `src/channels/slack.ts`:
- delete the local `modelRouteForDispatch` and import it from `../conversations/start.ts`;
- `export type SlackRuntime = ConversationRuntime & { getAgentInstance: typeof getAgentInstance };`
- in `admitThread`'s `'dispatch'` case, replace the `runtime.dispatch(Coworker, { … })` call with:

```ts
				const receipt = await startConversation({
					runtime,
					now: new Date(),
					start: {
						id,
						thread,
						startedBy: userId,
						repo: decision.repo,
						modelChoice: invocation.modelChoice,
						idempotencyKey: eventId,
						message: { type: signalType, body: invocation.body, attributes },
					},
				});
```

`attributes` is `SignalAttributes & { modelRoute }`. If TypeScript rejects it as `Record<string, string>` (optional keys), change `ConversationStart.message.attributes` to `Readonly<Record<string, string | undefined>>`. Do not cast at the call site.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/conversations src/channels/slack.test.ts`
Expected: PASS. The existing Slack dispatch assertions are unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/conversations src/channels/slack.ts src/agents/coworker.ts
git commit -m "Extract startConversation from Slack admission"
```

### Task 4: Scheduler, run messages and failure handling

**Files:**
- Create: `src/channels/mrkdwn.ts` (move `escapeMrkdwn`, `clip`, `sectionBlock`, `contextBlock` out of `src/planning/card-blocks.ts`, export them, and import them back there)
- Modify: `src/channels/slack-reply.ts` (`SlackBotClient` gains `auth.test`, `users.info`, `conversations.open`)
- Create: `src/automations/blocks.ts`
- Create: `src/automations/slack-people.ts`
- Create: `src/automations/outcome.ts`
- Create: `src/automations/scheduler.ts`
- Test: `src/automations/scheduler.test.ts`, `src/automations/outcome.test.ts`

**Interfaces:**
- Consumes: `AutomationStore`, `Automation` (Task 2); `nextRunAfter` (Task 1).
- Produces:
  - `blocks.ts`: `AUTOMATION_ACTION` (`create`, `editDraft`, `cancel`, `pause`, `resume`, `runNow`, `edit`, `delete`), `AUTOMATION_MODAL = 'automation_modal'`, `type Surface = 'header' | 'card' | 'list'`, `buttonValue(id: string, surface: Surface): string`, `parseButtonValue(value: string): { id: string; surface: Surface } | undefined`, `type Rendered = { text: string; blocks: KnownBlock[] }`, `runMessage(automation: Automation): Rendered`, `ownerNotice({ automation, message }): Rendered`, `manageButtons({ automation, surface, extras }): Button[]` (exported for Tasks 6 and 11)
  - `slack-people.ts`: `openDirectMessage({ slack, userId }): Promise<string>`
  - `outcome.ts`: `PAUSE_AFTER_FAILURES = 3`, `notifyOwner({ slack, automation, message })`, `notifyPaused({ slack, automation })`, `recordRunSettled({ store, slack, submissionId, outcome, error, at })`
  - `scheduler.ts`: `type StartRun = (args: { automation: Automation; threadTs: string; fireTime: string }) => Promise<{ conversationId: string; submissionId: string }>`, `type SchedulerDeps = { store; slack; startRun; now(): Date }`, `runDueAutomations(deps)`, `fireAutomation({ automation, fireTime, deps })`, `runNow({ automation, deps }): Promise<boolean>`, `ownerGoneReason({ slack, userId }): Promise<string | undefined>`, `slackErrorCode(error: unknown): string | undefined`

- [ ] **Step 1: Move the mrkdwn helpers**

Create `src/channels/mrkdwn.ts` containing exactly the `escapeMrkdwn`, `sectionBlock`, `contextBlock`, and `clip` functions from the bottom of `src/planning/card-blocks.ts`, each `export`ed, with their comments. Delete them from `card-blocks.ts` and add `import { clip, contextBlock, escapeMrkdwn, sectionBlock } from '../channels/mrkdwn.ts';`.

Run: `pnpm vitest run src/planning`
Expected: PASS, with no behavior change.

- [ ] **Step 2: Widen `SlackBotClient`**

In `src/channels/slack-reply.ts`:

```ts
export type SlackBotClient = {
	auth: { test: WebClient['auth']['test'] };
	chat: {
		postMessage: WebClient['chat']['postMessage'];
		update: WebClient['chat']['update'];
		postEphemeral: WebClient['chat']['postEphemeral'];
	};
	views: {
		open: WebClient['views']['open'];
	};
	conversations: {
		replies: WebClient['conversations']['replies'];
		open: WebClient['conversations']['open'];
	};
	users: { info: WebClient['users']['info'] };
};
```

Run: `pnpm run check:types`
Expected: PASS. Every value is a real `WebClient`.

- [ ] **Step 3: Write the failing scheduler tests**

```ts
// src/automations/scheduler.test.ts
import { afterEach, describe, expect, test, vi } from 'vitest';
import { __resetSlackClientForTests, getSlackClient } from '../channels/slack-reply.ts';
import { type SlackApiCall, stubSlackApi } from '../channels/testing/slack-api-stub.ts';
import { openTestDatabase } from '../testing/d1.ts';
import type { AutomationStore, NewAutomation } from './automation.ts';
import { createD1AutomationStore } from './d1-automation-store.ts';
import { runDueAutomations, runNow, type SchedulerDeps, type StartRun } from './scheduler.ts';

const NOW = new Date('2026-10-14T03:30:20.000Z'); // a tick just after 09:00 IST

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

type Slack = { deleted?: boolean; postError?: string };

async function setup(slackState: Slack = {}) {
	const store: AutomationStore = createD1AutomationStore(await openTestDatabase());

	const calls = stubSlackApi(async (call: SlackApiCall) => {
		switch (call.method) {
			case 'users.info':
				return { ok: true, user: { id: 'U_OWNER', deleted: slackState.deleted ?? false } };
			case 'conversations.open':
				return { ok: true, channel: { id: 'D_OWNER' } };
			case 'chat.postMessage':
				if (slackState.postError && call.params.channel === 'C_ENG') {
					return { ok: false, error: slackState.postError };
				}

				return { ok: true, ts: '100.1' };
			default:
				return { ok: true };
		}
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

		expect(header?.params.channel).toBe('C_ENG');
		expect(String(header?.params.text)).toContain('Merged PRs');
		expect(started).toEqual([
			{ automation: expect.objectContaining({ id: 'a1' }), threadTs: '100.1', fireTime: '2026-10-14T03:30:00.000Z' },
		]);
		expect(await store.automations.get('a1')).toMatchObject({
			lastScheduledAt: '2026-10-14T03:30:00.000Z',
			nextRunAt: '2026-10-15T03:30:00.000Z',
		});
		expect(await store.runs.list('a1')).toMatchObject([{ status: 'dispatched', conversationId: 'conv-1', submissionId: 'sub-1' }]);
	});

	test('two ticks over the same due row fire once', async () => {
		const { store, started, deps } = await setup();

		await store.automations.create(automation());
		await Promise.all([runDueAutomations(deps), runDueAutomations(deps)]);

		expect(started).toHaveLength(1);
	});

	test('several missed fires produce one run and no backlog', async () => {
		const { store, started, deps } = await setup();

		// Last due three weekdays ago.
		await store.automations.create(automation({ nextRunAt: '2026-10-09T03:30:00.000Z' }));
		await runDueAutomations(deps);
		await runDueAutomations(deps);

		expect(started).toHaveLength(1);
		expect((await store.automations.get('a1'))?.nextRunAt).toBe('2026-10-15T03:30:00.000Z');
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

		expect(post?.params.channel).toBe('D_OWNER');
		expect(String(post?.params.text)).toContain('<@U_OWNER>');
		expect(String(post?.params.text)).toContain('Book tickets');
		expect(started).toEqual([]);
		expect((await store.automations.get('a1'))?.status).toBe('completed');
		expect(await store.runs.list('a1')).toMatchObject([{ status: 'posted' }]);
	});

	test('a deactivated owner blocks the automation and gets a DM', async () => {
		const { store, calls, started, deps } = await setup({ deleted: true });

		await store.automations.create(automation());
		await runDueAutomations(deps);

		expect(started).toEqual([]);
		expect((await store.automations.get('a1'))?.status).toBe('blocked');
		expect(await store.runs.list('a1')).toMatchObject([{ status: 'failed' }]);
		expect(calls.some((call) => call.method === 'chat.postMessage' && call.params.channel === 'D_OWNER')).toBe(true);
	});

	test('a channel the bot left blocks the automation', async () => {
		const { store, deps } = await setup({ postError: 'not_in_channel' });

		await store.automations.create(automation());
		await runDueAutomations(deps);

		expect((await store.automations.get('a1'))?.status).toBe('blocked');
	});

	test('a dispatch failure counts toward the pause', async () => {
		const { store, deps } = await setup();

		await store.automations.create(automation());
		await runDueAutomations({ ...deps, startRun: async () => { throw new Error('queue down'); } });

		expect(await store.automations.get('a1')).toMatchObject({ status: 'active', consecutiveFailures: 1 });
		expect(await store.runs.list('a1')).toMatchObject([{ status: 'failed', reason: 'queue down' }]);
	});
});

describe('runNow', () => {
	test('fires at now without moving the schedule', async () => {
		const { store, started, deps } = await setup();

		const created = await store.automations.create(automation({ nextRunAt: '2026-10-15T03:30:00.000Z' }));

		expect(await runNow({ automation: created, deps })).toBe(true);
		expect(started[0]?.fireTime).toBe(NOW.toISOString());
		expect((await store.automations.get('a1'))?.nextRunAt).toBe('2026-10-15T03:30:00.000Z');
	});
});
```

```ts
// src/automations/outcome.test.ts
import { afterEach, describe, expect, test, vi } from 'vitest';
import { __resetSlackClientForTests, getSlackClient } from '../channels/slack-reply.ts';
import { stubSlackApi } from '../channels/testing/slack-api-stub.ts';
import { openTestDatabase } from '../testing/d1.ts';
import { createD1AutomationStore } from './d1-automation-store.ts';
import { recordRunSettled } from './outcome.ts';

const AT = '2026-10-14T04:00:00.000Z';

afterEach(() => {
	vi.unstubAllGlobals();
	__resetSlackClientForTests();
});

async function dispatchedRun(fireTime: string) {
	return { automationId: 'a1', fireTime, conversationId: 'conv', submissionId: `sub-${fireTime}` };
}

describe('recordRunSettled', () => {
	test('three failed settles pause the automation and DM the owner once', async () => {
		const store = createD1AutomationStore(await openTestDatabase());
		const calls = stubSlackApi(async (call) =>
			call.method === 'conversations.open' ? { ok: true, channel: { id: 'D_OWNER' } } : { ok: true, ts: '1.1' },
		);
		const slack = getSlackClient('xoxb-test');

		await store.automations.create({
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
		});

		for (const fireTime of ['t1', 't2', 't3', 't4']) {
			const run = await dispatchedRun(fireTime);

			await store.runs.claim({ automationId: 'a1', fireTime, createdAt: AT });
			await store.runs.dispatched(run);
			await recordRunSettled({ store, slack, submissionId: run.submissionId, outcome: 'failed', error: 'boom', at: AT });
		}

		expect(await store.automations.get('a1')).toMatchObject({ status: 'paused', consecutiveFailures: 4 });
		expect(calls.filter((call) => call.method === 'chat.postMessage')).toHaveLength(1);
	});

	test('a success resets the failure count; an unrelated submission changes nothing', async () => {
		const store = createD1AutomationStore(await openTestDatabase());

		stubSlackApi();

		await store.automations.create({
			id: 'a1', kind: 'agent', title: 'Digest', prompt: 'AI news', scope: 'personal', destinationChannelId: 'D_OWNER',
			schedule: { kind: 'recurring', cron: '0 9 * * *' }, timezone: 'Asia/Kolkata', ownerUserId: 'U_OWNER', nextRunAt: AT, createdAt: AT,
		});
		await store.automations.recordFailure({ id: 'a1', at: AT, pauseAt: 3 });

		const run = await dispatchedRun('t1');

		await store.runs.claim({ automationId: 'a1', fireTime: 't1', createdAt: AT });
		await store.runs.dispatched(run);

		await recordRunSettled({ store, slack: undefined, submissionId: 'a-human-reply', outcome: 'failed', at: AT });
		expect((await store.automations.get('a1'))?.consecutiveFailures).toBe(1);

		await recordRunSettled({ store, slack: undefined, submissionId: run.submissionId, outcome: 'completed', at: AT });
		expect((await store.automations.get('a1'))?.consecutiveFailures).toBe(0);
	});
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm vitest run src/automations/scheduler.test.ts src/automations/outcome.test.ts`
Expected: FAIL, because `./scheduler.ts` and `./outcome.ts` do not exist.

- [ ] **Step 5: Implement `blocks.ts` (run messages and notice)**

```ts
// src/automations/blocks.ts
import type { Button, KnownBlock } from '@slack/web-api';
import * as v from 'valibot';
import { clip, contextBlock, escapeMrkdwn, sectionBlock } from '../channels/mrkdwn.ts';
import type { Automation } from './automation.ts';

export const AUTOMATION_ACTION = {
	create: 'automation_create',
	editDraft: 'automation_edit_draft',
	cancel: 'automation_cancel',
	pause: 'automation_pause',
	resume: 'automation_resume',
	runNow: 'automation_run_now',
	edit: 'automation_edit',
	delete: 'automation_delete',
} as const;

export type AutomationActionId = (typeof AUTOMATION_ACTION)[keyof typeof AUTOMATION_ACTION];

export const AUTOMATION_MODAL = 'automation_modal';

// Where a button was drawn, so its handler knows what to redraw: the run
// header, the confirmation card, or an ephemeral list or DM (reply in text).
export type Surface = 'header' | 'card' | 'list';

const buttonValueSchema = v.pipe(
	v.string(),
	v.parseJson(),
	v.object({ id: v.string(), surface: v.picklist(['header', 'card', 'list']) }),
);

export function buttonValue(id: string, surface: Surface): string {
	return JSON.stringify({ id, surface });
}

export function parseButtonValue(value: string): { id: string; surface: Surface } | undefined {
	const result = v.safeParse(buttonValueSchema, value);

	return result.success ? result.output : undefined;
}

export type Rendered = { text: string; blocks: KnownBlock[] };

export function button({
	actionId,
	text,
	value,
	style,
}: {
	actionId: AutomationActionId;
	text: string;
	value: string;
	style?: 'primary' | 'danger';
}): Button {
	return {
		type: 'button',
		action_id: actionId,
		text: { type: 'plain_text', text },
		value,
		...(style ? { style } : {}),
	};
}

// Pause or Resume for the status, then the extras; none once deleted.
export function manageButtons({
	automation,
	surface,
	extras,
}: {
	automation: Automation;
	surface: Surface;
	extras: ('runNow' | 'edit' | 'delete')[];
}): Button[] {
	if (automation.status === 'deleted') return [];

	const value = buttonValue(automation.id, surface);
	const buttons: Button[] = [];

	if (automation.status === 'active') {
		buttons.push(button({ actionId: AUTOMATION_ACTION.pause, text: 'Pause', value }));
	}

	if (automation.status === 'paused' || automation.status === 'blocked') {
		buttons.push(button({ actionId: AUTOMATION_ACTION.resume, text: 'Resume', value }));
	}

	const labels = { runNow: 'Run now', edit: 'Edit', delete: 'Delete' } as const;

	for (const extra of extras) {
		buttons.push(
			button({
				actionId: AUTOMATION_ACTION[extra],
				text: labels[extra],
				value,
				...(extra === 'delete' ? { style: 'danger' as const } : {}),
			}),
		);
	}

	return buttons;
}

function actionsBlock(buttons: Button[]): KnownBlock[] {
	return buttons.length > 0 ? [{ type: 'actions', elements: buttons }] : [];
}

// An agent run's top-level header (its ts is the run's thread), or a reminder.
export function runMessage(automation: Automation): Rendered {
	const owner = `<@${automation.ownerUserId}>`;
	const title = escapeMrkdwn(automation.title);
	const buttons = manageButtons({ automation, surface: 'header', extras: ['edit'] });

	if (automation.kind === 'reminder') {
		const mention = automation.scope === 'personal' ? `${owner} ` : '';
		const lead = `${mention}⏰ ${escapeMrkdwn(automation.prompt)}`;

		return {
			text: clip(lead, 2900),
			blocks: [sectionBlock(lead), contextBlock(`Reminder · ${title} · by ${owner}`), ...actionsBlock(buttons)],
		};
	}

	const lead = `⏰ *${title}* · automation by ${owner}`;

	return { text: clip(lead, 2900), blocks: [sectionBlock(lead), ...actionsBlock(buttons)] };
}

// A DM to the owner about their automation, with Resume when it is stopped.
export function ownerNotice({ automation, message }: { automation: Automation; message: string }): Rendered {
	return {
		text: clip(message, 2900),
		blocks: [sectionBlock(message), ...actionsBlock(manageButtons({ automation, surface: 'list', extras: [] }))],
	};
}
```

- [ ] **Step 6: Implement `slack-people.ts`, `outcome.ts`, `scheduler.ts`**

```ts
// src/automations/slack-people.ts
import type { SlackBotClient } from '../channels/slack-reply.ts';

// The bot's DM with a user (needs `im:write`).
export async function openDirectMessage({
	slack,
	userId,
}: {
	slack: SlackBotClient;
	userId: string;
}): Promise<string> {
	const opened = await slack.conversations.open({ users: userId });
	const id = opened.channel?.id;

	if (!id) throw new Error(`Slack opened no DM with ${userId}.`);

	return id;
}
```

```ts
// src/automations/outcome.ts
import type { SlackBotClient } from '../channels/slack-reply.ts';
import { errorMessage } from '../json.ts';
import type { Automation, AutomationStore } from './automation.ts';
import { ownerNotice } from './blocks.ts';
import { openDirectMessage } from './slack-people.ts';

export const PAUSE_AFTER_FAILURES = 3;

// Best effort: a lost notice must not undo the state change it reports.
export async function notifyOwner({
	slack,
	automation,
	message,
}: {
	slack: SlackBotClient;
	automation: Automation;
	message: string;
}): Promise<void> {
	try {
		const channel = await openDirectMessage({ slack, userId: automation.ownerUserId });

		await slack.chat.postMessage({ channel, ...ownerNotice({ automation, message }) });
	} catch (error) {
		console.warn(`[automations] Notice for ${automation.id} failed: ${errorMessage(error)}`);
	}
}

export async function notifyPaused({
	slack,
	automation,
}: {
	slack: SlackBotClient | undefined;
	automation: Automation | undefined;
}): Promise<void> {
	// Only the outcome that reaches the threshold returns this count; duplicates return undefined.
	if (!automation || !slack || automation.status !== 'paused' || automation.consecutiveFailures !== PAUSE_AFTER_FAILURES) {
		return;
	}

	await notifyOwner({
		slack,
		automation,
		message: `I paused your automation *${automation.title}* after ${PAUSE_AFTER_FAILURES} failed runs in a row. Resume it when it should run again.`,
	});
}

// Called for every settled submission; only an automation fire's own matches a run.
export async function recordRunSettled({
	store,
	slack,
	submissionId,
	outcome,
	error,
	at,
}: {
	store: AutomationStore;
	slack: SlackBotClient | undefined;
	submissionId: string;
	outcome: 'completed' | 'failed' | 'aborted';
	error?: string;
	at: string;
}): Promise<void> {
	const automation = await store.runs.recordOutcome({
		submissionId,
		status: outcome === 'completed' ? 'succeeded' : 'failed',
		reason: error,
		at,
		pauseAt: PAUSE_AFTER_FAILURES,
	});

	if (outcome !== 'completed') await notifyPaused({ slack, automation });
}
```

```ts
// src/automations/scheduler.ts
import * as v from 'valibot';
import type { SlackBotClient } from '../channels/slack-reply.ts';
import { errorMessage } from '../json.ts';
import type { Automation, AutomationStore } from './automation.ts';
import { runMessage } from './blocks.ts';
import { notifyOwner, notifyPaused, PAUSE_AFTER_FAILURES } from './outcome.ts';
import { nextRunAfter } from './schedule.ts';

export type StartRun = (args: {
	automation: Automation;
	threadTs: string;
	fireTime: string;
}) => Promise<{ conversationId: string; submissionId: string }>;

export type SchedulerDeps = {
	store: AutomationStore;
	slack: SlackBotClient;
	startRun: StartRun;
	now(): Date;
};

// Paging, not a rate guard: rows past it are still due on the next tick.
const TICK_LIMIT = 50;

// Slack errors that mean the bot can no longer post to the destination.
const LOST_CHANNEL = new Set(['channel_not_found', 'not_in_channel', 'is_archived']);

const OWNER_GONE = 'Its owner is no longer in this workspace.';

const slackErrorSchema = v.object({ data: v.object({ error: v.string() }) });

export function slackErrorCode(error: unknown): string | undefined {
	const result = v.safeParse(slackErrorSchema, error);

	return result.success ? result.output.data.error : undefined;
}

export async function ownerGoneReason({
	slack,
	userId,
}: {
	slack: SlackBotClient;
	userId: string;
}): Promise<string | undefined> {
	try {
		const { user } = await slack.users.info({ user: userId });

		return user && !user.deleted ? undefined : OWNER_GONE;
	} catch (error) {
		if (slackErrorCode(error) === 'user_not_found') return OWNER_GONE;

		throw error;
	}
}

// The heartbeat. Each due row is claimed, advanced, then fired.
export async function runDueAutomations(deps: SchedulerDeps): Promise<void> {
	const now = deps.now();
	const due = await deps.store.automations.due({ now: now.toISOString(), limit: TICK_LIMIT });

	for (const automation of due) {
		try {
			await tick({ automation, deps, now });
		} catch (error) {
			console.error(`[automations] Tick for ${automation.id} failed: ${errorMessage(error)}`);
		}
	}
}

async function tick({ automation, deps, now }: { automation: Automation; deps: SchedulerDeps; now: Date }) {
	const fireTime = automation.nextRunAt;

	if (!fireTime) return;

	const at = now.toISOString();
	// From now, not from the fire time, so missed fires collapse into this one.
	const claimed = await deps.store.runs.claimScheduled({
		automationId: automation.id,
		fireTime,
		nextRunAt:
			automation.schedule.kind === 'recurring'
				? nextRunAfter(automation.schedule, automation.timezone, now)
				: undefined,
		at,
	});

	if (!claimed) return;

	await fireAutomation({ automation, fireTime, deps });
}

// Run now: a fire at this instant that leaves the schedule alone.
export async function runNow({ automation, deps }: { automation: Automation; deps: SchedulerDeps }): Promise<boolean> {
	const fireTime = deps.now().toISOString();
	const claimed = await deps.store.runs.claim({ automationId: automation.id, fireTime, createdAt: fireTime });

	if (!claimed) return false;

	await fireAutomation({ automation, fireTime, deps });

	return true;
}

// Fires a claimed run: re-authorize, then post a reminder or a header plus dispatch.
export async function fireAutomation({
	automation,
	fireTime,
	deps,
}: {
	automation: Automation;
	fireTime: string;
	deps: SchedulerDeps;
}): Promise<void> {
	const { store, slack } = deps;
	const run = { automationId: automation.id, fireTime };

	try {
		const gone = await ownerGoneReason({ slack, userId: automation.ownerUserId });

		if (gone) {
			await block({ automation, fireTime, reason: gone, deps });

			return;
		}

		const posted = await slack.chat.postMessage({
			channel: automation.destinationChannelId,
			...runMessage(automation),
			unfurl_links: false,
			unfurl_media: false,
		});

		if (automation.kind === 'reminder') {
			await store.runs.recordOutcome({ ...run, status: 'posted', at: deps.now().toISOString(), pauseAt: PAUSE_AFTER_FAILURES });

			return;
		}

		if (!posted.ts) throw new Error('Slack returned no timestamp for the run header.');

		const started = await deps.startRun({ automation, threadTs: posted.ts, fireTime });

		await store.runs.dispatched({ ...run, ...started });
	} catch (error) {
		if (LOST_CHANNEL.has(slackErrorCode(error) ?? '')) {
			await block({
				automation,
				fireTime,
				reason: `I can no longer post in <#${automation.destinationChannelId}>. Invite me back, then resume it.`,
				deps,
			});

			return;
		}

		const failed = await store.runs.recordOutcome({ ...run, status: 'failed', reason: errorMessage(error), at: deps.now().toISOString(), pauseAt: PAUSE_AFTER_FAILURES });
		await notifyPaused({ slack, automation: failed });
	}
}

async function block({
	automation,
	fireTime,
	reason,
	deps,
}: {
	automation: Automation;
	fireTime: string;
	reason: string;
	deps: SchedulerDeps;
}): Promise<void> {
	const blocked = await deps.store.automations.setStatus({
		id: automation.id,
		status: 'blocked',
		at: deps.now().toISOString(),
	});

	await deps.store.runs.recordOutcome({ automationId: automation.id, fireTime, status: 'failed', reason, at: deps.now().toISOString(), pauseAt: PAUSE_AFTER_FAILURES });

	if (!blocked) return;

	await notifyOwner({
		slack: deps.slack,
		automation: blocked,
		message: `Your automation *${automation.title}* is blocked. ${reason}`,
	});
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run src/automations src/planning`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/channels/mrkdwn.ts src/planning/card-blocks.ts src/channels/slack-reply.ts src/automations
git commit -m "Fire due automations from a scheduler over D1"
```

### Task 5: Cron, run start, and run outcomes

**Files:**
- Create: `src/automations/workspace.ts`
- Create: `src/automations/start-run.ts`
- Modify: `src/cloudflare.ts` (store holder; `scheduled` handler)
- Modify: `wrangler.jsonc` (`triggers.crons`)
- Modify: `src/agents/coworker.ts` (`observe` records automation settles)
- Test: `src/automations/start-run.test.ts`

**Interfaces:**
- Consumes: `startConversation`, `modelRouteForDispatch`, `ConversationRuntime` (Task 3); `StartRun`, `runDueAutomations` (Task 4); `recordRunSettled` (Task 4).
- Produces: `workspaceTeamId(slack: SlackBotClient): Promise<string>`, `__resetWorkspaceTeamForTests()`, `automationSignalBody({ automation, fireTime }): string`, `createStartRun({ runtime, slack, instanceId, codexAuth, now }): StartRun`.

- [ ] **Step 1: Write the failing test**

```ts
// src/automations/start-run.test.ts
import { afterEach, describe, expect, test, vi } from 'vitest';
import { __resetSlackClientForTests, getSlackClient } from '../channels/slack-reply.ts';
import { stubSlackApi } from '../channels/testing/slack-api-stub.ts';
import type { ConversationRuntime } from '../conversations/start.ts';
import type { Automation } from './automation.ts';
import { createStartRun } from './start-run.ts';
import { __resetWorkspaceTeamForTests } from './workspace.ts';

afterEach(() => {
	vi.unstubAllGlobals();
	__resetSlackClientForTests();
	__resetWorkspaceTeamForTests();
});

const automation: Automation = {
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
	status: 'active',
	lastScheduledAt: '2026-10-13T03:30:00.000Z',
	consecutiveFailures: 0,
	createdAt: '2026-10-01T00:00:00.000Z',
	updatedAt: '2026-10-01T00:00:00.000Z',
};

describe('createStartRun', () => {
	test("starts the owner's conversation in the header thread", async () => {
		stubSlackApi(async (call) => (call.method === 'auth.test' ? { ok: true, team_id: 'T_HOME' } : { ok: true }));

		const requests: unknown[] = [];

		const runtime: ConversationRuntime = {
			dispatch: async (_agent, request) => {
				requests.push(request);

				return { submissionId: 'sub-1', uid: 'u', deduplicated: false };
			},
		};

		const startRun = createStartRun({
			runtime,
			slack: getSlackClient('xoxb-test'),
			instanceId: ({ teamId, channelId, threadTs }) => `slack:v1:${teamId}:${channelId}:${threadTs}`,
			codexAuth: () => ({ status: async () => ({ state: 'disconnected' }) }) as never,
			now: () => new Date('2026-10-14T03:30:05.000Z'),
		});

		const started = await startRun({ automation, threadTs: '100.1', fireTime: '2026-10-14T03:30:00.000Z' });

		expect(started).toEqual({ conversationId: 'slack:v1:T_HOME:C_ENG:100.1', submissionId: 'sub-1' });
		expect(requests[0]).toMatchObject({
			id: 'slack:v1:T_HOME:C_ENG:100.1',
			idempotencyKey: 'automation:a1:2026-10-14T03:30:00.000Z',
			initialData: { channelId: 'C_ENG', threadTs: '100.1', startedBy: 'U_OWNER', repo: automation.repo, automationId: 'a1' },
			message: {
				kind: 'signal',
				type: 'automation.fire',
				attributes: {
					automationId: 'a1',
					scheduledAt: '2026-10-14T03:30:00.000Z',
					previousScheduledAt: '2026-10-13T03:30:00.000Z',
					userId: 'U_OWNER',
					modelRoute: 'opencode-go',
				},
			},
		});
		expect(JSON.stringify(requests[0])).toContain("Post yesterday's merged PRs.");
	});
});
```

(If `as never` trips lint, build the fake `CodexAuthControl` with every method throwing except `status`. Copy the shape from an existing slash-command test fake.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/automations/start-run.test.ts`
Expected: FAIL, because the modules do not exist.

- [ ] **Step 3: Implement**

```ts
// src/automations/workspace.ts
import type { SlackBotClient } from '../channels/slack-reply.ts';

// One deployment serves one workspace (ADR 0001); ask Slack once per isolate.
let cached: Promise<string> | undefined;

export function workspaceTeamId(slack: SlackBotClient): Promise<string> {
	cached ??= slack.auth
		.test()
		.then(({ team_id: teamId }) => {
			if (!teamId) throw new Error('Slack auth.test returned no team id.');

			return teamId;
		})
		.catch((error: unknown) => {
			cached = undefined;
			throw error;
		});

	return cached;
}

/** Test-only. */
export function __resetWorkspaceTeamForTests(): void {
	cached = undefined;
}
```

```ts
// src/automations/start-run.ts
import type { SlackThreadRef } from '@flue/slack';
import type { SlackBotClient } from '../channels/slack-reply.ts';
import { type ConversationRuntime, modelRouteForDispatch, startConversation } from '../conversations/start.ts';
import type { CodexAuthControl } from '../integrations/codex-auth/codex-auth.ts';
import type { Automation } from './automation.ts';
import type { StartRun } from './scheduler.ts';
import { workspaceTeamId } from './workspace.ts';

// The model prompt for one fire; the owner's text is quoted as-is.
export function automationSignalBody({ automation, fireTime }: { automation: Automation; fireTime: string }): string {
	return [
		`Scheduled automation "${automation.title}" by <@${automation.ownerUserId}>, fire time ${fireTime}.`,
		'Do this now and post the result with reply_in_slack_thread:',
		'',
		automation.prompt,
	].join('\n');
}

export function createStartRun({
	runtime,
	slack,
	instanceId,
	codexAuth,
	now,
}: {
	runtime: ConversationRuntime;
	slack: SlackBotClient;
	instanceId(thread: SlackThreadRef): string;
	codexAuth: () => CodexAuthControl;
	now(): Date;
}): StartRun {
	return async ({ automation, threadTs, fireTime }) => {
		const teamId = await workspaceTeamId(slack);
		const thread = { teamId, channelId: automation.destinationChannelId, threadTs };
		const id = instanceId(thread);
		const modelRoute = await modelRouteForDispatch(codexAuth);
		const key = `automation:${automation.id}:${fireTime}`;

		const attributes: Record<string, string> = {
			eventId: key,
			userId: automation.ownerUserId,
			automationId: automation.id,
			scheduledAt: fireTime,
			modelRoute,
		};

		if (automation.lastScheduledAt) attributes.previousScheduledAt = automation.lastScheduledAt;

		const receipt = await startConversation({
			runtime,
			now: now(),
			start: {
				id,
				thread,
				startedBy: automation.ownerUserId,
				repo: automation.repo,
				automationId: automation.id,
				idempotencyKey: key,
				message: { type: 'automation.fire', body: automationSignalBody({ automation, fireTime }), attributes },
			},
		});

		return { conversationId: id, submissionId: receipt.submissionId };
	};
}
```

In `src/cloudflare.ts`, add below the planning store line:

```ts
// Automations live in APP_DB too. The Coworker reads this holder to mount
// draft_automation and to record how a fire's submission settled.
const automations = createD1AutomationStore(env.APP_DB);

setAutomationStore(automations);

// The heartbeat (`* * * * *` in wrangler.jsonc). Cron Triggers are static and
// UTC, so user schedules are D1 rows; see src/automations/scheduler.ts.
export default {
	async scheduled(): Promise<void> {
		const serverEnv = loadServerEnv(process.env);
		const slack = getSlackClient(serverEnv.SLACK_BOT_TOKEN);
		const channel = createSlackChannelForEnv(serverEnv, () => codexAuth(env));

		await runDueAutomations({
			store: automations,
			slack,
			now: () => new Date(),
			startRun: createStartRun({
				runtime: { dispatch },
				slack,
				instanceId: (thread) => channel.instanceId(thread),
				codexAuth: () => codexAuth(env),
				now: () => new Date(),
			}),
		});
	},
};
```

Add the imports (`dispatch` from `@flue/runtime`; `loadServerEnv`; `getSlackClient`; `createSlackChannelForEnv`; `createD1AutomationStore`; `setAutomationStore`; `runDueAutomations`; `createStartRun`). Update the header comment's mention of the default export. Secrets are read inside the handler, never at module scope: an isolate without them must still load.

In `wrangler.jsonc`, add:

```jsonc
	// The automation heartbeat: every minute, the Worker fires due D1 rows.
	"triggers": { "crons": ["* * * * *"] },
```

In `src/agents/coworker.ts`, replace the `observe(...)` call:

```ts
observe((event, context) => {
	const cardEvent = cardEventFromObservation(event);

	const published = cardEvent
		? publishCardEvent({ ...cardEvent, instanceId: context.id })
		: Promise.resolve();

	if (event.type !== 'submission_settled') return published;

	return Promise.all([published, settleAutomationRun(event)]).then(() => undefined);
});
```

and add:

```ts
// Only an automation fire's own submission matches a run; every other settle
// is one indexed no-op UPDATE. Absent under `flue run` (no store).
async function settleAutomationRun(
	event: Extract<FlueObservation, { type: 'submission_settled' }>,
): Promise<void> {
	const store = automationStore();

	if (!store) return;

	const token = process.env.SLACK_BOT_TOKEN;

	try {
		await recordRunSettled({
			store,
			slack: token ? getSlackClient(token) : undefined,
			submissionId: event.submissionId,
			outcome: event.outcome,
			error: event.error?.message,
			at: new Date().toISOString(),
		});
	} catch (error) {
		console.error(`[automations] Recording settle ${event.submissionId} failed: ${errorMessage(error)}`);
	}
}
```

- [ ] **Step 4: Run tests, types, and the build**

Run: `pnpm vitest run src/automations && pnpm run check:types && pnpm run build`
Expected: PASS. The build bundles the `scheduled` export into the Worker.

- [ ] **Step 5: Verify the batch and commit**

Run: `pnpm test && pnpm run lint && pnpm run fmt:check`

```bash
git add src/automations src/cloudflare.ts wrangler.jsonc src/agents/coworker.ts
git commit -m "Run the automation heartbeat and record run outcomes"
```

**Stop: Batch 2 review.** Before deploying this batch, apply migration 0005 (`pnpm exec wrangler d1 migrations apply APP_DB --remote`).

---

## Batch 3: Creating

### Task 6: Shared validation, repo resolution, and the confirmation card

**Files:**
- Modify: `src/agents/attach-repo.ts` (extract `resolveInstallationRepo`)
- Create: `src/automations/fields.ts`
- Modify: `src/automations/blocks.ts` (add `automationCard`, `statusLine`)
- Test: `src/automations/fields.test.ts`, `src/automations/blocks.test.ts`, and the existing `src/agents/attach-repo.test.ts` must stay green

**Interfaces:**
- Produces:
  - `resolveInstallationRepo({ directory, input }: { directory: RepoDirectory; input: string }): Promise<string>`. It throws the same refusal text `attach_repo` throws today.
  - `TITLE_MAX = 80`, `PROMPT_MAX = 2500`, `type FieldError = { field: 'title' | 'prompt' | 'timezone' | 'schedule'; message: string }`, `fieldsError({ fields, now }): FieldError | undefined`
  - `type CardState = { kind: 'draft'; draftId: string } | { kind: 'created'; automation: Automation } | { kind: 'cancelled' }`, `automationCard({ fields, owner, state, now }): Rendered`, `statusLine({ automation, now }): string`

- [ ] **Step 1: Write the failing tests**

```ts
// src/automations/fields.test.ts
import { describe, expect, test } from 'vitest';
import type { AutomationFields } from './automation.ts';
import { fieldsError, PROMPT_MAX } from './fields.ts';

const now = new Date('2026-10-14T03:00:00.000Z');

const fields: AutomationFields = {
	kind: 'reminder',
	title: 'Tickets',
	prompt: 'Book tickets',
	scope: 'personal',
	destinationChannelId: 'D1',
	schedule: { kind: 'once', runAt: '2026-10-15T12:30:00.000Z' },
	timezone: 'Asia/Kolkata',
};

describe('fieldsError', () => {
	test('accepts valid fields', () => {
		expect(fieldsError({ fields, now })).toBeUndefined();
	});

	test('names the field at fault', () => {
		expect(fieldsError({ fields: { ...fields, title: '  ' }, now })?.field).toBe('title');
		expect(fieldsError({ fields: { ...fields, prompt: 'x'.repeat(PROMPT_MAX + 1) }, now })?.field).toBe('prompt');
		expect(fieldsError({ fields: { ...fields, timezone: 'IST' }, now })?.field).toBe('timezone');
		expect(fieldsError({ fields: { ...fields, schedule: { kind: 'once', runAt: '2026-10-13T00:00:00.000Z' } }, now })).toEqual({
			field: 'schedule',
			message: 'That time has already passed.',
		});
	});
});
```

```ts
// src/automations/blocks.test.ts
import { describe, expect, test } from 'vitest';
import type { Automation, AutomationFields } from './automation.ts';
import { AUTOMATION_ACTION, automationCard, parseButtonValue } from './blocks.ts';

const now = new Date('2026-10-14T03:00:00.000Z');

const fields: AutomationFields = {
	kind: 'agent',
	title: 'Merged PRs',
	prompt: "Post yesterday's merged PRs in acme/api.",
	scope: 'channel',
	destinationChannelId: 'C_ENG',
	repo: 'https://github.com/acme/api.git',
	schedule: { kind: 'recurring', cron: '0 9 * * 1-5' },
	timezone: 'Asia/Kolkata',
};

function actionIds(blocks: unknown[]): string[] {
	return JSON.stringify(blocks).match(/"action_id":"[a-z_]+"/g)?.map((id) => id.slice(13, -1)) ?? [];
}

describe('automationCard', () => {
	test('a draft shows everything a person confirms, verbatim, with Create/Edit/Cancel', () => {
		const card = automationCard({ fields, owner: 'U1', state: { kind: 'draft', draftId: 'd1' }, now });
		const text = JSON.stringify(card.blocks);

		expect(text).toContain('Weekdays at 09:00 IST');
		expect(text).toContain('Wed 14 Oct, 09:00 IST');
		expect(text).toContain('acme/api');
		expect(text).toContain('<#C_ENG>');
		expect(text).toContain("Post yesterday's merged PRs in acme/api.");
		expect(actionIds(card.blocks)).toEqual([AUTOMATION_ACTION.create, AUTOMATION_ACTION.editDraft, AUTOMATION_ACTION.cancel]);
	});

	test('a created card manages the automation', () => {
		const automation: Automation = {
			...fields,
			id: 'a1',
			ownerUserId: 'U1',
			status: 'active',
			nextRunAt: '2026-10-14T03:30:00.000Z',
			consecutiveFailures: 0,
			createdAt: '',
			updatedAt: '',
		};

		const card = automationCard({ fields: automation, owner: 'U1', state: { kind: 'created', automation }, now });

		expect(JSON.stringify(card.blocks)).toContain('Created · next run Wed 14 Oct, 09:00 IST');
		expect(actionIds(card.blocks)).toEqual([
			AUTOMATION_ACTION.pause,
			AUTOMATION_ACTION.runNow,
			AUTOMATION_ACTION.edit,
			AUTOMATION_ACTION.delete,
		]);
		expect(parseButtonValue(JSON.stringify({ id: 'a1', surface: 'card' }))).toEqual({ id: 'a1', surface: 'card' });
	});
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/automations/fields.test.ts src/automations/blocks.test.ts`
Expected: FAIL, because `fields.ts` and `automationCard` are missing.

- [ ] **Step 3: Implement**

In `src/agents/attach-repo.ts`, add and use:

```ts
// The installation's canonical HTTPS clone URL for `input`. Throws a refusal
// that names close matches. Shared by attach_repo and automations.
export async function resolveInstallationRepo({
	directory,
	input,
}: {
	directory: RepoDirectory;
	input: string;
}): Promise<string> {
	const wanted = canonicalRepo(input).toLowerCase();
	const match = await directory.find(wanted);

	if (!match) {
		const names = await directory.list();
		throw new Error(refusal(wanted, names));
	}

	return `https://github.com/${match}.git`;
}
```

and in `attach_repo`'s `run`: `const repoUrl = await resolveInstallationRepo({ directory, input: data.repo });`.

```ts
// src/automations/fields.ts
import type { AutomationFields } from './automation.ts';
import { isValidTimezone, scheduleError } from './schedule.ts';

export const TITLE_MAX = 80;

// The card shows the prompt verbatim in one section (Slack caps sections at 3000).
export const PROMPT_MAX = 2500;

export type FieldError = { field: 'title' | 'prompt' | 'timezone' | 'schedule'; message: string };

// Checked by draft_automation, the modal, and Create; owner, destination and
// repo are resolved before this.
export function fieldsError({ fields, now }: { fields: AutomationFields; now: Date }): FieldError | undefined {
	const title = fields.title.trim();
	const prompt = fields.prompt.trim();

	if (!title) return { field: 'title', message: 'Give the automation a title.' };

	if (title.length > TITLE_MAX) return { field: 'title', message: `Keep the title under ${TITLE_MAX} characters.` };

	if (!prompt) return { field: 'prompt', message: 'Say what the automation should do.' };

	if (prompt.length > PROMPT_MAX) {
		return { field: 'prompt', message: `Keep the instruction under ${PROMPT_MAX} characters.` };
	}

	if (!isValidTimezone(fields.timezone)) {
		return { field: 'timezone', message: `${fields.timezone} is not a time zone. Use an IANA name such as Asia/Kolkata.` };
	}

	const problem = scheduleError(fields.schedule, fields.timezone, now);

	return problem ? { field: 'schedule', message: problem } : undefined;
}
```

Add to `src/automations/blocks.ts`:

```ts
export type CardState =
	| { kind: 'draft'; draftId: string }
	| { kind: 'created'; automation: Automation }
	| { kind: 'cancelled' };

const NEXT_RUNS = 3;

function repoName(url: string): string {
	return url.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
}

function quoted(text: string): string {
	return escapeMrkdwn(text)
		.split('\n')
		.map((line) => `> ${line}`)
		.join('\n');
}

export function statusLine({ automation, now }: { automation: Automation; now: Date }): string {
	switch (automation.status) {
		case 'active':
			return automation.nextRunAt
				? `✅ Created · next run ${formatRunTime(automation.nextRunAt, automation.timezone)}`
				: '✅ Created';
		case 'paused':
			return '⏸ Paused';
		case 'blocked':
			return '⛔ Blocked: check the DM from Yappa';
		case 'completed':
			return `✔ Completed${automation.lastScheduledAt ? ` · scheduled for ${formatRunTime(automation.lastScheduledAt, automation.timezone)}` : ''}`;
		case 'deleted':
			return '🗑 Deleted';
		default: {
			const _exhaustive: never = automation.status;

			return _exhaustive;
		}
	}
}

export function automationCard({
	fields,
	owner,
	state,
	now,
}: {
	fields: AutomationFields;
	owner: string;
	state: CardState;
	now: Date;
}): Rendered {
	const where =
		fields.scope === 'personal' ? `Personal · DM to <@${owner}>` : `Channel · posts in <#${fields.destinationChannelId}>`;

	const upcoming = upcomingRuns(fields.schedule, fields.timezone, now, NEXT_RUNS).map((iso) =>
		formatRunTime(iso, fields.timezone),
	);

	const lines = [
		`*${escapeMrkdwn(fields.title)}*`,
		`${fields.kind === 'agent' ? 'Agent run' : 'Reminder'} · ${where}`,
		...(fields.kind === 'agent' && fields.repo ? [`Repo: ${repoName(fields.repo)}`] : []),
		`Schedule: ${describeSchedule(fields.schedule, fields.timezone, now)}`,
		`Next runs: ${upcoming.length > 0 ? upcoming.join(' · ') : 'none'}`,
	];

	const blocks: KnownBlock[] = [
		sectionBlock(lines.join('\n')),
		sectionBlock(`*${fields.kind === 'agent' ? 'Instruction' : 'Reminder text'}*\n${quoted(fields.prompt)}`),
	];

	switch (state.kind) {
		case 'draft': {
			const value = buttonValue(state.draftId, 'card');

			blocks.push(contextBlock(`Proposed for <@${owner}>. Nothing runs until they press Create.`));
			blocks.push(
				...actionsBlock([
					button({ actionId: AUTOMATION_ACTION.create, text: 'Create', value, style: 'primary' }),
					button({ actionId: AUTOMATION_ACTION.editDraft, text: 'Edit', value }),
					button({ actionId: AUTOMATION_ACTION.cancel, text: 'Cancel', value }),
				]),
			);
			break;
		}

		case 'created':
			blocks.push(contextBlock(statusLine({ automation: state.automation, now })));
			blocks.push(
				...actionsBlock(manageButtons({ automation: state.automation, surface: 'card', extras: ['runNow', 'edit', 'delete'] })),
			);
			break;
		case 'cancelled':
			blocks.push(contextBlock('Cancelled. Nothing was created.'));
			break;
		default: {
			const _exhaustive: never = state;

			return _exhaustive;
		}
	}

	return { text: clip(`Automation: ${fields.title}`, 2900), blocks };
}
```

Import `AutomationFields` from `./automation.ts` and `describeSchedule`, `formatRunTime`, `upcomingRuns` from `./schedule.ts` into `blocks.ts`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/automations src/agents/attach-repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/attach-repo.ts src/automations
git commit -m "Validate automation fields and render the confirmation card"
```

### Task 7: `draft_automation` and the Coworker

**Files:**
- Modify: `src/automations/slack-people.ts` (add `ownerTimezone`, `isDirectMessageChannel`)
- Create: `src/agents/automation-tools.ts`
- Modify: `src/config.ts` (`automationConfirmation`)
- Modify: `src/agents/coworker.ts` (requester tracking; mount the tool; reply guard)
- Test: `src/agents/automation-tools.test.ts`, `src/agents/coworker.test.ts`

**Interfaces:**
- Consumes: `fieldsError`, `automationCard`, `resolveInstallationRepo`, `RepoDirectory` (Task 6); `AutomationStore` (Task 2); `openDirectMessage` (Task 4).
- Produces:
  - `ownerTimezone({ slack, userId }): Promise<string>` (Slack `tz`, else `UTC`), `isDirectMessageChannel(channelId: string): boolean`
  - `AUTOMATION_REPLY_TOOLS: ReadonlySet<string>` (`draft_automation`)
  - `deliverySender(delivery: DeliveredMessage): string | undefined`
  - `draftAutomationTool({ owner, channelId, threadTs, conversationRepo, store, slack, directory, confirmation, now, newId }): ToolDefinition`
  - `automationConfirmation: boolean` in `src/config.ts`
  - `mountsDraftAutomation(data: { automationId?: string }): boolean` in `src/agents/coworker.ts`
- Later tasks extend `AutomationInteractionDeps` (Task 9 adds `runNow`, Task 10 adds `directory`). Each of those tasks also adds the field to the test `setup()` deps.

- [ ] **Step 1: Write the failing tests**

```ts
// src/agents/automation-tools.test.ts
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createD1AutomationStore } from '../automations/d1-automation-store.ts';
import { __resetSlackClientForTests, getSlackClient } from '../channels/slack-reply.ts';
import { stubSlackApi } from '../channels/testing/slack-api-stub.ts';
import { openTestDatabase } from '../testing/d1.ts';
import { deliverySender, draftAutomationTool } from './automation-tools.ts';

const now = new Date('2026-10-14T03:00:00.000Z');

afterEach(() => {
	vi.unstubAllGlobals();
	__resetSlackClientForTests();
});

async function setup({ confirmation = true, owner = 'U_OWNER', channelId = 'C_ENG' } = {}) {
	const store = createD1AutomationStore(await openTestDatabase());

	const calls = stubSlackApi(async (call) => {
		switch (call.method) {
			case 'users.info':
				return { ok: true, user: { id: owner, tz: 'Asia/Kolkata' } };
			case 'conversations.open':
				return { ok: true, channel: { id: 'D_OWNER' } };
			default:
				return { ok: true, ts: '200.1' };
		}
	});

	const tool = draftAutomationTool({
		owner,
		channelId,
		threadTs: '1.0',
		conversationRepo: 'https://github.com/acme/api.git',
		store,
		slack: getSlackClient('xoxb-test'),
		directory: { find: async (repo) => (repo === 'acme/web' ? 'acme/web' : undefined), list: async () => ['acme/web'] },
		confirmation,
		now: () => now,
		newId: () => 'id-1',
	});

	// Flue's tool runner validates input with the tool's schema; call run the same way the
	// attach_repo tests do (copy their helper if they have one).
	const run = (input: Record<string, unknown>) => tool.run({ data: input } as never);

	return { store, calls, run };
}

const weekdayDigest = {
	kind: 'agent',
	title: 'Merged PRs',
	prompt: "Post yesterday's merged PRs.",
	schedule: '0 9 * * 1-5',
	scope: 'channel',
};

describe('draft_automation', () => {
	test('drafts with the owner timezone and the conversation repo, and posts the card', async () => {
		const { store, calls, run } = await setup();

		const result = await run(weekdayDigest);

		expect(result).toMatchObject({ output: { status: 'awaiting_confirmation', draftId: 'id-1' } });
		expect(await store.drafts.get('id-1')).toMatchObject({
			draftedBy: 'U_OWNER',
			timezone: 'Asia/Kolkata',
			destinationChannelId: 'C_ENG',
			repo: 'https://github.com/acme/api.git',
			cardTs: '200.1',
		});

		const card = calls.find((call) => call.method === 'chat.postMessage');

		expect(card?.params.thread_ts).toBe('1.0');
		expect(JSON.stringify(card?.params.blocks)).toContain('Weekdays at 09:00 IST');
		expect(await store.automations.get('id-1')).toBeUndefined();
	});

	test('a personal automation goes to the owner DM; a named repo is checked', async () => {
		const { store, run } = await setup();

		await run({ ...weekdayDigest, scope: 'personal', repo: 'acme/web' });

		expect(await store.drafts.get('id-1')).toMatchObject({
			destinationChannelId: 'D_OWNER',
			repo: 'https://github.com/acme/web.git',
		});
		await expect(run({ ...weekdayDigest, repo: 'acme/secret' })).rejects.toThrow(/cannot access/);
	});

	test('with confirmation off it creates the automation directly', async () => {
		const { store, calls, run } = await setup({ confirmation: false });

		expect(await run(weekdayDigest)).toMatchObject({ output: { status: 'created', automationId: 'id-1' } });
		expect(await store.automations.get('id-1')).toMatchObject({ status: 'active', nextRunAt: '2026-10-14T03:30:00.000Z' });
		expect(JSON.stringify(calls.at(-1)?.params.blocks)).toContain('Created · next run');
	});

	test('refuses a channel automation from a DM', async () => {
		const { run } = await setup({ channelId: 'D_OWNER' });

		await expect(run(weekdayDigest)).rejects.toThrow(/channel it posts to/);
	});

	test('refuses a run_at without a UTC offset, and both or neither schedule', async () => {
		const { run } = await setup();
		const once = { ...weekdayDigest, schedule: undefined };

		await expect(run({ ...once, run_at: '2026-10-15T18:00' })).rejects.toThrow();
		await expect(run({ ...once })).rejects.toThrow(/exactly one/);
		await expect(run({ ...weekdayDigest, run_at: '2026-10-15T18:00:00+05:30' })).rejects.toThrow(/exactly one/);
	});

	test('refuses when nobody is known to have asked', async () => {
		const { run } = await setup({ owner: '' });

		await expect(run(weekdayDigest)).rejects.toThrow(/who asked/);
	});
});

describe('deliverySender', () => {
	test('reads userId from a signal, not from a reminder', () => {
		expect(deliverySender({ kind: 'signal', type: 'slack.app_mention', body: 'x', attributes: { userId: 'U1' } } as never)).toBe('U1');
		expect(deliverySender({ kind: 'signal', type: 'reminder', body: 'x' } as never)).toBeUndefined();
		expect(deliverySender({ kind: 'user', body: 'x' } as never)).toBeUndefined();
	});
});
```

Before writing `run`, check how `src/agents/attach-repo.test.ts` invokes a tool. Use the same call shape; the `as never` above is a placeholder for that shape. In `coworker.test.ts`, extend the `hasSuccessfulSlackReply` test:

```ts
		expect(hasSuccessfulSlackReply([{ tool: 'draft_automation', isError: false }])).toBe(true);
		expect(hasSuccessfulSlackReply([{ tool: 'draft_automation', isError: true }])).toBe(false);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/agents/automation-tools.test.ts src/agents/coworker.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `src/automations/slack-people.ts`:

```ts
// The user's Slack timezone (needs `users:read`); UTC when Slack has none.
export async function ownerTimezone({ slack, userId }: { slack: SlackBotClient; userId: string }): Promise<string> {
	const { user } = await slack.users.info({ user: userId });

	return user?.tz || 'UTC';
}

// Slack DM channel ids start with D.
export function isDirectMessageChannel(channelId: string): boolean {
	return channelId.startsWith('D');
}
```

In `src/config.ts`:

```ts
// When true, draft_automation posts a card and nothing runs until the person
// who asked presses Create. When false, it creates the automation at once
// with the same validation (docs/superpowers/specs/2026-10-13-scheduled-automations-design.md).
export const automationConfirmation = true;
```

```ts
// src/agents/automation-tools.ts
import { defineTool, type DeliveredMessage, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import type { AutomationFields, AutomationStore } from '../automations/automation.ts';
import { automationCard } from '../automations/blocks.ts';
import { fieldsError, PROMPT_MAX, TITLE_MAX } from '../automations/fields.ts';
import { nextRunAfter } from '../automations/schedule.ts';
import { isDirectMessageChannel, openDirectMessage, ownerTimezone } from '../automations/slack-people.ts';
import type { SlackBotClient } from '../channels/slack-reply.ts';
import { errorMessage } from '../json.ts';
import { type RepoDirectory, resolveInstallationRepo } from './attach-repo.ts';

export const AUTOMATION_REPLY_TOOLS: ReadonlySet<string> = new Set(['draft_automation']);

// The Slack user behind a delivery, from attributes ingress set. Appended
// reminders and `flue run` messages carry none.
export function deliverySender(delivery: DeliveredMessage): string | undefined {
	if (delivery.kind !== 'signal') return undefined;

	const userId = delivery.attributes?.userId;

	return typeof userId === 'string' && userId ? userId : undefined;
}

// An instant with an explicit offset, so a bare local time is never read as UTC.
const runAtSchema = v.pipe(
	v.string(),
	v.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/, 'Give run_at as ISO 8601 with a UTC offset, e.g. 2026-10-15T18:00:00+05:30.'),
	v.check((value) => !Number.isNaN(Date.parse(value)), 'run_at is not a valid instant.'),
);

const inputSchema = v.object({
	kind: v.picklist(['agent', 'reminder']),
	title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(TITLE_MAX)),
	prompt: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(PROMPT_MAX)),
	schedule: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
	run_at: v.optional(runAtSchema),
	scope: v.picklist(['personal', 'channel']),
	repo: v.optional(v.pipe(v.string(), v.minLength(1))),
});

export function draftAutomationTool({
	owner,
	channelId,
	threadTs,
	conversationRepo,
	store,
	slack,
	directory,
	confirmation,
	now = () => new Date(),
	newId = () => crypto.randomUUID(),
}: {
	owner: string | undefined;
	channelId: string;
	threadTs: string;
	conversationRepo: string | undefined;
	store: AutomationStore;
	slack: SlackBotClient;
	directory: RepoDirectory;
	confirmation: boolean;
	now?: () => Date;
	newId?: () => string;
}): ToolDefinition {
	return defineTool({
		name: 'draft_automation',
		description: [
			'Propose a scheduled automation for the person who asked: kind "agent" runs you on the instruction each time, kind "reminder" posts the text as-is.',
			'Give exactly one of schedule (a five-field cron pattern in their local time, e.g. "0 9 * * 1-5") or run_at (one instant, ISO 8601 with their UTC offset).',
			'scope "personal" delivers to their DM; "channel" posts in this channel. repo defaults to this conversation\'s repository.',
			confirmation
				? 'This posts a confirmation card; nothing is created until they press Create. Tell them to review it.'
				: 'This creates the automation and posts its card.',
			'You cannot list, edit, pause or delete automations; people do that with the card buttons and /aiyappa automations.',
		].join(' '),
		input: inputSchema,
		async run({ data }) {
			if (!owner) {
				throw new Error('I cannot tell who asked for this automation. Ask them to repeat the request in a new message.');
			}

			if ((data.schedule === undefined) === (data.run_at === undefined)) {
				throw new Error('Give exactly one of schedule (cron) or run_at (one instant).');
			}

			if (data.scope === 'channel' && isDirectMessageChannel(channelId)) {
				throw new Error('A channel automation is created in the channel it posts to. Use scope "personal" here, or ask in that channel.');
			}

			const timezone = await ownerTimezone({ slack, userId: owner });
			const destinationChannelId = data.scope === 'personal' ? await openDirectMessage({ slack, userId: owner }) : channelId;

			const repo =
				data.kind !== 'agent'
					? undefined
					: data.repo
						? await resolveInstallationRepo({ directory, input: data.repo })
						: conversationRepo;

			const fields: AutomationFields = {
				kind: data.kind,
				title: data.title,
				prompt: data.prompt,
				scope: data.scope,
				destinationChannelId,
				repo,
				schedule: data.schedule ? { kind: 'recurring', cron: data.schedule } : { kind: 'once', runAt: new Date(data.run_at ?? '').toISOString() },
				timezone,
			};

			const at = now();
			const problem = fieldsError({ fields, now: at });

			if (problem) throw new Error(problem.message);

			const id = newId();

			if (confirmation) {
				await store.drafts.create({ ...fields, id, draftedBy: owner, channelId, threadTs, createdAt: at.toISOString() });

				const posted = await slack.chat.postMessage({
					channel: channelId,
					thread_ts: threadTs,
					...automationCard({ fields, owner, state: { kind: 'draft', draftId: id }, now: at }),
				});

				if (posted.ts) await store.drafts.setCardTs({ id, cardTs: posted.ts });

				return { output: { status: 'awaiting_confirmation', draftId: id } };
			}

			const nextRunAt = nextRunAfter(fields.schedule, timezone, at);

			if (!nextRunAt) throw new Error('That schedule has no future run.');

			const automation = await store.automations.create({
				...fields,
				id,
				ownerUserId: owner,
				nextRunAt,
				createdAt: at.toISOString(),
			});

			// Created either way; a lost card must not make the model create it twice.
			try {
				await slack.chat.postMessage({
					channel: channelId,
					thread_ts: threadTs,
					...automationCard({ fields, owner, state: { kind: 'created', automation }, now: at }),
				});
			} catch (error) {
				return { output: { status: 'created', automationId: id, nextRunAt, posted: false, error: errorMessage(error) } };
			}

			return { output: { status: 'created', automationId: id, nextRunAt } };
		},
	});
}
```

In `src/agents/coworker.ts`:

1. Imports: `automationStore`, `draftAutomationTool`, `deliverySender`, `AUTOMATION_REPLY_TOOLS`, `automationConfirmation`, `getSlackClient`.
2. After `useTool(replyInThread(...))`:

```ts
	// Who asked: the sender of the current delivery, or the last Slack sender
	// when the current delivery is an appended reminder. Never model input.
	const [requester, setRequester] = usePersistentState<string | null>('requester', null);
	const sender = deliverySender(delivery);

	useAgentStart(() => {
		if (sender) setRequester(sender);
	});

	const automations = automationStore();

	if (automations && agentEnv.SLACK_BOT_TOKEN && mountsDraftAutomation(data)) {
		useTool(
			draftAutomationTool({
				owner: sender ?? requester ?? undefined,
				channelId: data.channelId,
				threadTs: data.threadTs,
				conversationRepo: repo,
				store: automations,
				slack: getSlackClient(agentEnv.SLACK_BOT_TOKEN),
				directory: installationRepos,
				confirmation: automationConfirmation,
			}),
		);
	}
```

`repo` is declared above this point. Move this block below the `repo` declaration if it is not.

3. `hasSuccessfulSlackReply`: add `|| AUTOMATION_REPLY_TOOLS.has(call.tool)` to the condition.

4. Add and export the gate. The repo has no Coworker render harness, so the spec's "absent in automation runs" check is a test of this function:

```ts
// Automation runs cannot create automations, including rescheduling themselves.
export function mountsDraftAutomation(data: { automationId?: string }): boolean {
	return !data.automationId;
}
```

and in `src/agents/coworker.test.ts`:

```ts
describe('mountsDraftAutomation', () => {
	test('is off in a conversation an automation fire started', () => {
		expect(mountsDraftAutomation({})).toBe(true);
		expect(mountsDraftAutomation({ automationId: 'a1' })).toBe(false);
	});
});
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/agents`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents src/automations/slack-people.ts src/config.ts
git commit -m "Let the Coworker draft automations for the person who asked"
```

### Task 8: Create and Cancel from the card

**Files:**
- Create: `src/channels/automation-interactions.ts`
- Modify: `src/channels/slack.ts` (route automation interactions; 5th parameter `automations?: AutomationStore`)
- Modify: `src/app.ts` (pass `createD1AutomationStore(c.env.APP_DB)`)
- Test: `src/channels/automation-interactions.test.ts`

**Interfaces:**
- Consumes: `AUTOMATION_ACTION`, `parseButtonValue`, `automationCard` (Tasks 4, 6); `nextRunAfter` (Task 1); `workspaceTeamId` (Task 5).
- Produces:

```ts
export type AutomationInteractionDeps = {
	store: AutomationStore;
	slack: SlackBotClient;
	workspaceTeam(): Promise<string>;
	defer(work: Promise<void>): Promise<void>;
	now(): Date;
	newId(): string;
};
export type SubmissionErrors = { response_action: 'errors'; errors: Record<string, string> };
export function isAutomationInteraction(payload: SlackInteractionPayload): boolean;
export function handleAutomationInteraction(payload: SlackInteractionPayload, deps: AutomationInteractionDeps): Promise<undefined | SubmissionErrors>;
export function redrawDraftCard({ draftId, deps }): Promise<void>;
// Payload readers reused by Tasks 9–10:
export function channelOf(payload: SlackBlockActionsPayload): string | undefined;
export function messageTsOf(payload: SlackBlockActionsPayload): string | undefined;
export function tellUser({ payload, text, deps }): Promise<void>;
```

- [ ] **Step 1: Write the failing test**

```ts
// src/channels/automation-interactions.test.ts
import type { SlackInteractionPayload } from '@flue/slack';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AutomationFields, AutomationStore } from '../automations/automation.ts';
import { AUTOMATION_ACTION, buttonValue } from '../automations/blocks.ts';
import { createD1AutomationStore } from '../automations/d1-automation-store.ts';
import { openTestDatabase } from '../testing/d1.ts';
import { type AutomationInteractionDeps, handleAutomationInteraction, isAutomationInteraction } from './automation-interactions.ts';
import { __resetSlackClientForTests, getSlackClient } from './slack-reply.ts';
import { stubSlackApi } from './testing/slack-api-stub.ts';

const HOME = 'T_HOME';

const NOW = new Date('2026-10-14T03:00:00.000Z');

const fields: AutomationFields = {
	kind: 'agent',
	title: 'Merged PRs',
	prompt: "Post yesterday's merged PRs.",
	scope: 'channel',
	destinationChannelId: 'C_ENG',
	schedule: { kind: 'recurring', cron: '0 9 * * 1-5' },
	timezone: 'Asia/Kolkata',
};

type User = { id: string; team_id?: string };

const drafter: User = { id: 'U_OWNER', team_id: HOME };

export function click(actionId: string, value: string, user: User = drafter, channelId = 'C_ENG'): SlackInteractionPayload {
	return {
		type: 'block_actions',
		team: { id: HOME },
		user,
		api_app_id: 'A1',
		trigger_id: 'trigger-1',
		container: { type: 'message', message_ts: '200.1', channel_id: channelId },
		channel: { id: channelId },
		message: { ts: '200.1' },
		actions: [{ type: 'button', action_id: actionId, value }],
	};
}

async function setup(now = NOW) {
	const store: AutomationStore = createD1AutomationStore(await openTestDatabase());
	const calls = stubSlackApi();

	const deps: AutomationInteractionDeps = {
		store,
		slack: getSlackClient('xoxb-test'),
		workspaceTeam: async () => HOME,
		defer: (work) => work,
		now: () => now,
		newId: () => 'a1',
	};

	await store.drafts.create({ ...fields, id: 'd1', draftedBy: 'U_OWNER', channelId: 'C_ENG', threadTs: '1.0', createdAt: NOW.toISOString() });
	await store.drafts.setCardTs({ id: 'd1', cardTs: '200.1' });

	return { store, calls, deps };
}

afterEach(() => {
	vi.unstubAllGlobals();
	__resetSlackClientForTests();
});

const createClick = click(AUTOMATION_ACTION.create, buttonValue('d1', 'card'));

describe('Create', () => {
	test('the drafter creates it once; the card redraws as created', async () => {
		const { store, calls, deps } = await setup();

		expect(isAutomationInteraction(createClick)).toBe(true);

		await handleAutomationInteraction(createClick, deps);
		await handleAutomationInteraction(createClick, deps);

		expect(await store.automations.get('a1')).toMatchObject({ status: 'active', ownerUserId: 'U_OWNER', nextRunAt: '2026-10-14T03:30:00.000Z' });

		const updates = calls.filter((call) => call.method === 'chat.update');

		expect(updates.at(-1)?.params.ts).toBe('200.1');
		expect(JSON.stringify(updates.at(-1)?.params.blocks)).toContain('Created · next run');
	});

	test('someone else cannot create it', async () => {
		const { store, calls, deps } = await setup();

		await handleAutomationInteraction(click(AUTOMATION_ACTION.create, buttonValue('d1', 'card'), { id: 'U_OTHER', team_id: HOME }), deps);

		expect(await store.automations.get('a1')).toBeUndefined();
		expect(calls.find((call) => call.method === 'chat.postEphemeral')?.params.text).toMatch(/Only <@U_OWNER>/);
	});

	test('an external user is refused', async () => {
		const { store, deps } = await setup();

		await handleAutomationInteraction(click(AUTOMATION_ACTION.create, buttonValue('d1', 'card'), { id: 'U_OWNER', team_id: 'T_OTHER' }), deps);

		expect(await store.automations.get('a1')).toBeUndefined();
	});

	test('a one-off whose time passed before Create is refused and stays a draft', async () => {
		const { store, calls, deps } = await setup(new Date('2026-10-16T00:00:00.000Z'));

		await store.drafts.update({ id: 'd1', fields: { ...fields, schedule: { kind: 'once', runAt: '2026-10-15T12:30:00.000Z' } }, at: NOW.toISOString() });
		await handleAutomationInteraction(createClick, deps);

		expect(await store.automations.get('a1')).toBeUndefined();
		expect((await store.drafts.get('d1'))?.consumedAt).toBeUndefined();
		expect(calls.find((call) => call.method === 'chat.postEphemeral')?.params.text).toMatch(/passed.*Edit/);
	});
});

describe('Cancel', () => {
	test('consumes the draft and redraws the card as cancelled', async () => {
		const { store, calls, deps } = await setup();

		await handleAutomationInteraction(click(AUTOMATION_ACTION.cancel, buttonValue('d1', 'card')), deps);

		expect((await store.drafts.get('d1'))?.consumedAt).toBeDefined();
		expect(JSON.stringify(calls.find((call) => call.method === 'chat.update')?.params.blocks)).toContain('Cancelled');
		await handleAutomationInteraction(createClick, deps);
		expect(await store.automations.get('a1')).toBeUndefined();
	});
});
```

(The `click` helper is exported so Tasks 9–10 can import it. If lint forbids exports from test files, move it to `src/channels/testing/automation-clicks.ts`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/channels/automation-interactions.test.ts`
Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Implement the handler**

```ts
// src/channels/automation-interactions.ts
import type { SlackBlockActionsPayload, SlackInteractionPayload, SlackUser } from '@flue/slack';
import * as v from 'valibot';
import type { AutomationStore } from '../automations/automation.ts';
import { AUTOMATION_ACTION, AUTOMATION_MODAL, automationCard, type CardState, parseButtonValue } from '../automations/blocks.ts';
import { nextRunAfter } from '../automations/schedule.ts';
import { errorMessage } from '../json.ts';
import type { SlackBotClient } from './slack-reply.ts';

export type AutomationInteractionDeps = {
	store: AutomationStore;
	slack: SlackBotClient;
	workspaceTeam(): Promise<string>;
	// Runs after the response when the platform allows it (waitUntil); tests await it.
	defer(work: Promise<void>): Promise<void>;
	now(): Date;
	newId(): string;
};

export type SubmissionErrors = { response_action: 'errors'; errors: Record<string, string> };

const NOT_A_MEMBER = 'Yappa only works for members of this workspace.';

const ACTION_IDS: ReadonlySet<string> = new Set(Object.values(AUTOMATION_ACTION));

const idSchema = v.object({ id: v.string() });

const messageSchema = v.object({ ts: v.string() });

export function isAutomationInteraction(payload: SlackInteractionPayload): boolean {
	if (payload.type === 'block_actions') return payload.actions.some((action) => ACTION_IDS.has(action.action_id));

	if (payload.type === 'view_submission') return payload.view.callback_id === AUTOMATION_MODAL;

	return false;
}

export function channelOf(payload: SlackBlockActionsPayload): string | undefined {
	const parsed = v.safeParse(idSchema, payload.channel);

	return parsed.success ? parsed.output.id : undefined;
}

export function messageTsOf(payload: SlackBlockActionsPayload): string | undefined {
	const parsed = v.safeParse(messageSchema, payload.message);

	return parsed.success ? parsed.output.ts : undefined;
}

export async function isWorkspaceMember({ user, deps }: { user: SlackUser; deps: AutomationInteractionDeps }): Promise<boolean> {
	return Boolean(user.team_id) && user.team_id === (await deps.workspaceTeam());
}

// An ephemeral reply where the button was; best effort.
export async function tellUser({
	payload,
	text,
	deps,
}: {
	payload: SlackBlockActionsPayload;
	text: string;
	deps: AutomationInteractionDeps;
}): Promise<void> {
	const channel = channelOf(payload);

	if (!channel) return;

	try {
		await deps.slack.chat.postEphemeral({ channel, user: payload.user.id, text });
	} catch (error) {
		console.warn(`[automations] Ephemeral reply failed: ${errorMessage(error)}`);
	}
}

export async function handleAutomationInteraction(
	payload: SlackInteractionPayload,
	deps: AutomationInteractionDeps,
): Promise<undefined | SubmissionErrors> {
	if (payload.type !== 'block_actions') return undefined;

	const action = payload.actions.find((candidate) => ACTION_IDS.has(candidate.action_id));
	const shown = action?.value ? parseButtonValue(action.value) : undefined;

	if (!action || !shown) return undefined;

	if (!(await isWorkspaceMember({ user: payload.user, deps }))) {
		await deps.defer(tellUser({ payload, text: NOT_A_MEMBER, deps }));

		return undefined;
	}

	switch (action.action_id) {
		case AUTOMATION_ACTION.create:
			await onCreate({ payload, draftId: shown.id, deps });

			return undefined;
		case AUTOMATION_ACTION.cancel:
			await onCancel({ payload, draftId: shown.id, deps });

			return undefined;
		default:
			return undefined;
	}
}

async function onCreate({ payload, draftId, deps }: { payload: SlackBlockActionsPayload; draftId: string; deps: AutomationInteractionDeps }) {
	const draft = await deps.store.drafts.get(draftId);

	if (!draft) return;

	if (payload.user.id !== draft.draftedBy) {
		await deps.defer(tellUser({ payload, text: `Only <@${draft.draftedBy}> can create this automation.`, deps }));

		return;
	}

	if (draft.consumedAt) {
		await deps.defer(redrawDraftCard({ draftId, deps }));

		return;
	}

	const now = deps.now();
	const nextRunAt = nextRunAfter(draft.schedule, draft.timezone, now);

	if (!nextRunAt) {
		await deps.defer(tellUser({ payload, text: 'That time has already passed. Press Edit to pick a new time, then Create.', deps }));

		return;
	}

	await deps.store.drafts.promote({ id: draftId, automationId: deps.newId(), nextRunAt, at: now.toISOString() });
	await deps.defer(redrawDraftCard({ draftId, deps }));
}

async function onCancel({ payload, draftId, deps }: { payload: SlackBlockActionsPayload; draftId: string; deps: AutomationInteractionDeps }) {
	const draft = await deps.store.drafts.get(draftId);

	if (!draft) return;

	if (payload.user.id !== draft.draftedBy) {
		await deps.defer(tellUser({ payload, text: `Only <@${draft.draftedBy}> can cancel this draft.`, deps }));

		return;
	}

	await deps.store.drafts.consume({ id: draftId, at: deps.now().toISOString() });
	await deps.defer(redrawDraftCard({ draftId, deps }));
}

// Draws the card from what is saved, so a stale or repeated click shows the truth.
export async function redrawDraftCard({ draftId, deps }: { draftId: string; deps: AutomationInteractionDeps }): Promise<void> {
	try {
		const draft = await deps.store.drafts.get(draftId);

		if (!draft?.cardTs) return;

		const automation = draft.automationId ? await deps.store.automations.get(draft.automationId) : undefined;

		const state: CardState = automation
			? { kind: 'created', automation }
			: draft.consumedAt
				? { kind: 'cancelled' }
				: { kind: 'draft', draftId };

		await deps.slack.chat.update({
			channel: draft.channelId,
			ts: draft.cardTs,
			...automationCard({ fields: automation ?? draft, owner: draft.draftedBy, state, now: deps.now() }),
		});
	} catch (error) {
		console.warn(`[automations] Card ${draftId} redraw failed: ${errorMessage(error)}`);
	}
}
```

- [ ] **Step 4: Wire it into the Slack channel and app**

In `src/channels/slack.ts`:

```ts
export function createSlackChannelForEnv(
	env: ServerEnv,
	codexAuth: () => CodexAuthControl,
	runtime: SlackRuntime = defaultSlackRuntime,
	planning?: PlanningStore,
	automations?: AutomationStore,
) {
```

Replace the `interactions:` option:

```ts
		interactions:
			planning || automations
				? ({ c, payload }) => {
						const defer = (work: Promise<void>): Promise<void> => {
							const executionCtx = executionContextOf(c);

							if (!executionCtx) return work;
							executionCtx.waitUntil(work);

							return Promise.resolve();
						};

						if (automations && isAutomationInteraction(payload)) {
							const slack = planningSlackClient(env.SLACK_BOT_TOKEN);

							return handleAutomationInteraction(payload, {
								store: automations,
								slack,
								workspaceTeam: () => workspaceTeamId(slack),
								defer,
								now: () => new Date(),
								newId: () => crypto.randomUUID(),
							});
						}

						if (!planning) return undefined;

						return handlePlanningInteraction(payload, {
							store: planning,
							slack: planningSlackClient(env.SLACK_BOT_TOKEN),
							workspaceTeamOf: (id) => channel.parseInstanceId(id).teamId,
							continueConversation: (continuation) =>
								continuePlanning({ channel, env, codexAuth, runtime, continuation }),
							defer,
							now: () => new Date(),
						});
					}
				: undefined,
```

In `src/app.ts`:

```ts
	const automations = c.env?.APP_DB ? createD1AutomationStore(c.env.APP_DB) : undefined;
	const channel = createSlackChannelForEnv(env, () => codexAuth(c.env), undefined, planning, automations);
```

Add a test to `src/channels/slack.test.ts` beside the existing planning-interactions routing test. It posts a signed `automation_create` interaction to a channel built with an automation store and asserts the draft becomes an automation. Copy the signing helper that test file already uses.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run src/channels src/app.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify the batch and commit**

Run: `pnpm test && pnpm run check:types && pnpm run lint && pnpm run fmt:check`

```bash
git add src/channels src/app.ts
git commit -m "Create or cancel a drafted automation from its card"
```

**Stop: Batch 3 review.** Manual check: in a dev workspace, ask "every weekday at 9am post merged PRs in acme/api here". The card should read "Weekdays at 09:00 IST", and Create should make it `active`.

---

## Batch 4: Managing

### Task 9: Pause, Resume, Run now, Delete

**Files:**
- Create: `src/automations/access.ts`
- Modify: `src/channels/automation-interactions.ts`
- Modify: `src/channels/slack.ts` (deps gain `runNow`)
- Test: `src/automations/access.test.ts`, `src/channels/automation-interactions.test.ts`

**Interfaces:**
- Produces:
  - `type ManageAction = 'pause' | 'resume' | 'runNow' | 'edit' | 'delete'`, `mayManage({ action, automation, userId, channelId }): boolean`
  - `AutomationInteractionDeps.runNow(automation: Automation): Promise<void>`

- [ ] **Step 1: Write the failing tests**

```ts
// src/automations/access.test.ts
import { describe, expect, test } from 'vitest';
import { mayManage } from './access.ts';

const channelAutomation = { ownerUserId: 'U_OWNER', scope: 'channel', destinationChannelId: 'C_ENG' } as const;

const personal = { ownerUserId: 'U_OWNER', scope: 'personal', destinationChannelId: 'D_OWNER' } as const;

describe('mayManage', () => {
	test('the owner may do everything', () => {
		for (const action of ['pause', 'resume', 'runNow', 'edit', 'delete'] as const) {
			expect(mayManage({ action, automation: personal, userId: 'U_OWNER', channelId: 'anywhere' })).toBe(true);
		}
	});

	test('a member in the destination channel may pause, resume and run a channel automation', () => {
		const member = { automation: channelAutomation, userId: 'U_MEMBER', channelId: 'C_ENG' };

		expect(mayManage({ ...member, action: 'pause' })).toBe(true);
		expect(mayManage({ ...member, action: 'resume' })).toBe(true);
		expect(mayManage({ ...member, action: 'runNow' })).toBe(true);
		expect(mayManage({ ...member, action: 'edit' })).toBe(false);
		expect(mayManage({ ...member, action: 'delete' })).toBe(false);
	});

	test('nobody else may do anything', () => {
		expect(mayManage({ action: 'pause', automation: channelAutomation, userId: 'U_MEMBER', channelId: 'C_OTHER' })).toBe(false);
		expect(mayManage({ action: 'pause', automation: personal, userId: 'U_MEMBER', channelId: 'D_OWNER' })).toBe(false);
	});
});
```

Append to `src/channels/automation-interactions.test.ts` (reuse `setup` and `click`). Seed an automation with `store.automations.create({...fields, id: 'a1', ownerUserId: 'U_OWNER', nextRunAt: '2026-10-14T03:30:00.000Z', createdAt: NOW.toISOString()})` and add `runs: [] as string[]` and `runNow: async (automation) => { runs.push(automation.id); }` to `deps`.

```ts
describe('managing', () => {
	test('a channel member pauses from the header; the header redraws with Resume', async () => {
		const { store, calls, deps } = await seeded();

		await handleAutomationInteraction(click(AUTOMATION_ACTION.pause, buttonValue('a1', 'header'), { id: 'U_MEMBER', team_id: HOME }), deps);

		expect((await store.automations.get('a1'))?.status).toBe('paused');

		const update = calls.find((call) => call.method === 'chat.update');

		expect(update?.params.ts).toBe('200.1');
		expect(JSON.stringify(update?.params.blocks)).toContain(AUTOMATION_ACTION.resume);
	});

	test('a non-owner cannot delete', async () => {
		const { store, calls, deps } = await seeded();

		await handleAutomationInteraction(click(AUTOMATION_ACTION.delete, buttonValue('a1', 'list'), { id: 'U_MEMBER', team_id: HOME }), deps);

		expect((await store.automations.get('a1'))?.status).toBe('active');
		expect(calls.find((call) => call.method === 'chat.postEphemeral')?.params.text).toMatch(/Only <@U_OWNER>/);
	});

	test('resume recomputes the next run from now; delete is soft', async () => {
		const { store, deps } = await seeded();

		await store.automations.setStatus({ id: 'a1', status: 'paused', at: NOW.toISOString() });
		await handleAutomationInteraction(click(AUTOMATION_ACTION.resume, buttonValue('a1', 'list')), { ...deps, now: () => new Date('2026-10-16T05:00:00.000Z') });

		expect(await store.automations.get('a1')).toMatchObject({ status: 'active', nextRunAt: '2026-10-19T03:30:00.000Z' });

		await handleAutomationInteraction(click(AUTOMATION_ACTION.delete, buttonValue('a1', 'list')), deps);

		expect((await store.automations.get('a1'))?.status).toBe('deleted');
	});

	test('resuming a one-off whose time passed leaves it paused and says to edit', async () => {
		const { store, calls, deps } = await seeded({ schedule: { kind: 'once', runAt: '2026-10-14T12:30:00.000Z' }, nextRunAt: '2026-10-14T12:30:00.000Z' });

		await store.automations.setStatus({ id: 'a1', status: 'paused', at: NOW.toISOString() });
		await handleAutomationInteraction(click(AUTOMATION_ACTION.resume, buttonValue('a1', 'list')), { ...deps, now: () => new Date('2026-10-15T00:00:00.000Z') });

		expect((await store.automations.get('a1'))?.status).toBe('paused');
		expect(calls.find((call) => call.method === 'chat.postEphemeral')?.params.text).toMatch(/passed.*Edit/);
	});

	test('resuming a blocked automation re-checks the owner', async () => {
		const { store, deps } = await seeded({}, { ownerDeleted: true });

		await store.automations.setStatus({ id: 'a1', status: 'blocked', at: NOW.toISOString() });
		await handleAutomationInteraction(click(AUTOMATION_ACTION.resume, buttonValue('a1', 'list')), deps);

		expect((await store.automations.get('a1'))?.status).toBe('blocked');
	});

	test('run now dispatches a fire for a channel member', async () => {
		const { runs, deps } = await seeded();

		await handleAutomationInteraction(click(AUTOMATION_ACTION.runNow, buttonValue('a1', 'list'), { id: 'U_MEMBER', team_id: HOME }), deps);

		expect(runs).toEqual(['a1']);
	});
});
```

Write `seeded(overrides = {}, { ownerDeleted = false } = {})` in the test file. It calls `setup()`, creates the automation with `overrides`, and re-stubs Slack with a responder whose `users.info` returns `{ ok: true, user: { id: 'U_OWNER', deleted: ownerDeleted } }`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/automations/access.test.ts src/channels/automation-interactions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/automations/access.ts
import type { Automation } from './automation.ts';

export type ManageAction = 'pause' | 'resume' | 'runNow' | 'edit' | 'delete';

// The spec's authorization table. "Channel member" means the click came from
// the automation's destination channel: only members can see its header there.
export function mayManage({
	action,
	automation,
	userId,
	channelId,
}: {
	action: ManageAction;
	automation: Pick<Automation, 'ownerUserId' | 'scope' | 'destinationChannelId'>;
	userId: string;
	channelId: string | undefined;
}): boolean {
	if (userId === automation.ownerUserId) return true;

	if (automation.scope !== 'channel' || channelId !== automation.destinationChannelId) return false;

	return action === 'pause' || action === 'resume' || action === 'runNow';
}
```

In `src/channels/automation-interactions.ts`:

- add `runNow(automation: Automation): Promise<void>;` to `AutomationInteractionDeps`;
- add to the action switch:

```ts
		case AUTOMATION_ACTION.pause:
		case AUTOMATION_ACTION.resume:
		case AUTOMATION_ACTION.runNow:
		case AUTOMATION_ACTION.delete:
			await onManage({ payload, actionId: action.action_id, shown, deps });

			return undefined;
```

- add:

```ts
const MANAGE_ACTIONS = {
	[AUTOMATION_ACTION.pause]: 'pause',
	[AUTOMATION_ACTION.resume]: 'resume',
	[AUTOMATION_ACTION.runNow]: 'runNow',
	[AUTOMATION_ACTION.edit]: 'edit',
	[AUTOMATION_ACTION.delete]: 'delete',
} as const satisfies Record<string, ManageAction>;

function refusal({ action, automation }: { action: ManageAction; automation: Automation }): string {
	return action === 'edit' || action === 'delete' || automation.scope === 'personal'
		? `Only <@${automation.ownerUserId}> can ${action === 'runNow' ? 'run' : action} this automation.`
		: `Use the buttons in <#${automation.destinationChannelId}> to manage this automation.`;
}

async function onManage({
	payload,
	actionId,
	shown,
	deps,
}: {
	payload: SlackBlockActionsPayload;
	actionId: keyof typeof MANAGE_ACTIONS;
	shown: { id: string; surface: Surface };
	deps: AutomationInteractionDeps;
}): Promise<void> {
	const action = MANAGE_ACTIONS[actionId];
	const automation = await deps.store.automations.get(shown.id);

	if (!automation || automation.status === 'deleted') {
		await deps.defer(tellUser({ payload, text: 'This automation was deleted.', deps }));

		return;
	}

	if (!mayManage({ action, automation, userId: payload.user.id, channelId: channelOf(payload) })) {
		await deps.defer(tellUser({ payload, text: refusal({ action, automation }), deps }));

		return;
	}

	const now = deps.now();
	const at = now.toISOString();

	switch (action) {
		case 'pause': {
			const paused =
				automation.status === 'active'
					? await deps.store.automations.setStatus({ id: automation.id, status: 'paused', at })
					: automation;

			await deps.defer(respond({ payload, surface: shown.surface, automation: paused ?? automation, text: `Paused *${automation.title}*.`, deps }));

			return;
		}

		case 'resume': {
			if (automation.status === 'blocked') {
				const gone = await ownerGoneReason({ slack: deps.slack, userId: automation.ownerUserId });

				if (gone) {
					await deps.defer(tellUser({ payload, text: `It stays blocked. ${gone}`, deps }));

					return;
				}
			}

			const nextRunAt = nextRunAfter(automation.schedule, automation.timezone, now);

			if (!nextRunAt) {
				await deps.defer(tellUser({ payload, text: 'Its one-off time has passed. Press Edit to pick a new time.', deps }));

				return;
			}

			const resumed = await deps.store.automations.setStatus({ id: automation.id, status: 'active', nextRunAt, at });

			await deps.defer(
				respond({
					payload,
					surface: shown.surface,
					automation: resumed ?? automation,
					text: `Resumed *${automation.title}*. Next run ${formatRunTime(nextRunAt, automation.timezone)}.`,
					deps,
				}),
			);

			return;
		}

		case 'runNow':
			await deps.defer(deps.runNow(automation));
			await deps.defer(tellUser({ payload, text: `Running *${automation.title}* now.`, deps }));

			return;
		case 'delete': {
			const deleted = await deps.store.automations.setStatus({ id: automation.id, status: 'deleted', at });

			await deps.defer(respond({ payload, surface: shown.surface, automation: deleted ?? automation, text: `Deleted *${automation.title}*.`, deps }));

			return;
		}

		case 'edit':
			return; // Task 10
		default: {
			const _exhaustive: never = action;

			return _exhaustive;
		}
	}
}

// Redraw the message the button was on, or reply in text for a list or DM.
async function respond({
	payload,
	surface,
	automation,
	text,
	deps,
}: {
	payload: SlackBlockActionsPayload;
	surface: Surface;
	automation: Automation;
	text: string;
	deps: AutomationInteractionDeps;
}): Promise<void> {
	const channel = channelOf(payload);
	const ts = messageTsOf(payload);

	if (surface === 'list' || !channel || !ts) {
		await tellUser({ payload, text, deps });

		return;
	}

	const rendered =
		surface === 'header'
			? runMessage(automation)
			: automationCard({ fields: automation, owner: automation.ownerUserId, state: { kind: 'created', automation }, now: deps.now() });

	try {
		await deps.slack.chat.update({ channel, ts, ...rendered });
	} catch (error) {
		console.warn(`[automations] Redraw of ${automation.id} failed: ${errorMessage(error)}`);
	}
}
```

Import `mayManage`, `ManageAction`, `ownerGoneReason`, `formatRunTime`, `runMessage`, `Surface`, and `Automation`.

In `src/channels/slack.ts`, add `runNow` to the automation deps:

```ts
								runNow: async (automation) => {
									await runNow({
										automation,
										deps: {
											store: automations,
											slack,
											now: () => new Date(),
											startRun: createStartRun({
												runtime,
												slack,
												instanceId: (thread) => channel.instanceId(thread),
												codexAuth,
												now: () => new Date(),
											}),
										},
									});
								},
```

(`SlackRuntime` satisfies `ConversationRuntime`.)

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/automations src/channels`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/automations/access.ts src/automations/access.test.ts src/channels
git commit -m "Pause, resume, run and delete automations with checked access"
```

### Task 10: The Edit modal and `/aiyappa automations new`

**Files:**
- Create: `src/automations/modal.ts`
- Modify: `src/channels/automation-interactions.ts` (Edit clicks and modal submission; deps gain `directory`)
- Modify: `src/channels/slash-command.ts` (`automations new`; third parameter)
- Modify: `src/channels/slack.ts` (pass `directory`; pass automation deps to `handleSlashCommand`)
- Test: `src/automations/modal.test.ts`, `src/channels/automation-interactions.test.ts`, `src/channels/slash-command.test.ts`

**Interfaces:**
- Produces:

```ts
export type ModalTarget =
	| { target: 'draft'; id: string }
	| { target: 'automation'; id: string; surface: Surface; channelId?: string; messageTs?: string }
	| { target: 'new'; channelId: string };
export type ModalForm = {
	kind: AutomationKind; title: string; prompt: string; schedule: Schedule; timezone: string;
	destination: { scope: 'personal' } | { scope: 'channel'; channelId: string };
	repo?: string; // as typed; resolved by the handler
	scheduleBlock: 'date' | 'time' | 'days' | 'cron';
};
export function automationModal({ target, fields, timezone }: { target: ModalTarget; fields?: AutomationFields; timezone: string }): ModalView;
export function parseAutomationModal(view: Record<string, unknown>): { ok: true; target: ModalTarget; form: ModalForm } | { ok: false; errors: Record<string, string> };
export type AutomationCommandDeps = { store: AutomationStore; slack: SlackBotClient; now(): Date };
```

Block ids equal action ids: `title`, `kind`, `prompt`, `preset`, `time`, `date`, `days`, `cron`, `timezone`, `destination`, `channel`, `repo`.

- [ ] **Step 1: Write the failing modal tests**

```ts
// src/automations/modal.test.ts
import { describe, expect, test } from 'vitest';
import type { AutomationFields } from './automation.ts';
import { automationModal, parseAutomationModal } from './modal.ts';

type Values = Record<string, Record<string, Record<string, unknown>>>;

function submitted(values: Values, metadata = JSON.stringify({ target: 'new', channelId: 'C_ENG' })) {
	return { private_metadata: metadata, state: { values } };
}

function value(id: string, input: Record<string, unknown>): Values {
	return { [id]: { [id]: input } };
}

const base: Values = {
	...value('title', { value: 'Digest' }),
	...value('kind', { selected_option: { value: 'agent' } }),
	...value('prompt', { value: 'AI news' }),
	...value('timezone', { value: 'Asia/Kolkata' }),
	...value('destination', { selected_option: { value: 'personal' } }),
};

describe('parseAutomationModal', () => {
	test('weekdays at a time becomes a cron pattern', () => {
		const parsed = parseAutomationModal(submitted({ ...base, ...value('preset', { selected_option: { value: 'weekdays' } }), ...value('time', { selected_time: '09:00' }) }));

		expect(parsed).toMatchObject({ ok: true, form: { schedule: { kind: 'recurring', cron: '0 9 * * 1-5' }, destination: { scope: 'personal' } } });
	});

	test('once converts the local date and time in the chosen zone', () => {
		const parsed = parseAutomationModal(
			submitted({ ...base, ...value('preset', { selected_option: { value: 'once' } }), ...value('date', { selected_date: '2026-10-15' }), ...value('time', { selected_time: '18:00' }) }),
		);

		expect(parsed).toMatchObject({ ok: true, form: { schedule: { kind: 'once', runAt: '2026-10-15T12:30:00.000Z' } } });
	});

	test('missing parts are inline errors on their blocks', () => {
		expect(parseAutomationModal(submitted({ ...base, ...value('preset', { selected_option: { value: 'weekly' } }), ...value('time', { selected_time: '09:00' }) }))).toEqual({
			ok: false,
			errors: { days: 'Pick at least one day.' },
		});
		expect(parseAutomationModal(submitted({ ...base, ...value('preset', { selected_option: { value: 'custom' } }) }))).toEqual({
			ok: false,
			errors: { cron: 'Enter a cron pattern.' },
		});
		expect(
			parseAutomationModal(
				submitted({ ...base, ...value('destination', { selected_option: { value: 'channel' } }), ...value('preset', { selected_option: { value: 'daily' } }), ...value('time', { selected_time: '09:00' }) }),
			),
		).toEqual({ ok: false, errors: { channel: 'Pick the channel to post in.' } });
	});
});

describe('automationModal', () => {
	test('prefills a weekly automation', () => {
		const fields: AutomationFields = {
			kind: 'agent',
			title: 'Digest',
			prompt: 'AI news',
			scope: 'channel',
			destinationChannelId: 'C_ENG',
			repo: 'https://github.com/acme/api.git',
			schedule: { kind: 'recurring', cron: '30 8 * * 1,4' },
			timezone: 'Asia/Kolkata',
		};

		const view = JSON.stringify(automationModal({ target: { target: 'automation', id: 'a1', surface: 'list' }, fields, timezone: 'UTC' }));

		expect(view).toContain('"initial_time":"08:30"');
		expect(view).toContain('"initial_conversation":"C_ENG"');
		expect(view).toContain('"initial_value":"acme/api"');
		expect(view).toContain('"value":"weekly"');
	});
});
```

Append interaction tests. Use `stubSlackApi` with `conversations.open` → `D_OWNER` and `views.open` → ok, and add `directory: { find: async (r) => (r === 'acme/api' ? 'acme/api' : undefined), list: async () => [] }` to `deps`. Build a `view_submission` payload from `{ type: 'view_submission', team: { id: HOME }, user: drafter, api_app_id: 'A1', view: { callback_id: AUTOMATION_MODAL, ...submitted(values, metadata) } }`.

```ts
describe('Edit', () => {
	test('Edit on a draft opens the prefilled modal for the drafter only', async () => {
		const { calls, deps } = await setup();

		await handleAutomationInteraction(click(AUTOMATION_ACTION.editDraft, buttonValue('d1', 'card'), { id: 'U_OTHER', team_id: HOME }), deps);
		expect(calls.some((call) => call.method === 'views.open')).toBe(false);

		await handleAutomationInteraction(click(AUTOMATION_ACTION.editDraft, buttonValue('d1', 'card')), deps);
		expect(JSON.stringify(calls.find((call) => call.method === 'views.open')?.params.view)).toContain('Merged PRs');
	});

	test('submitting for a draft updates it and redraws the card', async () => {
		const { store, calls, deps } = await setup();

		const errors = await handleAutomationInteraction(submission(weekdaysValues({ title: 'Renamed' }), { target: 'draft', id: 'd1' }), deps);

		expect(errors).toBeUndefined();
		expect((await store.drafts.get('d1'))?.title).toBe('Renamed');
		expect(JSON.stringify(calls.find((call) => call.method === 'chat.update')?.params.blocks)).toContain('Renamed');
	});

	test('editing a completed one-off to a future time makes it active again', async () => {
		const { store, deps } = await seeded({ kind: 'reminder', schedule: { kind: 'once', runAt: '2026-10-13T12:30:00.000Z' }, nextRunAt: '2026-10-13T12:30:00.000Z' });

		await store.automations.advance({ id: 'a1', from: '2026-10-13T12:30:00.000Z', at: NOW.toISOString() });
		expect((await store.automations.get('a1'))?.status).toBe('completed');

		await handleAutomationInteraction(submission(onceValues({ date: '2026-10-20', time: '18:00' }), { target: 'automation', id: 'a1', surface: 'list' }), deps);

		expect(await store.automations.get('a1')).toMatchObject({ status: 'active', nextRunAt: '2026-10-20T12:30:00.000Z' });
	});

	test('a repo the installation cannot access is an inline error', async () => {
		const { deps } = await setup();

		expect(await handleAutomationInteraction(submission(weekdaysValues({ repo: 'acme/secret' }), { target: 'draft', id: 'd1' }), deps)).toMatchObject({
			response_action: 'errors',
			errors: { repo: expect.stringContaining('cannot access') },
		});
	});

	test('a new channel automation the bot cannot post to fails at submit', async () => {
		const { store, deps } = await setup();

		stubSlackApi(async (call) => (call.method === 'chat.postMessage' ? { ok: false, error: 'not_in_channel' } : { ok: true }));

		const errors = await handleAutomationInteraction(submission(weekdaysValues({ channel: 'C_NEW' }), { target: 'new', channelId: 'C_NEW' }), deps);

		expect(errors).toMatchObject({ errors: { channel: expect.stringContaining('Invite') } });
		expect((await store.automations.get('a1'))?.status).toBe('deleted');
	});
});
```

Define `weekdaysValues(overrides)`, `onceValues({ date, time })`, and `submission(values, target)` in the test file with the `value(...)` helper. `weekdaysValues` sets channel destination `C_ENG` unless `channel` is given, kind `agent`, preset `weekdays`, time `09:00`, timezone `Asia/Kolkata`, and `repo` when given.

In `src/channels/slash-command.test.ts`, add:

```ts
	test('automations new opens the empty modal with the caller timezone', async () => {
		const calls = stubSlackApi(async (call) => (call.method === 'users.info' ? { ok: true, user: { id: 'U1', tz: 'Asia/Kolkata' } } : { ok: true }));

		const reply = await handleSlashCommand(payload('automations new'), codexAuth, {
			store: createD1AutomationStore(await openTestDatabase()),
			slack: getSlackClient('xoxb-test'),
			now: () => new Date('2026-10-14T03:00:00.000Z'),
		});

		expect(reply).toBeUndefined();
		expect(JSON.stringify(calls.find((call) => call.method === 'views.open')?.params.view)).toContain('"initial_value":"Asia/Kolkata"');
	});
```

(Use the existing `payload(text)` / `codexAuth` helpers in that file, or add them in its style.)

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/automations/modal.test.ts src/channels`
Expected: FAIL.

- [ ] **Step 3: Implement `modal.ts`**

```ts
// src/automations/modal.ts
import type { KnownBlock, ModalView, PlainTextOption } from '@slack/web-api';
import * as v from 'valibot';
import type { AutomationFields, AutomationKind } from './automation.ts';
import { AUTOMATION_MODAL, type Surface } from './blocks.ts';
import { PROMPT_MAX, TITLE_MAX } from './fields.ts';
import { isValidTimezone, presetCron, presetOf, type Schedule, wallTimeIn, zonedTimeToUtc } from './schedule.ts';
import { isDirectMessageChannel } from './slack-people.ts';

export type ModalTarget =
	| { target: 'draft'; id: string }
	| { target: 'automation'; id: string; surface: Surface; channelId?: string; messageTs?: string }
	| { target: 'new'; channelId: string };

export type ModalForm = {
	kind: AutomationKind;
	title: string;
	prompt: string;
	schedule: Schedule;
	timezone: string;
	destination: { scope: 'personal' } | { scope: 'channel'; channelId: string };
	repo?: string;
	scheduleBlock: 'date' | 'time' | 'days' | 'cron';
};

type PresetChoice = 'once' | 'daily' | 'weekdays' | 'weekly' | 'custom';

const targetSchema = v.pipe(
	v.string(),
	v.parseJson(),
	v.variant('target', [
		v.object({ target: v.literal('draft'), id: v.string() }),
		v.object({
			target: v.literal('automation'),
			id: v.string(),
			surface: v.picklist(['header', 'card', 'list']),
			channelId: v.optional(v.string()),
			messageTs: v.optional(v.string()),
		}),
		v.object({ target: v.literal('new'), channelId: v.string() }),
	]),
);

const inputValueSchema = v.object({
	value: v.nullish(v.string()),
	selected_option: v.nullish(v.object({ value: v.string() })),
	selected_options: v.nullish(v.array(v.object({ value: v.string() }))),
	selected_time: v.nullish(v.string()),
	selected_date: v.nullish(v.string()),
	selected_conversation: v.nullish(v.string()),
});

const viewSchema = v.object({
	private_metadata: v.string(),
	state: v.object({ values: v.record(v.string(), v.record(v.string(), inputValueSchema)) }),
});

const PRESETS: { value: PresetChoice; text: string }[] = [
	{ value: 'once', text: 'Once' },
	{ value: 'daily', text: 'Daily' },
	{ value: 'weekdays', text: 'Weekdays' },
	{ value: 'weekly', text: 'Weekly on…' },
	{ value: 'custom', text: 'Custom cron' },
];

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function option(value: string, text: string): PlainTextOption {
	return { value, text: { type: 'plain_text', text } };
}

function input({ id, label, element, optional = false, hint }: { id: string; label: string; element: KnownBlock extends never ? never : Record<string, unknown>; optional?: boolean; hint?: string }): KnownBlock {
	return {
		type: 'input',
		block_id: id,
		optional,
		label: { type: 'plain_text', text: label },
		element: { ...element, action_id: id },
		...(hint ? { hint: { type: 'plain_text', text: hint } } : {}),
	} as KnownBlock;
}

function repoName(url: string): string {
	return url.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
}

type Prefill = { preset: PresetChoice; time?: string; date?: string; days?: number[]; cron?: string };

function prefill(fields: AutomationFields | undefined): Prefill {
	if (!fields) return { preset: 'daily', time: '09:00' };

	const { schedule, timezone } = fields;

	if (schedule.kind === 'once') {
		const { date, time } = wallTimeIn(schedule.runAt, timezone);

		return { preset: 'once', date, time };
	}

	const preset = presetOf(schedule.cron);

	if (!preset) return { preset: 'custom', cron: schedule.cron };

	const time = `${String(preset.hour).padStart(2, '0')}:${String(preset.minute).padStart(2, '0')}`;

	return preset.preset === 'weekly' ? { preset: 'weekly', time, days: preset.days } : { preset: preset.preset, time };
}

export function automationModal({ target, fields, timezone }: { target: ModalTarget; fields?: AutomationFields; timezone: string }): ModalView {
	const shown = prefill(fields);
	const kind = fields?.kind ?? 'agent';
	const scope = fields?.scope ?? 'personal';

	const channel =
		fields?.scope === 'channel'
			? fields.destinationChannelId
			: target.target === 'new' && !isDirectMessageChannel(target.channelId)
				? target.channelId
				: undefined;

	const presetOption = PRESETS.find((preset) => preset.value === shown.preset) ?? PRESETS[1]!;

	return {
		type: 'modal',
		callback_id: AUTOMATION_MODAL,
		private_metadata: JSON.stringify(target),
		title: { type: 'plain_text', text: fields ? 'Edit automation' : 'New automation' },
		submit: { type: 'plain_text', text: 'Save' },
		close: { type: 'plain_text', text: 'Cancel' },
		blocks: [
			input({ id: 'title', label: 'Title', element: { type: 'plain_text_input', max_length: TITLE_MAX, ...(fields ? { initial_value: fields.title } : {}) } }),
			input({
				id: 'kind',
				label: 'Kind',
				element: {
					type: 'radio_buttons',
					options: [option('agent', 'Agent run'), option('reminder', 'Reminder')],
					initial_option: kind === 'agent' ? option('agent', 'Agent run') : option('reminder', 'Reminder'),
				},
			}),
			input({ id: 'prompt', label: 'Instruction or reminder text', element: { type: 'plain_text_input', multiline: true, max_length: PROMPT_MAX, ...(fields ? { initial_value: fields.prompt } : {}) } }),
			input({ id: 'preset', label: 'Schedule', element: { type: 'static_select', options: PRESETS.map((preset) => option(preset.value, preset.text)), initial_option: option(presetOption.value, presetOption.text) } }),
			input({ id: 'time', label: 'Time', optional: true, hint: 'Every schedule except Custom cron', element: { type: 'timepicker', ...(shown.time ? { initial_time: shown.time } : {}) } }),
			input({ id: 'date', label: 'Date', optional: true, hint: 'For Once', element: { type: 'datepicker', ...(shown.date ? { initial_date: shown.date } : {}) } }),
			input({
				id: 'days',
				label: 'Days',
				optional: true,
				hint: 'For Weekly on…',
				element: {
					type: 'checkboxes',
					options: DAYS.map((day, index) => option(String(index), day)),
					...(shown.days && shown.days.length > 0 ? { initial_options: shown.days.map((day) => option(String(day), DAYS[day] ?? '')) } : {}),
				},
			}),
			input({ id: 'cron', label: 'Cron pattern', optional: true, hint: 'For Custom cron: minute hour day-of-month month day-of-week', element: { type: 'plain_text_input', ...(shown.cron ? { initial_value: shown.cron } : {}) } }),
			input({ id: 'timezone', label: 'Time zone', element: { type: 'plain_text_input', initial_value: fields?.timezone ?? timezone } }),
			input({
				id: 'destination',
				label: 'Deliver to',
				element: {
					type: 'radio_buttons',
					options: [option('personal', 'DM me'), option('channel', 'A channel')],
					initial_option: scope === 'personal' ? option('personal', 'DM me') : option('channel', 'A channel'),
				},
			}),
			input({
				id: 'channel',
				label: 'Channel',
				optional: true,
				hint: 'For "A channel". Yappa must be in it.',
				element: {
					type: 'conversations_select',
					filter: { include: ['public', 'private'], exclude_bot_users: true, exclude_external_shared_channels: true },
					...(channel ? { initial_conversation: channel } : {}),
				},
			}),
			input({ id: 'repo', label: 'Repository (agent runs)', optional: true, hint: 'owner/name', element: { type: 'plain_text_input', ...(fields?.repo ? { initial_value: repoName(fields.repo) } : {}) } }),
		],
	};
}

// `view` is the raw Slack payload; viewSchema parses it at this boundary.
export function parseAutomationModal(
	// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- raw Slack view payload
	view: Record<string, unknown>,
): { ok: true; target: ModalTarget; form: ModalForm } | { ok: false; errors: Record<string, string> } {
	const parsedView = v.safeParse(viewSchema, view);
	const target = parsedView.success ? v.safeParse(targetSchema, parsedView.output.private_metadata) : undefined;

	if (!parsedView.success || !target?.success) {
		return { ok: false, errors: { title: 'This form could not be read. Close it and try again.' } };
	}

	const values = parsedView.output.state.values;
	const read = (id: string) => values[id]?.[id];
	const text = (id: string) => read(id)?.value?.trim() || undefined;
	const choice = (id: string) => read(id)?.selected_option?.value;

	const kind = choice('kind') === 'reminder' ? 'reminder' : 'agent';
	const timezone = text('timezone') ?? '';
	const preset = (choice('preset') ?? 'daily') as PresetChoice;
	const time = read('time')?.selected_time ?? undefined;

	if (!isValidTimezone(timezone)) return { ok: false, errors: { timezone: `${timezone || 'That'} is not a time zone. Use an IANA name such as Asia/Kolkata.` } };

	let schedule: Schedule;
	let scheduleBlock: ModalForm['scheduleBlock'] = 'time';

	switch (preset) {
		case 'once': {
			const date = read('date')?.selected_date ?? undefined;

			if (!date) return { ok: false, errors: { date: 'Pick a date.' } };

			if (!time) return { ok: false, errors: { time: 'Pick a time.' } };

			schedule = { kind: 'once', runAt: zonedTimeToUtc(date, time, timezone) };
			scheduleBlock = 'date';
			break;
		}

		case 'daily':
		case 'weekdays':
		case 'weekly': {
			if (!time) return { ok: false, errors: { time: 'Pick a time.' } };

			const [hour = 0, minute = 0] = time.split(':').map(Number);

			if (preset === 'weekly') {
				const days = (read('days')?.selected_options ?? []).map((selected) => Number(selected.value));

				if (days.length === 0) return { ok: false, errors: { days: 'Pick at least one day.' } };

				schedule = { kind: 'recurring', cron: presetCron({ preset, hour, minute, days: days.toSorted((a, b) => a - b) }) };
			} else {
				schedule = { kind: 'recurring', cron: presetCron({ preset, hour, minute }) };
			}

			break;
		}

		case 'custom': {
			const cron = text('cron');

			if (!cron) return { ok: false, errors: { cron: 'Enter a cron pattern.' } };

			schedule = { kind: 'recurring', cron };
			scheduleBlock = 'cron';
			break;
		}

		default:
			return { ok: false, errors: { preset: 'Pick a schedule.' } };
	}

	const destinationChoice = choice('destination');
	const channelId = read('channel')?.selected_conversation ?? undefined;

	if (destinationChoice === 'channel' && !channelId) return { ok: false, errors: { channel: 'Pick the channel to post in.' } };

	return {
		ok: true,
		target: target.output,
		form: {
			kind,
			title: text('title') ?? '',
			prompt: text('prompt') ?? '',
			schedule,
			timezone,
			destination: destinationChoice === 'channel' && channelId ? { scope: 'channel', channelId } : { scope: 'personal' },
			repo: text('repo'),
			scheduleBlock,
		},
	};
}
```

Notes for the implementer:
- `input()`'s `element` parameter type above is a placeholder. Type it as the union of `@slack/web-api` input elements (`PlainTextInput | RadioButtons | StaticSelect | Timepicker | Datepicker | Checkboxes | ConversationsSelect`) and drop the `as KnownBlock` cast if the union typechecks.
- Replace the `as PresetChoice` cast with `v.safeParse(v.picklist([...]), …)`. Do the same for `kind`.

- [ ] **Step 4: Implement Edit and submission in the interactions handler**

In `src/channels/automation-interactions.ts`:

- deps gain `directory: RepoDirectory;`;
- `handleAutomationInteraction` handles `view_submission` first:

```ts
	if (payload.type === 'view_submission') {
		return payload.view.callback_id === AUTOMATION_MODAL ? onModalSubmit({ payload, deps }) : undefined;
	}
```

- the action switch gains:

```ts
		case AUTOMATION_ACTION.editDraft:
			await onEditDraft({ payload, draftId: shown.id, deps });

			return undefined;
		case AUTOMATION_ACTION.edit:
			await onEditAutomation({ payload, shown, deps });

			return undefined;
```

- add:

```ts
async function onEditDraft({ payload, draftId, deps }: { payload: SlackBlockActionsPayload; draftId: string; deps: AutomationInteractionDeps }) {
	const draft = await deps.store.drafts.get(draftId);

	if (!draft) return;

	if (payload.user.id !== draft.draftedBy || draft.consumedAt) {
		await deps.defer(tellUser({ payload, text: draft.consumedAt ? 'This draft was already created or cancelled.' : `Only <@${draft.draftedBy}> can edit this draft.`, deps }));

		return;
	}

	if (!payload.trigger_id) return;

	await deps.slack.views.open({
		trigger_id: payload.trigger_id,
		view: automationModal({ target: { target: 'draft', id: draftId }, fields: draft, timezone: draft.timezone }),
	});
}

async function onEditAutomation({ payload, shown, deps }: { payload: SlackBlockActionsPayload; shown: { id: string; surface: Surface }; deps: AutomationInteractionDeps }) {
	const automation = await deps.store.automations.get(shown.id);

	if (!automation || automation.status === 'deleted') {
		await deps.defer(tellUser({ payload, text: 'This automation was deleted.', deps }));

		return;
	}

	if (!mayManage({ action: 'edit', automation, userId: payload.user.id, channelId: channelOf(payload) })) {
		await deps.defer(tellUser({ payload, text: refusal({ action: 'edit', automation }), deps }));

		return;
	}

	if (!payload.trigger_id) return;

	await deps.slack.views.open({
		trigger_id: payload.trigger_id,
		view: automationModal({
			target: { target: 'automation', id: automation.id, surface: shown.surface, channelId: channelOf(payload), messageTs: messageTsOf(payload) },
			fields: automation,
			timezone: automation.timezone,
		}),
	});
}

function errors(block: string, message: string): SubmissionErrors {
	return { response_action: 'errors', errors: { [block]: message } };
}

async function onModalSubmit({ payload, deps }: { payload: SlackViewSubmissionPayload; deps: AutomationInteractionDeps }): Promise<undefined | SubmissionErrors> {
	const parsed = parseAutomationModal(payload.view);

	if (!parsed.ok) return { response_action: 'errors', errors: parsed.errors };

	if (!(await isWorkspaceMember({ user: payload.user, deps }))) return errors('title', NOT_A_MEMBER);

	const { target, form } = parsed;
	const userId = payload.user.id;
	const now = deps.now();
	const at = now.toISOString();

	// Who the automation belongs to, and the row being edited.
	let owner = userId;
	let existing: Automation | undefined;

	if (target.target === 'draft') {
		const draft = await deps.store.drafts.get(target.id);

		if (!draft || draft.consumedAt) return errors('title', 'This draft was already created or cancelled.');

		if (draft.draftedBy !== userId) return errors('title', `Only <@${draft.draftedBy}> can edit this draft.`);

		owner = draft.draftedBy;
	} else if (target.target === 'automation') {
		existing = await deps.store.automations.get(target.id);

		if (!existing || existing.status === 'deleted') return errors('title', 'This automation was deleted.');

		if (existing.ownerUserId !== userId) return errors('title', `Only <@${existing.ownerUserId}> can edit this automation.`);

		owner = existing.ownerUserId;
	}

	let repo: string | undefined;

	if (form.kind === 'agent' && form.repo) {
		try {
			repo = await resolveInstallationRepo({ directory: deps.directory, input: form.repo });
		} catch (error) {
			return errors('repo', errorMessage(error));
		}
	}

	const destinationChannelId =
		form.destination.scope === 'personal' ? await openDirectMessage({ slack: deps.slack, userId: owner }) : form.destination.channelId;

	const fields: AutomationFields = {
		kind: form.kind,
		title: form.title,
		prompt: form.prompt,
		scope: form.destination.scope,
		destinationChannelId,
		repo,
		schedule: form.schedule,
		timezone: form.timezone,
	};

	const problem = fieldsError({ fields, now });

	if (problem) return errors(problem.field === 'schedule' ? form.scheduleBlock : problem.field, problem.message);

	const nextRunAt = nextRunAfter(fields.schedule, fields.timezone, now);

	if (!nextRunAt) return errors(form.scheduleBlock, 'That schedule has no future run.');

	switch (target.target) {
		case 'draft': {
			await deps.store.drafts.update({ id: target.id, fields, at });
			await deps.defer(redrawDraftCard({ draftId: target.id, deps }));

			return undefined;
		}

		case 'automation': {
			const status = existing?.status === 'completed' ? 'active' : (existing?.status ?? 'active');
			const updated = await deps.store.automations.update({ id: target.id, fields, nextRunAt, status, at });

			if (updated && target.channelId && target.messageTs && target.surface !== 'list') {
				const rendered =
					target.surface === 'header'
						? runMessage(updated)
						: automationCard({ fields: updated, owner: updated.ownerUserId, state: { kind: 'created', automation: updated }, now });

				await deps.defer(
					deps.slack.chat
						.update({ channel: target.channelId, ts: target.messageTs, ...rendered })
						.then(() => undefined)
						.catch((error: unknown) => console.warn(`[automations] Redraw failed: ${errorMessage(error)}`)),
				);
			}

			return undefined;
		}

		case 'new': {
			const created = await deps.store.automations.create({ ...fields, id: deps.newId(), ownerUserId: owner, nextRunAt, createdAt: at });

			// Posting the card is the "can Yappa post there" check; the
			// automation is withdrawn when it cannot.
			try {
				await deps.slack.chat.postMessage({
					channel: destinationChannelId,
					...automationCard({ fields: created, owner, state: { kind: 'created', automation: created }, now }),
				});
			} catch (error) {
				await deps.store.automations.setStatus({ id: created.id, status: 'deleted', at });

				return LOST_CHANNEL_CODES.has(slackErrorCode(error) ?? '')
					? errors('channel', 'Invite Yappa to that channel first (/invite @Yappa), then save again.')
					: errors('title', `Slack refused the post: ${errorMessage(error)}`);
			}

			return undefined;
		}

		default: {
			const _exhaustive: never = target;

			return _exhaustive;
		}
	}
}
```

Export `LOST_CHANNEL` from `scheduler.ts` as `LOST_CHANNEL_CODES` and use it in both files. Add the imports: `automationModal`, `parseAutomationModal`, `resolveInstallationRepo`, `RepoDirectory`, `fieldsError`, `openDirectMessage`, `slackErrorCode`, `LOST_CHANNEL_CODES`, `SlackViewSubmissionPayload`, `AutomationFields`, `Automation`.

- [ ] **Step 5: Implement `/aiyappa automations new`**

In `src/channels/slash-command.ts`:

```ts
export type AutomationCommandDeps = { store: AutomationStore; slack: SlackBotClient; now(): Date };

const USAGE =
	'Usage: `/aiyappa automations [new]`, `/aiyappa models`, or `/aiyappa openai connect|status|disconnect`';
```

Change the signature to `handleSlashCommand(payload, codexAuth, automations?: AutomationCommandDeps): Promise<SlashCommandReply | undefined>`. Add before the `models` branch:

```ts
	if (provider === 'automations') {
		if (!automations) return reply('Automations are not available in this deployment.');

		if (action === 'new' && extra.length === 0) {
			const timezone = await ownerTimezone({ slack: automations.slack, userId: payload.user_id });

			await automations.slack.views.open({
				trigger_id: payload.trigger_id,
				view: automationModal({ target: { target: 'new', channelId: payload.channel_id }, timezone }),
			});

			return undefined;
		}

		if (!action) return reply('Listing arrives in the next task.'); // replaced in Task 11

		return reply(USAGE);
	}
```

In `src/channels/slack.ts`, give `commands` the automation deps and the interaction deps the directory:

```ts
		commands({ payload }) {
			const slack = planningSlackClient(env.SLACK_BOT_TOKEN);

			return handleSlashCommand(
				payload,
				codexAuth,
				automations ? { store: automations, slack, now: () => new Date() } : undefined,
			);
		},
```

```ts
								directory: { find: (repo) => findInstallationRepository(repo), list: () => listInstallationRepositories() },
```

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run src/automations src/channels`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/automations src/channels
git commit -m "Edit automations in a modal and create them with /aiyappa automations new"
```

### Task 11: `/aiyappa automations` list

**Files:**
- Modify: `src/automations/blocks.ts` (`automationList`)
- Modify: `src/channels/slash-command.ts`
- Test: `src/automations/blocks.test.ts`, `src/channels/slash-command.test.ts`

**Interfaces:**
- Produces: `automationList({ automations, now }): Rendered`; `SlashCommandReply` gains optional `blocks`.

- [ ] **Step 1: Write the failing tests**

Append to `src/automations/blocks.test.ts`:

```ts
describe('automationList', () => {
	test('lists each with schedule, status and buttons; caps the list', () => {
		const one: Automation = {
			...fields,
			id: 'a1',
			ownerUserId: 'U1',
			status: 'paused',
			nextRunAt: '2026-10-14T03:30:00.000Z',
			consecutiveFailures: 0,
			createdAt: '',
			updatedAt: '',
		};

		const list = automationList({ automations: [one], now });
		const text = JSON.stringify(list.blocks);

		expect(text).toContain('Merged PRs');
		expect(text).toContain('Weekdays at 09:00 IST');
		expect(text).toContain('Paused');
		expect(text).toContain(AUTOMATION_ACTION.resume);

		const many = automationList({ automations: Array.from({ length: 25 }, (_, i) => ({ ...one, id: `a${i}` })), now });

		expect(JSON.stringify(many.blocks)).toContain('and 5 more');
	});

	test('says how to start when there are none', () => {
		expect(automationList({ automations: [], now }).text).toMatch(/automations new/);
	});
});
```

Append to `src/channels/slash-command.test.ts`:

```ts
	test('automations lists the caller personal ones and this channel ones', async () => {
		const store = createD1AutomationStore(await openTestDatabase());

		stubSlackApi();

		await store.automations.create({
			id: 'a1', kind: 'reminder', title: 'Tickets', prompt: 'Book tickets', scope: 'personal', destinationChannelId: 'D1',
			schedule: { kind: 'once', runAt: '2026-10-15T12:30:00.000Z' }, timezone: 'Asia/Kolkata', ownerUserId: 'U1',
			nextRunAt: '2026-10-15T12:30:00.000Z', createdAt: '2026-10-14T00:00:00.000Z',
		});

		const reply = await handleSlashCommand(payload('automations'), codexAuth, { store, slack: getSlackClient('xoxb-test'), now: () => new Date('2026-10-14T03:00:00.000Z') });

		expect(reply?.response_type).toBe('ephemeral');
		expect(JSON.stringify(reply?.blocks)).toContain('Tickets');
	});
```

(`payload(...)` must set `user_id: 'U1'` and a `channel_id`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/automations/blocks.test.ts src/channels/slash-command.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/automations/blocks.ts`:

```ts
// Slack allows 50 blocks per message; each automation takes two.
const LIST_MAX = 20;

export function automationList({ automations, now }: { automations: Automation[]; now: Date }): Rendered {
	if (automations.length === 0) {
		const text =
			'No automations here yet. Ask Yappa in a thread ("every weekday at 9am…"), or run `/aiyappa automations new`.';

		return { text, blocks: [sectionBlock(text)] };
	}

	const shown = automations.slice(0, LIST_MAX);

	const blocks: KnownBlock[] = shown.flatMap((automation) => [
		sectionBlock(
			[
				`*${escapeMrkdwn(automation.title)}* · ${automation.scope === 'personal' ? 'DM' : `<#${automation.destinationChannelId}>`}`,
				`${describeSchedule(automation.schedule, automation.timezone, now)} · ${statusLine({ automation, now })}`,
			].join('\n'),
		),
		...actionsBlock(manageButtons({ automation, surface: 'list', extras: ['runNow', 'edit', 'delete'] })),
	]);

	if (automations.length > LIST_MAX) blocks.push(contextBlock(`…and ${automations.length - LIST_MAX} more.`));

	return { text: `${automations.length} automation${automations.length === 1 ? '' : 's'}`, blocks };
}
```

In `src/channels/slash-command.ts`:

```ts
export type SlashCommandReply = { response_type: 'ephemeral'; text: string; blocks?: KnownBlock[] };
```

Replace the Task 10 placeholder line with:

```ts
		if (!action) {
			const visible = await automations.store.automations.visibleTo({ userId: payload.user_id, channelId: payload.channel_id });

			return { response_type: 'ephemeral', ...automationList({ automations: visible, now: automations.now() }) };
		}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/automations src/channels`
Expected: PASS.

- [ ] **Step 5: Verify the batch and commit**

Run: `pnpm test && pnpm run check:types && pnpm run lint && pnpm run fmt:check && pnpm run build`

```bash
git add src/automations src/channels
git commit -m "List automations with /aiyappa automations"
```

**Stop: Batch 4 review.**

---

## Batch 5: Manifest and docs

### Task 12: Manifest, ADR 0025, and project docs

**Files:**
- Modify: `slack-app-manifest.yaml`
- Create: `docs/adr/0025-scheduled-automations.md`
- Modify: `docs/adr/README.md`, `SLACK_AGENT_SPEC.md` (§9 and a dated layout note), `CONTEXT.md`, `AGENTS.md`, `README.md`
- Modify: `docs/superpowers/specs/2026-10-13-scheduled-automations-design.md` (Status line)

- [ ] **Step 1: Manifest**

In `slack-app-manifest.yaml`:
- add bot scopes `users:read` and `im:write` under `oauth_config.scopes.bot`;
- set the slash command to:

```yaml
    - command: /aiyappa
      url: https://example.invalid/channels/slack/commands
      description: Manage automations, list models, or connect the ChatGPT subscription
      usage_hint: automations [new] | models | openai connect|status|disconnect
      should_escape: false
```

- [ ] **Step 2: ADR 0025**

Write `docs/adr/0025-scheduled-automations.md` in ADR 0024's format (title, Status, Context, Decision, Consequences). The decisions:

1. **The model proposes; code decides.** `draft_automation` is the model's only automation tool. Code sets the owner from trusted delivery attributes, the timezone from Slack, the destination, and repo access from the installation. Create, Edit, Pause, Resume, Run now, and Delete are Slack interactions checked against the authorization table. `automationConfirmation` (default on) keeps a human click between the model and a stored automation.
2. **A heartbeat cron over D1.** One `* * * * *` Cron Trigger; schedules are rows with a precomputed `next_run_at`. A claim keyed on `(automation_id, fire_time)` dedupes ticks. Missed fires collapse to one, and there is no backlog. croner computes times only.
3. **A fresh conversation per run.** Each agent fire posts a header and starts a new Coworker in its thread through `startConversation`, with the owner as `startedBy`. Runs cannot create or edit automations.
4. **Failures pause; lost access blocks.** Three failed runs in a row pause the automation. A deactivated owner, or a destination the bot cannot post to, blocks it. Both DM the owner.

Consequences: the Worker runs every minute; any workspace member can schedule work against installed repositories (bounded by ADR 0024); no rate guards in v1.

Add the row `| 0025 Scheduled automations | Holds. … |` to `docs/adr/README.md`.

- [ ] **Step 3: Spec, glossary, agent guide, README**

- `SLACK_AGENT_SPEC.md` §9: add after v1:
  `- **v1.5 — Scheduled automations** (ADR 0025). A heartbeat Cron Trigger fires D1 rows into fresh conversations through the same `startConversation` path. This is the fourth adapter; the "three adapters" ceiling now reads "concrete adapters only, each a thin caller of `startConversation`; no generic webhook framework."` Then update the opening sentence of §9 to match.
- Add a `### Scheduled automations (2026-10-14)` note beside the other dated layout notes. In a few sentences, cover tables, the heartbeat, claim/advance/re-authorize/fire, outcomes via `observe`, and interactions.
- `CONTEXT.md`: add **Automation** (a stored instruction with a schedule, destination, and owner; agent or reminder; personal or channel scope), **Automation Run** (one fire; an agent run is a fresh Agent Conversation in a new top-level message), and **Automation Owner** (the Slack user who created it; runs are attributed to them; only they edit or delete). Each gets an _Avoid_ line in the file's style.
- `AGENTS.md` Layout: add `src/automations/` (store, scheduler, blocks, modal; `scheduled` in `src/cloudflare.ts`; cron in `wrangler.jsonc`), `src/conversations/start.ts`, `src/channels/automation-interactions.ts`, and `src/agents/automation-tools.ts`. Update the slash-command bullet with `automations [new]`.
- `README.md`: next to the migration 0004 note, say migration 0005 creates the automation tables. Add a Slack-app note that `users:read` and `im:write` need a reinstall.
- Spec Status line: `Status: Implemented (plan: docs/superpowers/plans/2026-10-14-scheduled-automations.md).`

- [ ] **Step 4: Verify and commit**

Run: `pnpm run fmt:check && pnpm run lint`

```bash
git add slack-app-manifest.yaml docs SLACK_AGENT_SPEC.md CONTEXT.md AGENTS.md README.md
git commit -m "Document scheduled automations (ADR 0025)"
```

**Stop: Batch 5 review.** Deploy steps for the user: apply migration 0005, reinstall the Slack app for the new scopes, then deploy.
