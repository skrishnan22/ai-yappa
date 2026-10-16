import * as v from 'valibot';
import type { SlackBotClient } from '../channels/slack-reply.ts';
import { errorMessage } from '../json.ts';
import type { Automation, AutomationStore } from './automation.ts';
import { runMessage } from './blocks.ts';
import { notifyOwner, recordFailure } from './outcome.ts';
import { nextRunAfter } from './schedule.ts';

// Starts the Coworker for an agent fire in the header's thread.
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
export const LOST_CHANNEL_CODES: ReadonlySet<string> = new Set([
	'channel_not_found',
	'not_in_channel',
	'is_archived',
]);

const OWNER_GONE = 'Its owner is no longer in this workspace.';

const slackErrorSchema = v.object({ data: v.object({ error: v.string() }) });

// The Slack API error code (`not_in_channel`, …) of a WebClient platform error.
export function slackErrorCode(cause: unknown): string | undefined {
	const result = v.safeParse(slackErrorSchema, cause);

	return result.success ? result.output.data.error : undefined;
}

// Why the owner can no longer run automations, or undefined while they can.
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

// The heartbeat: claim each due row, advance it, then fire it.
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

async function tick({
	automation,
	deps,
	now,
}: {
	automation: Automation;
	deps: SchedulerDeps;
	now: Date;
}): Promise<void> {
	const fireTime = automation.nextRunAt;

	if (!fireTime) return;

	const at = now.toISOString();

	const claimed = await deps.store.runs.claim({
		automationId: automation.id,
		fireTime,
		createdAt: at,
	});

	// Another tick took this fire.
	if (!claimed) return;

	const recurring = automation.schedule.kind === 'recurring';

	// From now, not from the fire time, so missed fires collapse into this one.
	await deps.store.automations.advance({
		id: automation.id,
		from: fireTime,
		nextRunAt: recurring ? nextRunAfter(automation.schedule, automation.timezone, now) : undefined,
		at,
	});

	// A fired one-off is complete; its message offers no Pause.
	const fired: Automation = recurring ? automation : { ...automation, status: 'completed' };

	await fireAutomation({ automation: fired, fireTime, deps });
}

// Run now: a fire at this instant that leaves the schedule alone.
export async function runNow({
	automation,
	deps,
}: {
	automation: Automation;
	deps: SchedulerDeps;
}): Promise<boolean> {
	const fireTime = deps.now().toISOString();

	const claimed = await deps.store.runs.claim({
		automationId: automation.id,
		fireTime,
		createdAt: fireTime,
	});

	if (!claimed) return false;

	await fireAutomation({ automation, fireTime, deps });

	return true;
}

// Fires a claimed run: re-authorize the owner, then post a reminder, or a
// header and dispatch the Coworker in its thread.
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
			await store.runs.finish({ ...run, status: 'posted' });
			await store.automations.recordSuccess({ id: automation.id, at: deps.now().toISOString() });

			return;
		}

		if (!posted.ts) throw new Error('Slack returned no timestamp for the run header.');

		const started = await deps.startRun({ automation, threadTs: posted.ts, fireTime });

		await store.runs.dispatched({ ...run, ...started });
	} catch (error) {
		if (LOST_CHANNEL_CODES.has(slackErrorCode(error) ?? '')) {
			await block({
				automation,
				fireTime,
				reason: `I can no longer post in <#${automation.destinationChannelId}>. Invite me back, then resume it.`,
				deps,
			});

			return;
		}

		await store.runs.finish({ ...run, status: 'failed', reason: errorMessage(error) });
		await recordFailure({
			store,
			slack,
			automationId: automation.id,
			at: deps.now().toISOString(),
		});
	}
}

// Lost access is not a failure to retry: block until a person resumes it.
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

	await deps.store.runs.finish({
		automationId: automation.id,
		fireTime,
		status: 'failed',
		reason,
	});

	if (!blocked) return;

	await notifyOwner({
		slack: deps.slack,
		automation: blocked,
		message: `Your automation *${automation.title}* is blocked. ${reason}`,
	});
}
