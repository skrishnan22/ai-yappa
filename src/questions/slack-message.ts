import type { SlackBotClient } from '../channels/slack-reply.ts';
import type { Question, QuestionStore, Vote } from './store.ts';

export const VOTE_ACTION_PREFIX = 'question_vote:';

export type QuestionMessage = {
	text: string;
	blocks: NonNullable<
		Extract<
			Parameters<SlackBotClient['chat']['postMessage']>[0],
			{ blocks?: { type: string }[] }
		>['blocks']
	>;
};

type ActionBlock = Extract<QuestionMessage['blocks'][number], { type: 'actions' }>;

type QuestionButton = Extract<ActionBlock['elements'][number], { type: 'button' }>;

function fallbackText(text: string): string {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function renderQuestionMessage(question: Question, votes: Vote[]): QuestionMessage {
	const heading = `❓ ${question.title}`;
	const recommendation = `➡️ ${question.recommendation}`;
	const lines = [heading];

	const blocks: QuestionMessage['blocks'] = [
		{ type: 'header', text: { type: 'plain_text', text: heading } },
	];

	if (question.body) {
		lines.push(question.body);
		blocks.push({ type: 'section', text: { type: 'plain_text', text: question.body } });
	}

	if (question.kind === 'choice') {
		lines.push(
			...question.choices.map(
				(choice) => `${choice.id}: ${choice.label}${choice.recommended ? ' ⭐' : ''}`,
			),
		);

		if (question.status === 'open') {
			const elements = question.choices.map((choice): QuestionButton => {
				const button: QuestionButton = {
					type: 'button',
					text: { type: 'plain_text', text: choice.label },
					action_id: `${VOTE_ACTION_PREFIX}${choice.id}`,
					value: JSON.stringify({ v: 1, questionId: question.id, choiceId: choice.id }),
				};

				if (choice.recommended) button.style = 'primary';

				return button;
			});

			blocks.push({ type: 'actions', elements });
		}
	}

	lines.push(recommendation);
	blocks.push({ type: 'section', text: { type: 'plain_text', text: recommendation } });

	const footer: string[] = [];

	if (question.status === 'open') {
		footer.push(
			question.kind === 'choice'
				? 'Click to vote · Reply in thread to continue'
				: 'Reply in thread',
		);
	} else {
		footer.push(
			question.status === 'submitted' ? `Submitted by ${question.submittedByName}` : 'Closed',
		);
	}

	if (question.kind === 'choice' && votes.length > 0) {
		const tally = question.choices.map(
			(choice) => `${choice.id}: ${votes.filter((vote) => vote.choiceId === choice.id).length}`,
		);

		const names = votes
			.slice(0, 20)
			.map((vote) => `${vote.userName} → ${vote.choiceId}`)
			.join(' · ');

		const remainder = votes.length > 20 ? ` · +${votes.length - 20} more voters` : '';
		footer.push(`Votes: ${tally.join(' · ')}\n${names}${remainder}`);
	}

	lines.push(...footer);
	blocks.push({ type: 'context', elements: footer.map((text) => ({ type: 'plain_text', text })) });

	return { text: fallbackText(lines.join('\n')), blocks };
}

export async function redrawQuestion(
	store: QuestionStore,
	client: SlackBotClient,
	questionId: string,
): Promise<boolean> {
	const question = await store.getQuestion(questionId);

	if (!question?.messageTs) return false;

	const votes = await store.listVotes(questionId);
	const message = renderQuestionMessage(question, votes);

	const result = await client.chat.update({
		channel: question.channelId,
		ts: question.messageTs,
		...message,
	});

	if (!result.ok) throw new Error('Slack did not confirm the question update');

	return true;
}
