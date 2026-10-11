import type {
	SlackBlockActionsPayload,
	SlackInteractionPayload,
	SlackUser,
	SlackViewSubmissionPayload,
} from '@flue/slack';
import {
	DECIDE_ACTION,
	DECIDE_CALLBACK,
	decideModal,
	parseDecideSubmission,
	parseDecideValue,
	parseReopenValue,
	REOPEN_ACTION,
	type DecideSubmission,
} from '../planning/card-blocks.ts';
import type { CardRevision, PlanningStore } from '../planning/decision-log.ts';
import { redrawCard } from '../planning/redraw-card.ts';
import { errorMessage } from '../json.ts';
import type { SlackBotClient } from './slack-reply.ts';

export type PlanningContinuation = {
	conversationId: string;
	type: 'planning.decision';
	eventId: string; // idempotency key
	userId: string;
	body: string;
};

export type PlanningInteractionDeps = {
	store: PlanningStore;
	slack: SlackBotClient;
	workspaceTeamOf(conversationId: string): string; // channel.parseInstanceId(id).teamId
	continueConversation(continuation: PlanningContinuation): Promise<void>;
	// Runs after the response when the platform allows it (waitUntil); tests await it.
	defer(work: Promise<void>): Promise<void>;
	now(): Date;
};

type SubmissionErrors = { response_action: 'errors'; errors: Record<string, string> };

const NOT_A_MEMBER = 'Yappa only works for members of this workspace.';

const CARD_CHANGED =
	'This card changed since you opened it: it was decided, reopened, or reworded. Close this and review the current card.';

export async function handlePlanningInteraction(
	payload: SlackInteractionPayload,
	deps: PlanningInteractionDeps,
): Promise<undefined | SubmissionErrors> {
	if (payload.type === 'block_actions') {
		const action = payload.actions.find(
			(candidate) => candidate.action_id === DECIDE_ACTION || candidate.action_id === REOPEN_ACTION,
		);

		if (!action?.value) return undefined;

		if (action.action_id === DECIDE_ACTION) {
			await onDecideClick(payload, action.value, deps);
		} else {
			await onReopenClick(payload, action.value, deps);
		}

		return undefined;
	}

	if (payload.type === 'view_submission' && payload.view.callback_id === DECIDE_CALLBACK) {
		return onDecideSubmission(payload, deps);
	}

	return undefined;
}

async function onDecideClick(
	payload: SlackBlockActionsPayload,
	value: string,
	deps: PlanningInteractionDeps,
): Promise<void> {
	const shown = parseDecideValue(value);

	if (!shown) return;
	const { cardId, label } = shown;

	const latest = await deps.store.log.latest(cardId);

	if (!latest) return;

	if (!isMember(payload.user, latest, deps)) {
		await deps.defer(refuse(payload.user, latest, deps));

		return;
	}

	if (latest.decision) {
		await deps.defer(redraw(latest, deps));

		return;
	}

	if (!payload.trigger_id) return;

	await deps.slack.views.open({
		trigger_id: payload.trigger_id,
		view: decideModal({ latest, label }),
	});
}

async function onReopenClick(
	payload: SlackBlockActionsPayload,
	value: string,
	deps: PlanningInteractionDeps,
): Promise<void> {
	const shown = parseReopenValue(value);

	if (!shown) return;

	const latest = await deps.store.log.latest(shown.cardId);

	if (!latest) return;

	if (!isMember(payload.user, latest, deps)) {
		await deps.defer(refuse(payload.user, latest, deps));

		return;
	}

	// A stale button (the card moved on since it was drawn) reopens nothing;
	// the redraw shows the current card instead.
	const reopened = await deps.store.log.reopen({
		cardId: shown.cardId,
		revision: shown.revision,
		createdAt: deps.now().toISOString(),
	});

	if (!reopened) {
		await deps.defer(redraw(latest, deps));

		return;
	}

	await deps.defer(redraw(reopened, deps));
}

