import type { WebClient } from '@slack/web-api';

export type CardStatus = 'queued' | 'hydrating' | 'working' | 'completed' | 'failed' | 'aborted';

export type LegacyRunCardState = {
	submissionId: string;
	messageTs: string | null;
	status: CardStatus;
	step: string;
	startedAt: number;
	branchUrl?: string;
	prUrl?: string;
	notifyPosted?: boolean;
};

export type CardEvent =
	| { type: 'submission_queued'; submissionId: string }
	| { type: 'submission_running'; submissionId: string }
	| { type: 'hydration'; phase: 'start' | 'done'; skipped?: boolean }
	| { type: 'tool_start'; submissionId?: string; toolName: string }
	| { type: 'tool'; submissionId?: string; toolName: string; isError?: boolean; result?: unknown }
	| {
			type: 'submission_settled';
			submissionId: string;
			outcome: 'completed' | 'failed' | 'aborted';
			error?: string;
	  };

export type CardApply = {
	state: RunCardDesired;
	notify?: string;
};

const STEP_BY_TOOL: Record<string, string> = {
	read_github_issue: 'Reading GitHub issue',
	read_github_repo: 'Reading repository metadata',
	create_working_branch: 'Creating working branch',
	checkpoint_working_branch: 'Checkpointing working branch',
	open_pull_request: 'Opening pull request',
	reply_in_slack_thread: 'Replying in thread',
	bash: 'Running a command',
	read: 'Reading a file',
	write: 'Editing files',
	edit: 'Editing files',
	grep: 'Searching the workspace',
	glob: 'Searching the workspace',
};

type BlocksOf<T> = T extends { blocks?: Array<infer Block> } ? Block : never;
type SlackBlock = BlocksOf<Parameters<WebClient['chat']['postMessage']>[0]>;
const DELIVERY_RETRY_DELAY_MS = 30_000;

export type RunCardDestination = {
	channelId: string;
	threadTs: string;
};

export type RunCardDesired = {
	submissionId: string;
	status: CardStatus;
	step: string;
	startedAt: number;
	branchUrl?: string;
	prUrl?: string;
};

export type RunCardDeliveryRecord = {
	submissionId: string;
	desired: RunCardDesired;
	desiredRevision: number;
	deliveredRevision: number;
	messageTs: string | null;
	cardPostState: 'pending' | 'unknown' | 'posted';
	notificationText?: string;
	notificationTs: string | null;
	notificationPostState: 'none' | 'pending' | 'unknown' | 'posted';
	nextAttemptAt: number;
};

export type RunCardRepository = {
	destination(): RunCardDestination | undefined;
	setDestination(destination: RunCardDestination): void;
	legacyMigrationComplete(): boolean;
	markLegacyMigrationComplete(): void;
	activeSubmissionId(): string | undefined;
	setActiveSubmissionId(submissionId: string): void;
	get(submissionId: string): RunCardDeliveryRecord | undefined;
	put(record: RunCardDeliveryRecord): void;
	pending(): RunCardDeliveryRecord[];
};

export type RunCardPostResult =
	| { kind: 'posted'; ts: string }
	| { kind: 'rejected'; retryAt?: number; code?: string }
	| { kind: 'unknown'; code?: string };

export type RunCardDeliveryPort = {
	postCard(args: {
		channel: string;
		threadTs: string;
		text: string;
		blocks: SlackBlock[];
		submissionId: string;
	}): Promise<RunCardPostResult>;
	updateCard(args: {
		channel: string;
		ts: string;
		text: string;
		blocks: SlackBlock[];
		submissionId: string;
	}): Promise<void>;
	postNotification(args: {
		channel: string;
		threadTs: string;
		text: string;
		submissionId: string;
	}): Promise<RunCardPostResult>;
	findPostedMessage(args: {
		channel: string;
		threadTs: string;
		submissionId: string;
		kind: 'card' | 'notification';
	}): Promise<
		{ kind: 'found'; ts: string } | { kind: 'not_found' } | { kind: 'incomplete'; retryAt?: number }
	>;
};

