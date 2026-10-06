import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { getSlackClient, getSlackClientWithoutRetries } from '../channels/slack-reply.ts';
import { loadThreadMessages } from '../channels/thread-context.ts';
import { errorMessage, jsonObjectSchema } from '../json.ts';
import { systemClock, type Clock } from '../memory/d1.ts';
import { redrawQuestion, renderQuestionMessage, type QuestionMessage } from './slack-message.ts';
import type { OpenQuestion, QuestionStore } from './store.ts';
import { workerQuestionStore, type QuestionStoreFactory } from './worker-store.ts';

export type QuestionRef = {
	conversationId: string;
	channelId: string;
	threadTs: string;
	startedBy?: string;
};

type QuestionToolOptions = {
	token?: string;
	store?: QuestionStoreFactory;
	clock?: Pick<Clock, 'now'>;
};

const text = v.pipe(v.string(), v.minLength(1), v.maxLength(2000));

const inputSchema = v.strictObject({
	title: v.pipe(v.string(), v.minLength(1), v.maxLength(147)),
	body: v.optional(text),
	recommendation: text,
	choices: v.optional(
		v.pipe(
			v.array(
				v.strictObject({
					label: v.pipe(v.string(), v.minLength(1), v.maxLength(75)),
					recommended: v.optional(v.boolean()),
				}),
			),
			v.minLength(2),
			v.maxLength(5),
			v.check(
				(choices) => choices.filter((choice) => choice.recommended).length <= 1,
				'Only one choice may be recommended',
			),
		),
	),
});

async function questionIdFor(conversationId: string, toolCallId: string): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify([conversationId, toolCallId]));
	const digest = await crypto.subtle.digest('SHA-256', bytes);

	return `q_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function output(questionId: string, posted: boolean, message: QuestionMessage) {
	return {
		output: {
			questionId,
			posted,
			text: message.text,
			blocks: v.parse(v.array(jsonObjectSchema), message.blocks),
		},
	};
}

export function questionTools(ref: QuestionRef, options: QuestionToolOptions = {}) {
	const getStore = options.store ?? workerQuestionStore;
	const clock = options.clock ?? systemClock;

	// The question's state is already saved. Stale buttons refuse votes and are
	// redrawn on the next click, so a failed redraw is only logged.
	async function redraw(
		token: string,
		store: QuestionStore,
		questionId: string,
		log: { warn(message: string): void },
	): Promise<boolean> {
		try {
			return await redrawQuestion(store, getSlackClient(token), questionId);
		} catch (error) {
			log.warn(`Question ${questionId} redraw failed: ${errorMessage(error)}`);

			return false;
		}
	}

	// Close a question whose post failed and put back the one it replaced.
	async function withdraw(
		token: string,
		store: QuestionStore,
		questionId: string,
		previousId: string | undefined,
		log: { warn(message: string): void; error(message: string): void },
	): Promise<boolean> {
		try {
			await store.finishQuestion(questionId, {
				status: 'closed',
				closedAt: clock.now().toISOString(),
			});

			if (!previousId || !(await store.reopenQuestion(previousId))) return false;
		} catch (error) {
			log.error(`Could not withdraw question ${questionId}: ${errorMessage(error)}`);

			return false;
		}

		// A click while it was closed may have redrawn the previous question without buttons.
		await redraw(token, store, previousId, log);

		return true;
	}

	const askQuestion = defineTool({
		name: 'ask_question',
		description:
			'Ask one question in this conversation’s Slack thread. Include 2–5 choices only for discrete decisions, at most one recommended. Clicks record votes; they do not run the agent. People reply in the thread to continue. Replaces the previous open question. Always include your recommendation.',
		input: inputSchema,
		async run({ data, toolCallId, log }) {
			const id = await questionIdFor(ref.conversationId, toolCallId);

			const base = {
				id,
				conversationId: ref.conversationId,
				channelId: ref.channelId,
				threadTs: ref.threadTs,
				title: data.title,
				body: data.body,
				recommendation: data.recommendation,
				createdAt: clock.now().toISOString(),
				status: 'open',
			} satisfies Omit<OpenQuestion, 'kind' | 'choices'>;

			const question: OpenQuestion = data.choices
				? {
						...base,
						kind: 'choice',
						choices: data.choices.map((choice, index) => ({
							...choice,
							id: String.fromCharCode(65 + index),
						})),
					}
				: { ...base, kind: 'open' };

			const message = renderQuestionMessage(question, []);

			if (!options.token) return output(id, false, message);

			const store = await getStore();
			const existing = await store.getQuestion(id);

			if (existing) {
				if (!existing.messageTs)
					throw new Error(`Question ${id} posting was not confirmed. Do not repost it.`);
				const votes = await store.listVotes(id);

				return output(id, true, renderQuestionMessage(existing, votes));
			}

			const client = getSlackClient(options.token);
			const history = await loadThreadMessages(client, ref);

			const humans = new Set(
				history.flatMap((item) =>
					item.user && !item.bot_id && item.subtype !== 'bot_message' ? [item.user] : [],
				),
			);

			if (ref.startedBy) humans.add(ref.startedBy);

			for (const userId of humans) {
				await store.upsertParticipant({
					conversationId: ref.conversationId,
					userId,
					joinedAt: question.createdAt,
				});
			}

			const previous = await store.getOpenQuestion(ref.conversationId);
			await store.openQuestion(question);

			try {
				const response = await getSlackClientWithoutRetries(options.token).chat.postMessage({
					channel: ref.channelId,
					thread_ts: ref.threadTs,
					...message,
					unfurl_links: false,
					unfurl_media: false,
				});

				const result = v.parse(
					v.object({ ok: v.literal(true), ts: v.pipe(v.string(), v.minLength(1)) }),
					response,
				);

				const saved = await store.setMessageTs(id, result.ts);

				if (!saved) throw new Error('Could not record the posted question timestamp');
			} catch (error) {
				const restored = await withdraw(options.token, store, id, previous?.id, log);

				throw new Error(
					`Question ${id} posting failed or was not confirmed: ${errorMessage(error)}. Do not repost it; the remote outcome may be unknown.${restored ? ' The previous question is still open.' : ''}`,
					{ cause: error },
				);
			}

			// Retire the previous question's buttons only once its successor is posted.
			if (previous) await redraw(options.token, store, previous.id, log);

			return output(id, true, message);
		},
	});

	const closeQuestion = defineTool({
		name: 'close_question',
		description:
			'Close the open question in this conversation’s Slack thread and remove its buttons. Then confirm to the people with reply_in_slack_thread.',
		async run({ log }) {
			if (!options.token) return { output: { closed: false, redrawn: false } };

			const store = await getStore();
			const question = await store.getOpenQuestion(ref.conversationId);

			if (!question) return { output: { closed: false, redrawn: false } };

			const closed = await store.finishQuestion(question.id, {
				status: 'closed',
				closedAt: clock.now().toISOString(),
			});

			const redrawn = await redraw(options.token, store, question.id, log);

			return { output: { closed, redrawn } };
		},
	});

	return { askQuestion, closeQuestion };
}