async function onDecideSubmission(
	payload: SlackViewSubmissionPayload,
	deps: PlanningInteractionDeps,
): Promise<undefined | SubmissionErrors> {
	const parsed = parseDecideSubmission(payload.view);

	if (!parsed.ok) return { response_action: 'errors', errors: parsed.errors };

	const { submission } = parsed;
	const latest = await deps.store.log.latest(submission.cardId);

	if (!latest) return reasoningError(CARD_CHANGED);

	if (!isMember(payload.user, latest, deps)) return reasoningError(NOT_A_MEMBER);

	// The modal answers the revision it was opened at; a choice must be one of its options.
	const choiceIsOnCard =
		!submission.choiceId || latest.choices?.some((choice) => choice.id === submission.choiceId);

	if (submission.revision !== latest.revision || !choiceIsOnCard) {
		return reasoningError(CARD_CHANGED);
	}

	const decided = await deps.store.log.decide({
		cardId: submission.cardId,
		revision: submission.revision,
		decision: {
			choiceId: submission.choiceId,
			customAnswer: submission.customAnswer,
			reasoning: submission.reasoning,
			decidedBy: payload.user.id,
			decidedByName: payload.user.name ?? payload.user.username ?? payload.user.id,
			decidedAt: deps.now().toISOString(),
		},
	});

	if (!decided) {
		await deps.defer(redraw(latest, deps));

		return reasoningError(CARD_CHANGED);
	}

	await Promise.all([
		deps.defer(redraw(latest, deps)),
		deps.defer(
			deps.continueConversation({
				conversationId: latest.conversationId,
				type: 'planning.decision',
				eventId: `planning-decide:${submission.cardId}:${submission.revision}`,
				userId: payload.user.id,
				body: decisionBody(latest, submission, payload.user.id),
			}),
		),
	]);

	return undefined;
}

function isMember(user: SlackUser, card: CardRevision, deps: PlanningInteractionDeps): boolean {
	return Boolean(user.team_id) && user.team_id === deps.workspaceTeamOf(card.conversationId);
}

async function refuse(
	user: SlackUser,
	card: CardRevision,
	deps: PlanningInteractionDeps,
): Promise<void> {
	await deps.slack.chat.postEphemeral({
		channel: card.channelId,
		thread_ts: card.threadTs,
		user: user.id,
		text: NOT_A_MEMBER,
	});
}

function reasoningError(message: string): SubmissionErrors {
	return { response_action: 'errors', errors: { reasoning: message } };
}

// A failed redraw must not stop continuation after a decision was saved.
async function redraw(revision: CardRevision, deps: PlanningInteractionDeps): Promise<void> {
	try {
		await redrawCard(revision, { log: deps.store.log, slack: deps.slack });
	} catch (error) {
		console.warn(`[planning] Card ${revision.cardId} redraw failed: ${errorMessage(error)}`);
	}
}

// Dispatch bodies are model prompts: user and model text is quoted as-is.
// Built from what was submitted, not re-read, so a later reopen cannot blank the answer.
function decisionBody(
	revision: CardRevision,
	submission: DecideSubmission,
	userId: string,
): string {
	const answer =
		submission.customAnswer ??
		revision.choices?.find((choice) => choice.id === submission.choiceId)?.label ??
		'';

	return [
		`<@${userId}> decided ${revision.cardId} "${revision.question}": ${answer}`,
		submission.reasoning ? `. Reasoning: "${submission.reasoning}"` : '',
		revision.revision > 1 ? '. This answer supersedes any earlier answer for this question' : '',
		'. This is their decision; do not replace it.',
		' Call list_decisions and compare this answer with the latest answers for the other cards.',
		' If there is a contradiction, explain which card conflicts and how, and ask whether to reopen it before moving on.',
		' If there are no contradictions, continue with the follow-up or next question.',
	].join('');
}