export function createMemoryRunCardRepository(
	destination?: RunCardDestination,
): RunCardRepository & { get(submissionId: string): RunCardDeliveryRecord | undefined } {
	const records = new Map<string, RunCardDeliveryRecord>();
	let currentDestination = destination;
	let activeSubmission: string | undefined;
	let legacyMigrated = false;
	return {
		destination: () => currentDestination,
		setDestination: (next) => {
			currentDestination = next;
		},
		legacyMigrationComplete: () => legacyMigrated,
		markLegacyMigrationComplete: () => {
			legacyMigrated = true;
		},
		activeSubmissionId: () => activeSubmission,
		setActiveSubmissionId: (submissionId) => {
			activeSubmission = submissionId;
		},
		get: (submissionId) => records.get(submissionId),
		put: (record) => {
			records.set(record.submissionId, structuredClone(record));
		},
		pending: () =>
			[...records.values()]
				.filter(needsDelivery)
				.toSorted((left, right) => left.desired.startedAt - right.desired.startedAt)
				.map((record) => structuredClone(record)),
	};
}

export function recordCardEvent(
	repository: RunCardRepository,
	event: CardEvent,
	now = Date.now(),
): RunCardDeliveryRecord | undefined {
	const submissionId = eventSubmissionId(repository, event);
	if (submissionId === undefined) return undefined;
	if (event.type === 'submission_running') repository.setActiveSubmissionId(submissionId);

	const previous = repository.get(submissionId);
	const applied = applyCardEvent(previous?.desired ?? null, event, now);
	if (applied === undefined) return previous;
	const desired = applied.state;
	const changed = previous === undefined || desiredChanged(previous.desired, desired);
	const notificationText = applied.notify ?? previous?.notificationText;
	const notificationChanged =
		notificationText !== undefined && notificationText !== previous?.notificationText;
	const record: RunCardDeliveryRecord = {
		submissionId,
		desired,
		desiredRevision: (previous?.desiredRevision ?? 0) + (changed ? 1 : 0),
		deliveredRevision: previous?.deliveredRevision ?? 0,
		messageTs: previous?.messageTs ?? null,
		cardPostState: previous?.cardPostState ?? 'pending',
		notificationText,
		notificationTs: previous?.notificationTs ?? null,
		notificationPostState: notificationChanged
			? 'pending'
			: (previous?.notificationPostState ?? 'none'),
		nextAttemptAt: previous?.nextAttemptAt ?? 0,
	};
	if (record.desiredRevision === 0) return previous;
	repository.put(record);
	return record;
}

export async function deliverPendingRunCards(
	repository: RunCardRepository,
	port: RunCardDeliveryPort,
	now = Date.now(),
): Promise<void> {
	const destination = repository.destination();
	if (destination === undefined) return;
	for (const candidate of repository.pending()) {
		try {
			await deliverCard(repository, port, destination, candidate, now);
		} catch {
			// One unavailable card must not starve later submissions in this outbox.
		}
	}
}

