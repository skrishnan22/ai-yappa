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

export type AutomationStore = {
	automations: {
		create(automation: NewAutomation): Promise<Automation>;
		get(id: string): Promise<Automation | undefined>;
		due(args: { now: string; limit: number }): Promise<Automation[]>;
		// The user's personal automations and the channel's channel automations, not deleted.
		visibleTo(args: { userId: string; channelId: string }): Promise<Automation[]>;
		// Moves a claimed fire on: last_run_at = from, next_run_at = nextRunAt, or
		// completed when there is none. Only while next_run_at is still `from`.
		advance(args: { id: string; from: string; nextRunAt?: string; at: string }): Promise<boolean>;
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
		recordSuccess(args: { id: string; at: string }): Promise<void>;
		// Increments the failure count; an active automation pauses at `pauseAt`.
		recordFailure(args: {
			id: string;
			at: string;
			pauseAt: number;
		}): Promise<Automation | undefined>;
	};
	runs: {
		claim(args: { automationId: string; fireTime: string; createdAt: string }): Promise<boolean>;
		dispatched(args: {
			automationId: string;
			fireTime: string;
			conversationId: string;
			submissionId: string;
		}): Promise<void>;
		finish(args: {
			automationId: string;
			fireTime: string;
			status: 'posted' | 'failed';
			reason?: string;
		}): Promise<void>;
		// Settles a dispatched run by its submission; undefined for any other submission.
		settle(args: {
			submissionId: string;
			status: 'succeeded' | 'failed';
			reason?: string;
		}): Promise<AutomationRun | undefined>;
		list(automationId: string): Promise<AutomationRun[]>;
	};
};
