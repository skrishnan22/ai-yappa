export type CardChoice = { id: string; label: string };

export type CardWording = {
	question: string;
	context?: string;
	recommendation: string;
	choices?: CardChoice[]; // 2–5, unique ids
};

export type Decision = {
	// Exactly one of choiceId / customAnswer.
	choiceId?: string;
	customAnswer?: string;
	reasoning?: string;
	decidedBy: string; // Slack user id
	decidedByName: string;
	decidedAt: string; // ISO
};

export type CardRevision = CardWording & {
	cardId: string;
	revision: number;
	conversationId: string;
	channelId: string;
	threadTs: string;
	messageTs?: string;
	createdAt: string;
	decision?: Decision;
};

// One card: its latest revision is its state; earlier revisions are history.
export type Card = { label: string; latest: CardRevision; history: CardRevision[] };

export type NewCard = CardWording & {
	cardId: string;
	conversationId: string;
	channelId: string;
	threadTs: string;
	messageTs?: string; // when the card was posted before it was saved
	createdAt: string;
};

export type DecisionLog = {
	ask(card: NewCard): Promise<CardRevision>; // inserts revision 1
	setMessageTs(cardId: string, messageTs: string): Promise<void>; // every revision of the card
	latest(cardId: string): Promise<CardRevision | undefined>;
	// First wins: true only if `revision` is the card's latest and is undecided.
	decide(args: { cardId: string; revision: number; decision: Decision }): Promise<boolean>;
	// Inserts revision+1 with the same wording and no decision, only when `revision`
	// is the card's latest and is decided. Undefined otherwise, or when a
	// concurrent writer took revision+1.
	reopen(args: {
		cardId: string;
		revision: number;
		createdAt: string;
	}): Promise<CardRevision | undefined>;
	// Inserts latest+1 with new wording, only when latest is undecided.
	reword(
		args: { cardId: string; createdAt: string } & CardWording,
	): Promise<CardRevision | undefined>;
	// Every card in the conversation, ordered by creation; label `D1`, `D2`, ...
	listCards(conversationId: string): Promise<Card[]>;
};

export type PlanningSessions = {
	start(conversationId: string, at: string): Promise<void>; // upsert; clears ended_at
	end(conversationId: string, at: string): Promise<boolean>; // true if a session was active
	isActive(conversationId: string): Promise<boolean>;
};

export type PlanningStore = { log: DecisionLog; sessions: PlanningSessions };