async function deliverCard(
	repository: RunCardRepository,
	port: RunCardDeliveryPort,
	destination: RunCardDestination,
	candidate: RunCardDeliveryRecord,
	now: number,
): Promise<void> {
	let record = repository.get(candidate.submissionId);
	if (record === undefined) return;
	if (record.nextAttemptAt > now) return;

	if (record.messageTs === null) {
		if (record.cardPostState === 'unknown') {
			const found = await port.findPostedMessage({
				channel: destination.channelId,
				threadTs: destination.threadTs,
				submissionId: record.submissionId,
				kind: 'card',
			});
			if (found.kind !== 'found') {
				const latest = repository.get(record.submissionId);
				if (latest !== undefined) {
					repository.put({
						...latest,
						nextAttemptAt:
							found.kind === 'incomplete'
								? (found.retryAt ?? now + DELIVERY_RETRY_DELAY_MS)
								: now + DELIVERY_RETRY_DELAY_MS,
					});
				}
				return;
			}
			const latest = repository.get(record.submissionId);
			if (latest === undefined) return;
			record = {
				...latest,
				messageTs: found.ts,
				cardPostState: 'posted',
				nextAttemptAt: 0,
			};
			repository.put(record);
		} else {
			const postedRevision = record.desiredRevision;
			repository.put({ ...record, cardPostState: 'unknown' });
			const rendered = renderRunCard(record.desired, now);
			const posted = await port.postCard({
				channel: destination.channelId,
				threadTs: destination.threadTs,
				text: rendered.text,
				blocks: rendered.blocks,
				submissionId: record.submissionId,
			});
			if (posted.kind === 'unknown') {
				const latest = repository.get(record.submissionId);
				if (latest !== undefined) {
					repository.put({ ...latest, nextAttemptAt: now + DELIVERY_RETRY_DELAY_MS });
				}
				return;
			}
			if (posted.kind === 'rejected') {
				const latest = repository.get(record.submissionId);
				if (latest !== undefined) {
					repository.put({
						...latest,
						cardPostState: 'pending',
						nextAttemptAt: posted.retryAt ?? now + DELIVERY_RETRY_DELAY_MS,
					});
				}
				return;
			}
			const latest = repository.get(record.submissionId);
			if (latest === undefined) return;
			record = {
				...latest,
				messageTs: posted.ts,
				cardPostState: 'posted',
				deliveredRevision: Math.max(latest.deliveredRevision, postedRevision),
				nextAttemptAt: 0,
			};
			repository.put(record);
		}
	}

	record = repository.get(candidate.submissionId);
	if (record === undefined || record.messageTs === null) return;
	if (record.deliveredRevision < record.desiredRevision) {
		const revision = record.desiredRevision;
		const rendered = renderRunCard(record.desired, now);
		try {
			await port.updateCard({
				channel: destination.channelId,
				ts: record.messageTs,
				text: rendered.text,
				blocks: rendered.blocks,
				submissionId: record.submissionId,
			});
		} catch (error) {
			const retryAt = deliveryRetryAt(error);
			const latest = repository.get(record.submissionId);
			if (latest !== undefined) {
				repository.put({
					...latest,
					nextAttemptAt: retryAt ?? now + DELIVERY_RETRY_DELAY_MS,
				});
			}
			return;
		}
		const latest = repository.get(record.submissionId);
		if (latest !== undefined) {
			repository.put({ ...latest, deliveredRevision: revision, nextAttemptAt: 0 });
		}
	}

	record = repository.get(candidate.submissionId);
	if (
		record?.notificationText === undefined ||
		record.notificationPostState === 'none' ||
		record.notificationPostState === 'posted'
	) {
		return;
	}
	if (record.notificationPostState === 'unknown') {
		const found = await port.findPostedMessage({
			channel: destination.channelId,
			threadTs: destination.threadTs,
			submissionId: record.submissionId,
			kind: 'notification',
		});
		if (found.kind !== 'found') {
			const latest = repository.get(record.submissionId);
			if (latest !== undefined) {
				repository.put({
					...latest,
					nextAttemptAt:
						found.kind === 'incomplete'
							? (found.retryAt ?? now + DELIVERY_RETRY_DELAY_MS)
							: now + DELIVERY_RETRY_DELAY_MS,
				});
			}
			return;
		}
		const latest = repository.get(record.submissionId);
		if (latest === undefined) return;
		repository.put({
			...latest,
			notificationTs: found.ts,
			notificationPostState: 'posted',
			nextAttemptAt: 0,
		});
		return;
	}

	repository.put({ ...record, notificationPostState: 'unknown' });
	const posted = await port.postNotification({
		channel: destination.channelId,
		threadTs: destination.threadTs,
		text: record.notificationText,
		submissionId: record.submissionId,
	});
	if (posted.kind === 'posted') {
		const latest = repository.get(record.submissionId);
		if (latest === undefined) return;
		repository.put({
			...latest,
			notificationTs: posted.ts,
			notificationPostState: 'posted',
			nextAttemptAt: 0,
		});
	} else if (posted.kind === 'rejected') {
		const latest = repository.get(record.submissionId);
		if (latest !== undefined) {
			repository.put({
				...latest,
				notificationPostState: 'pending',
				nextAttemptAt: posted.retryAt ?? now + DELIVERY_RETRY_DELAY_MS,
			});
		}
	} else {
		const latest = repository.get(record.submissionId);
		if (latest !== undefined) {
			repository.put({ ...latest, nextAttemptAt: now + DELIVERY_RETRY_DELAY_MS });
		}
	}
}

