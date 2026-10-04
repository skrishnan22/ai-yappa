import type { Participant, Question, QuestionStore, Vote } from '../store.ts';

export function createMemoryQuestionStore(): QuestionStore {
	const questions = new Map<string, Question>();
	const participants = new Map<string, Map<string, Participant>>();
	const votes = new Map<string, Map<string, Vote>>();

	return {
		async openQuestion(question) {
			if (questions.has(question.id)) throw new Error('Question ID already exists');

			for (const previous of questions.values()) {
				if (previous.conversationId === question.conversationId && previous.status === 'open') {
					questions.set(previous.id, {
						...previous,
						status: 'closed',
						closedAt: question.createdAt,
					});
				}
			}

			questions.set(question.id, structuredClone(question));
		},
		async getQuestion(questionId) {
			return structuredClone(questions.get(questionId));
		},
		async getOpenQuestion(conversationId) {
			for (const question of questions.values()) {
				if (question.conversationId === conversationId && question.status === 'open') {
					return structuredClone(question);
				}
			}

			return undefined;
		},
		async setMessageTs(questionId, messageTs) {
			const question = questions.get(questionId);

			if (!question) return false;

			questions.set(questionId, { ...question, messageTs });

			return true;
		},
		async closeQuestion(questionId, closedAt) {
			const question = questions.get(questionId);

			if (question?.status !== 'open') return false;

			questions.set(questionId, { ...question, status: 'closed', closedAt });

			return true;
		},
		async submitQuestion({ questionId, userId, userName, closedAt }) {
			const question = questions.get(questionId);

			if (question?.status !== 'open') return false;

			questions.set(questionId, {
				...question,
				status: 'submitted',
				closedAt,
				submittedBy: userId,
				submittedByName: userName,
			});

			return true;
		},
		async upsertParticipant(participant) {
			let thread = participants.get(participant.conversationId);

			if (!thread) {
				thread = new Map();
				participants.set(participant.conversationId, thread);
			}

			if (!thread.has(participant.userId))
				thread.set(participant.userId, structuredClone(participant));
		},
		async listParticipants(conversationId) {
			const thread = participants.get(conversationId);

			const members = [...(thread?.values() ?? [])].toSorted(
				(a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.userId.localeCompare(b.userId),
			);

			return structuredClone(members);
		},
		async upsertVote(vote) {
			const question = questions.get(vote.questionId);

			if (question?.status !== 'open' || question.kind !== 'choice') return false;

			if (!question.choices.some((choice) => choice.id === vote.choiceId)) return false;

			let questionVotes = votes.get(vote.questionId);

			if (!questionVotes) {
				questionVotes = new Map();
				votes.set(vote.questionId, questionVotes);
			}

			questionVotes.set(vote.userId, structuredClone(vote));

			return true;
		},
		async listVotes(questionId) {
			const questionVotes = votes.get(questionId);

			const ordered = [...(questionVotes?.values() ?? [])].toSorted((a, b) =>
				a.userId.localeCompare(b.userId),
			);

			return structuredClone(ordered);
		},
	};
}
