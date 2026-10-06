export type QuestionChoice = { id: string; label: string; recommended?: boolean };

export type QuestionKind = { kind: 'open' } | { kind: 'choice'; choices: QuestionChoice[] };

export type QuestionState =
	| { status: 'open' }
	| { status: 'closed'; closedAt: string }
	| { status: 'submitted'; closedAt: string; submittedBy: string; submittedByName: string };

export type Question = {
	id: string;
	conversationId: string;
	channelId: string;
	threadTs: string;
	messageTs?: string;
	title: string;
	body?: string;
	recommendation: string;
	createdAt: string;
} & QuestionKind &
	QuestionState;

export type OpenQuestion = Extract<Question, { status: 'open' }>;

// How an open question ends: closed (replaced or withdrawn) or submitted.
export type FinishedState = Exclude<QuestionState, { status: 'open' }>;

export type Participant = { conversationId: string; userId: string; joinedAt: string };

export type Vote = {
	questionId: string;
	userId: string;
	choiceId: string;
	userName: string;
	updatedAt: string;
};

// Callers supply identity from trusted thread state and perform authorization.
export type QuestionStore = {
	openQuestion(question: OpenQuestion): Promise<void>;
	getQuestion(questionId: string): Promise<Question | undefined>;
	getOpenQuestion(conversationId: string): Promise<Question | undefined>;
	setMessageTs(questionId: string, messageTs: string): Promise<boolean>;
	// First wins: true only for the caller that moved the question out of open.
	finishQuestion(questionId: string, end: FinishedState): Promise<boolean>;
	upsertParticipant(participant: Participant): Promise<void>;
	listParticipants(conversationId: string): Promise<Participant[]>;
	upsertVote(vote: Vote): Promise<boolean>;
	listVotes(questionId: string): Promise<Vote[]>;
};