function deliveryRetryAt(error: unknown): number | undefined {
	if (typeof error !== 'object' || error === null || !('retryAt' in error)) return undefined;
	return typeof error.retryAt === 'number' ? error.retryAt : undefined;
}

function eventSubmissionId(repository: RunCardRepository, event: CardEvent): string | undefined {
	if ('submissionId' in event && event.submissionId !== undefined) return event.submissionId;
	if (event.type === 'hydration') return repository.activeSubmissionId();
	return undefined;
}

function desiredChanged(previous: RunCardDesired, next: RunCardDesired): boolean {
	return (
		previous.status !== next.status ||
		previous.step !== next.step ||
		previous.branchUrl !== next.branchUrl ||
		previous.prUrl !== next.prUrl
	);
}

function needsDelivery(record: RunCardDeliveryRecord): boolean {
	return (
		record.messageTs === null ||
		record.deliveredRevision < record.desiredRevision ||
		record.notificationPostState === 'pending' ||
		record.notificationPostState === 'unknown'
	);
}

export function applyCardEvent(
	state: RunCardDesired | null,
	event: CardEvent,
	now: number,
): CardApply | undefined {
	switch (event.type) {
		case 'submission_queued':
			return beginOrRefresh(state, event.submissionId, 'queued', 'Queued', now);
		case 'submission_running':
			return beginOrRefresh(state, event.submissionId, 'working', 'Working', now);
		case 'hydration': {
			const step =
				event.phase === 'start'
					? 'Hydrating workspace'
					: event.skipped
						? 'Workspace ready'
						: 'Workspace hydrated';
			const status: CardStatus = event.phase === 'start' ? 'hydrating' : 'working';
			if (state === null) return undefined;
			if (isTerminal(state.status)) return undefined;
			return { state: { ...state, status, step } };
		}
		case 'tool_start': {
			if (state === null || isTerminal(state.status) || event.submissionId !== state.submissionId) {
				return undefined;
			}
			return {
				state: {
					...state,
					status: 'working',
					step: STEP_BY_TOOL[event.toolName] ?? `Running ${event.toolName}`,
				},
			};
		}
		case 'tool': {
			if (state === null || isTerminal(state.status) || event.submissionId !== state.submissionId) {
				return undefined;
			}
			const links = linksFromTool(event.toolName, event.result);
			if (links.branchUrl === undefined && links.prUrl === undefined) return undefined;
			return {
				state: {
					...state,
					branchUrl: links.branchUrl ?? state.branchUrl,
					prUrl: links.prUrl ?? state.prUrl,
				},
			};
		}
		case 'submission_settled': {
			if (state !== null && state.submissionId !== event.submissionId) return undefined;
			const base =
				state !== null
					? state
					: {
							submissionId: event.submissionId,
							status: 'working' as const,
							step: 'Working',
							startedAt: now,
						};
			const next = settle(
				{ ...base, submissionId: event.submissionId },
				event.outcome,
				event.error,
			);
			return { state: next.state, notify: next.notify };
		}
		default: {
			const _exhaustive: never = event;
			return _exhaustive;
		}
	}
}

export function renderRunCard(
	state: RunCardDesired,
	now: number,
): { text: string; blocks: SlackBlock[] } {
	const statusLabel = statusText(state.status);
	const elapsed = formatElapsed(now - state.startedAt);
	const text = `${statusLabel} · ${state.step} · ${elapsed}`;
	const links: string[] = [];
	if (state.branchUrl) links.push(`<${state.branchUrl}|branch>`);
	if (state.prUrl) links.push(`<${state.prUrl}|pull request>`);
	const blocks: SlackBlock[] = [
		{
			type: 'section',
			text: {
				type: 'mrkdwn',
				text: `${statusEmoji(state.status)} *${statusLabel}*  ·  ${escapeMrkdwn(state.step)}  ·  \`${elapsed}\``,
			},
		},
	];
	if (links.length > 0) {
		blocks.push({
			type: 'context',
			elements: [{ type: 'mrkdwn', text: links.join('  ·  ') }],
		});
	}
	return { text, blocks };
}

