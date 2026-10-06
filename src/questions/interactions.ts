import type { SlackChannel, SlackInteractionPayload } from '@flue/slack';
import * as v from 'valibot';
import type { SlackBotClient } from '../channels/slack-reply.ts';
import { errorMessage } from '../json.ts';
import { redrawQuestion, VOTE_ACTION_PREFIX } from './slack-message.ts';
import type { QuestionStoreFactory } from './worker-store.ts';

const nonEmpty = v.pipe(v.string(), v.minLength(1));

const sourceSchema = v.object({
	user: v.object({ id: nonEmpty }),
	container: v.object({ channel_id: nonEmpty }),
	message: v.optional(v.object({ thread_ts: v.optional(nonEmpty) })),
});

const votePayloadSchema = v.object({
	team: v.object({ id: nonEmpty }),
	user: v.object({ id: nonEmpty, name: v.optional(v.pipe(v.string(), v.maxLength(80))) }),
	container: v.object({ type: v.literal('message'), channel_id: nonEmpty, message_ts: nonEmpty }),
	message: v.object({ thread_ts: nonEmpty }),
	actions: v.pipe(
		v.array(
			v.object({
				type: v.literal('button'),
				action_id: nonEmpty,
				action_ts: v.pipe(v.string(), v.regex(/^\d{10}\.\d{6}$/)),
				value: v.pipe(v.string(), v.maxLength(2000)),
			}),
		),
		v.length(1),
	),
});

const voteValueSchema = v.strictObject({
	v: v.literal(1),
	questionId: nonEmpty,
	choiceId: v.picklist(['A', 'B', 'C', 'D', 'E']),
});

// Fixed-width ISO microseconds preserve Slack click ordering on retries.
function clickTime(timestamp: string): string {
	const date = new Date(Number(timestamp.slice(0, 10)) * 1000).toISOString();

	return `${date.slice(0, 19)}.${timestamp.slice(11)}Z`;
}

export async function handleQuestionInteraction(
	payload: SlackInteractionPayload,
	getStore: QuestionStoreFactory,
	client: SlackBotClient,
	instanceId: SlackChannel['instanceId'],
): Promise<void> {
	const routing = v.safeParse(
		v.object({
			type: v.literal('block_actions'),
			actions: v.array(v.object({ action_id: nonEmpty })),
		}),
		payload,
	);

	if (
		!routing.success ||
		!routing.output.actions.some((action) => action.action_id.startsWith(VOTE_ACTION_PREFIX))
	)
		return;

	const source = v.safeParse(sourceSchema, payload);

	if (!source.success) return;
	const destination = source.output;

	async function refuse(text: string) {
		await client.chat.postEphemeral({
			channel: destination.container.channel_id,
			user: destination.user.id,
			thread_ts: destination.message?.thread_ts,
			text,
		});
	}

	let recorded = false;

	try {
		const parsed = v.safeParse(votePayloadSchema, payload);

		if (!parsed.success) {
			await refuse('This question button is not valid.');

			return;
		}

		const data = parsed.output;
		const [action] = data.actions;

		if (!action) return;

		const raw: unknown = JSON.parse(action.value);
		const value = v.safeParse(voteValueSchema, raw);

		if (!value.success || action.action_id !== `${VOTE_ACTION_PREFIX}${value.output.choiceId}`) {
			await refuse('This question button is not valid.');

			return;
		}

		const { questionId, choiceId } = value.output;
		const store = await getStore();
		const question = await store.getQuestion(questionId);

		if (
			!question ||
			question.channelId !== data.container.channel_id ||
			question.messageTs !== data.container.message_ts ||
			question.threadTs !== data.message.thread_ts ||
			question.conversationId !==
				instanceId({
					teamId: data.team.id,
					channelId: question.channelId,
					threadTs: question.threadTs,
				})
		) {
			await refuse('This button does not belong to a question in this thread.');

			return;
		}

		if (question.status !== 'open') {
			await refuse('This question is closed.');
			await redrawQuestion(store, client, questionId);

			return;
		}

		if (question.kind !== 'choice' || !question.choices.some((choice) => choice.id === choiceId)) {
			await refuse('This question option is not valid.');

			return;
		}

		const updatedAt = clickTime(action.action_ts);
		await store.upsertParticipant({
			conversationId: question.conversationId,
			userId: data.user.id,
			joinedAt: updatedAt,
		});
		recorded = await store.upsertVote({
			questionId,
			choiceId,
			userId: data.user.id,
			userName: data.user.name || data.user.id,
			updatedAt,
		});

		if (!recorded) {
			const current = await store.getQuestion(questionId);

			if (current?.status !== 'open') {
				await refuse('This question is closed.');

				return;
			}
		}

		await redrawQuestion(store, client, questionId);
	} catch (error) {
		console.warn('[question-vote]', { error: errorMessage(error) });

		try {
			await refuse(
				recorded
					? 'Your vote was saved, but the question could not be refreshed. Reply in the thread to continue.'
					: 'Could not confirm your vote. Try clicking again.',
			);
		} catch (notification) {
			console.warn('[question-vote] Could not send ephemeral reply', {
				error: errorMessage(notification),
			});
		}
	}
}
