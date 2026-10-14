import type { Schedule } from './schedule.ts';

export type AutomationKind = 'agent' | 'reminder';

export type AutomationScope = 'personal' | 'channel';

export type AutomationStatus = 'active' | 'paused' | 'blocked' | 'completed' | 'deleted';

export type RunStatus = 'claimed' | 'dispatched' | 'posted' | 'failed' | 'succeeded';

// What the model or the modal chooses. Code resolves the owner, destination
// and repo access, and validates every field, before anything is stored.
export type AutomationFields = {
	kind: AutomationKind;
	title: string;
	prompt: string; // the instruction, or the reminder text
	scope: AutomationScope;
	destinationChannelId: string; // the owner's DM for personal scope
	repo?: string; // HTTPS clone URL; agent runs only
	schedule: Schedule;
	timezone: string; // IANA
};

export type Automation = AutomationFields & {
	id: string;
	ownerUserId: string;
	status: AutomationStatus;
	nextRunAt?: string;
	lastRunAt?: string;
	consecutiveFailures: number;
	createdAt: string;
	updatedAt: string;
};

export type NewAutomation = AutomationFields & {
	id: string;
	ownerUserId: string;
	nextRunAt: string;
	createdAt: string;
};

export type AutomationRun = {
	automationId: string;
	fireTime: string;
	status: RunStatus;
	conversationId?: string;
	submissionId?: string;
	reason?: string;
	createdAt: string;
};

export type RunOutcome = {
	at: string;
	pauseAt: number;
	reason?: string;
} & (
	| { submissionId: string; status: 'succeeded' | 'failed' }
	| { automationId: string; fireTime: string; status: 'posted' | 'failed' }
);

export type AutomationStore = {
	automations: {
		create(automation: NewAutomation): Promise<Automation>;
		get(id: string): Promise<Automation | undefined>;
		due(args: { now: string; limit: number }): Promise<Automation[]>;
		// The user's personal automations and the channel's channel automations, not deleted.
		visibleTo(args: { userId: string; channelId: string }): Promise<Automation[]>;
		update(args: {
			id: string;
			fields: AutomationFields;
			nextRunAt: string;
			status: AutomationStatus;
			at: string;
		}): Promise<Automation | undefined>;
		// Never changes a deleted automation. `active` resets the failure count.
		// next_run_at changes only when given.
		setStatus(args: {
			id: string;
			status: AutomationStatus;
			nextRunAt?: string;
			at: string;
		}): Promise<Automation | undefined>;
	};
	runs: {
		// Atomically claims and advances an active scheduled fire; false for stale or taken fires.
		claimScheduled(args: {
			automationId: string;
			fireTime: string;
			nextRunAt?: string;
			at: string;
		}): Promise<boolean>;
		// Run now claims a fire without changing the schedule.
		claim(args: { automationId: string; fireTime: string; createdAt: string }): Promise<boolean>;
		dispatched(args: {
			automationId: string;
			fireTime: string;
			conversationId: string;
			submissionId: string;
		}): Promise<void>;
		// Records a terminal outcome and updates failure counting atomically, once.
		// Returns the updated automation, or undefined for an unrelated/already-finished run.
		recordOutcome(outcome: RunOutcome): Promise<Automation | undefined>;
		list(automationId: string): Promise<AutomationRun[]>;
	};
};