export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function beginOrRefresh(
	state: RunCardDesired | null,
	submissionId: string,
	status: CardStatus,
	step: string,
	now: number,
): CardApply {
	if (state !== null && state.submissionId === submissionId) {
		if (isTerminal(state.status) || statusRank(status) < statusRank(state.status)) {
			return { state };
		}
		return { state: { ...state, status, step } };
	}
	return {
		state: {
			submissionId,
			status,
			step,
			startedAt: now,
		},
	};
}

function statusRank(status: CardStatus): number {
	switch (status) {
		case 'queued':
			return 0;
		case 'hydrating':
			return 1;
		case 'working':
			return 2;
		case 'completed':
		case 'failed':
		case 'aborted':
			return 3;
		default: {
			const _exhaustive: never = status;
			return _exhaustive;
		}
	}
}

function settle(
	state: RunCardDesired,
	outcome: 'completed' | 'failed' | 'aborted',
	error: string | undefined,
): { state: RunCardDesired; notify?: string } {
	if (outcome === 'completed') {
		const step = state.prUrl ? 'Pull request opened' : 'Completed';
		const notify = state.prUrl ? `Done: ${state.prUrl}` : undefined;
		return { state: { ...state, status: 'completed', step }, notify };
	}
	if (outcome === 'aborted') {
		return { state: { ...state, status: 'aborted', step: 'Aborted' }, notify: 'Aborted.' };
	}
	const detail = error && error.length > 0 ? truncate(error, 200) : 'see thread';
	return {
		state: { ...state, status: 'failed', step: `Failed: ${detail}` },
		notify: `Failed: ${detail}`,
	};
}

function linksFromTool(toolName: string, result: unknown): { branchUrl?: string; prUrl?: string } {
	const url = findHtmlUrl(result);
	if (url === undefined) return {};
	if (toolName === 'open_pull_request') return { prUrl: url };
	if (toolName === 'checkpoint_working_branch' || toolName === 'create_working_branch') {
		return { branchUrl: url };
	}
	return {};
}

function findHtmlUrl(value: unknown): string | undefined {
	if (typeof value === 'string' && value.startsWith('https://github.com/')) return value;
	if (!isRecord(value)) return undefined;
	if (typeof value.htmlUrl === 'string' && value.htmlUrl.startsWith('https://github.com/')) {
		return value.htmlUrl;
	}
	if (value.output !== undefined) return findHtmlUrl(value.output);
	if (value.details !== undefined) return findHtmlUrl(value.details);
	if (value.result !== undefined) return findHtmlUrl(value.result);
	return undefined;
}

function isTerminal(status: CardStatus): boolean {
	return status === 'completed' || status === 'failed' || status === 'aborted';
}

function statusText(status: CardStatus): string {
	switch (status) {
		case 'queued':
			return 'Queued';
		case 'hydrating':
			return 'Hydrating';
		case 'working':
			return 'Working';
		case 'completed':
			return 'Completed';
		case 'failed':
			return 'Failed';
		case 'aborted':
			return 'Aborted';
		default: {
			const _exhaustive: never = status;
			return _exhaustive;
		}
	}
}

function statusEmoji(status: CardStatus): string {
	switch (status) {
		case 'queued':
			return ':hourglass:';
		case 'hydrating':
		case 'working':
			return ':gear:';
		case 'completed':
			return ':white_check_mark:';
		case 'failed':
			return ':x:';
		case 'aborted':
			return ':stop_sign:';
		default: {
			const _exhaustive: never = status;
			return _exhaustive;
		}
	}
}

function escapeMrkdwn(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
