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

export async function recordFailure({
	store,
	slack,
	automationId,
	at,
}: {
	store: AutomationStore;
	slack: SlackBotClient | undefined;
	automationId: string;
	at: string;
}): Promise<void> {
	const after = await store.automations.recordFailure({
		id: automationId,
		at,
		pauseAt: PAUSE_AFTER_FAILURES,
	});

	// Only the failure that paused it; later failures of a paused row stay quiet.
	const justPaused =
		after?.status === 'paused' && after.consecutiveFailures === PAUSE_AFTER_FAILURES;

	if (!after || !slack || !justPaused) return;

	await notifyOwner({
		slack,
		automation: after,
		message: `I paused your automation *${after.title}* after ${PAUSE_AFTER_FAILURES} failed runs in a row. Resume it when it should run again.`,
	});
}

// Called for every settled Coworker submission; only an automation fire's
// own submission matches a run, so later replies in its thread never count.
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
	const succeeded = outcome === 'completed';

	const run = await store.runs.settle({
		submissionId,
		status: succeeded ? 'succeeded' : 'failed',
		reason: error,
	});

	if (!run) return;

	if (succeeded) {
		await store.automations.recordSuccess({ id: run.automationId, at });

		return;
	}

	await recordFailure({ store, slack, automationId: run.automationId, at });
}
