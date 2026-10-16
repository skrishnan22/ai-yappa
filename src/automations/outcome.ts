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

// Only the outcome that reached the threshold returns this count; later
// failures of a paused row, and repeated outcomes, stay quiet.
export async function notifyPaused({
	slack,
	automation,
}: {
	slack: SlackBotClient | undefined;
	automation: Automation | undefined;
}): Promise<void> {
	const justPaused =
		automation?.status === 'paused' && automation.consecutiveFailures === PAUSE_AFTER_FAILURES;

	if (!automation || !slack || !justPaused) return;

	await notifyOwner({
		slack,
		automation,
		message: `I paused your automation *${automation.title}* after ${PAUSE_AFTER_FAILURES} failed runs in a row. Resume it when it should run again.`,
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
	const automation = await store.runs.recordOutcome({
		submissionId,
		status: outcome === 'completed' ? 'succeeded' : 'failed',
		reason: error,
		at,
		pauseAt: PAUSE_AFTER_FAILURES,
	});

	await notifyPaused({ slack, automation });
}
