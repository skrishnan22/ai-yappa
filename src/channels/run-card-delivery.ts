import { WebAPIPlatformError, WebAPIRateLimitedError, WebClient } from '@slack/web-api';
import {
	createMemoryRunCardRepository,
	deliverPendingRunCards,
	recordCardEvent,
	type CardEvent,
	type RunCardDeliveryPort,
	type RunCardDeliveryRecord,
	type RunCardDesired,
	type RunCardDestination,
	type RunCardPostResult,
	type RunCardRepository,
	type LegacyRunCardState,
} from './run-card.ts';
import { slackFetch } from './slack-reply.ts';

export type RunCardSqlStorage = {
	exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> };
};

type DeliveryBinding = {
	token?: string;
	port?: RunCardDeliveryPort;
};

const bindings = new Map<string, DeliveryBinding>();
const memoryRepositories = new Map<string, RunCardRepository>();
const deliveryChains = new Map<string, Promise<void>>();
const slackPorts = new Map<string, RunCardDeliveryPort>();
const sqlRepositories = new Map<string, RunCardRepository>();
const retrySchedulers = new Map<string, () => Promise<void>>();

export function bindDurableRunCards(args: {
	instanceId: string;
	channelId: string;
	threadTs: string;
	token?: string;
	legacyState?: LegacyRunCardState | null;
	port?: RunCardDeliveryPort;
}): void {
	const repository = repositoryFor(args.instanceId);
	repository.setDestination({ channelId: args.channelId, threadTs: args.threadTs });
	if (args.legacyState !== undefined && args.legacyState !== null) {
		migrateLegacyRunCardState(repository, args.legacyState);
	}
	bindings.set(args.instanceId, { token: args.token, port: args.port });
	void Promise.all([ensureRetryScheduled(args.instanceId), drain(args.instanceId, repository)]);
}

export function enqueueDurableCardEvent(
	event: CardEvent & { readonly instanceId: string },
	now = Date.now(),
): Promise<void> {
	const repository = repositoryFor(event.instanceId);
	recordCardEvent(repository, event, now);
	return Promise.all([
		ensureRetryScheduled(event.instanceId),
		drain(event.instanceId, repository),
	]).then(() => undefined);
}

export function enqueueHydrationCardEvent(
	instanceId: string,
	phase: 'start' | 'done',
	options?: { skipped?: boolean; now?: number },
): Promise<void> {
	return enqueueDurableCardEvent(
		{
			instanceId,
			type: 'hydration',
			phase,
			...(options?.skipped === undefined ? {} : { skipped: options.skipped }),
		},
		options?.now,
	);
}

export async function withHydrationCardProgress<T extends { skipped: boolean }>(
	instanceId: string,
	hydrate: () => Promise<T>,
): Promise<T> {
	reportHydrationCardEvent(instanceId, 'start');
	const result = await hydrate();
	reportHydrationCardEvent(instanceId, 'done', result.skipped);
	return result;
}

export async function resumeDurableRunCardDelivery(
	instanceId: string,
	token?: string,
): Promise<void> {
	if (token !== undefined) bindings.set(instanceId, { token });
	await drain(instanceId, repositoryFor(instanceId));
}

export async function runScheduledRunCardRetry(
	instanceId: string,
	token: string | undefined,
	reschedule: () => Promise<void>,
): Promise<void> {
	await resumeDurableRunCardDelivery(instanceId, token);
	if (hasPendingRunCardDelivery(instanceId)) await reschedule();
}

export function registerRunCardSql(instanceId: string, sql: RunCardSqlStorage): void {
	sqlRepositories.set(instanceId, new SqlRunCardRepository(sql));
}

export function registerRunCardRetryScheduler(
	instanceId: string,
	schedule: () => Promise<void>,
): void {
	retrySchedulers.set(instanceId, schedule);
}

export function hasPendingRunCardDelivery(instanceId: string): boolean {
	return repositoryFor(instanceId).pending().length > 0;
}

export function resetDurableRunCardsForTests(): void {
	bindings.clear();
	memoryRepositories.clear();
	deliveryChains.clear();
	slackPorts.clear();
	sqlRepositories.clear();
	retrySchedulers.clear();
}

async function ensureRetryScheduled(instanceId: string): Promise<void> {
	const schedule = retrySchedulers.get(instanceId);
	if (schedule === undefined || !hasPendingRunCardDelivery(instanceId)) return;
	try {
		await schedule();
	} catch {
		logDeliveryFailure(instanceId, undefined, 'schedule-retry', 'unknown');
	}
}

function drain(instanceId: string, repository: RunCardRepository): Promise<void> {
	const previous = deliveryChains.get(instanceId) ?? Promise.resolve();
	const next = previous
		.catch(() => undefined)
		.then(async () => {
			const binding = bindings.get(instanceId);
			const port =
				binding?.port ?? (binding?.token ? slackPort(instanceId, binding.token) : undefined);
			if (port === undefined) return undefined;
			await deliverPendingRunCards(repository, port);
			return undefined;
		})
		.catch((error: unknown) => {
			logDeliveryFailure(instanceId, undefined, 'drain', slackErrorCode(error));
		});
	deliveryChains.set(instanceId, next);
	return next;
}

function reportHydrationCardEvent(
	instanceId: string,
	phase: 'start' | 'done',
	skipped?: boolean,
): void {
	try {
		void enqueueHydrationCardEvent(instanceId, phase, { skipped }).catch((error: unknown) => {
			logDeliveryFailure(instanceId, undefined, `hydration-${phase}`, slackErrorCode(error));
		});
	} catch (error) {
		logDeliveryFailure(instanceId, undefined, `hydration-${phase}`, slackErrorCode(error));
	}
}

function repositoryFor(instanceId: string): RunCardRepository {
	const durable = sqlRepositories.get(instanceId);
	if (durable !== undefined) return durable;
	if (isCloudflareWorker()) {
		throw new Error('Run-card SQL storage was not registered for this conversation.');
	}
	let repository = memoryRepositories.get(instanceId);
	if (repository === undefined) {
		repository = createMemoryRunCardRepository();
		memoryRepositories.set(instanceId, repository);
	}
	return repository;
}

class SqlRunCardRepository implements RunCardRepository {
	readonly #sql: RunCardSqlStorage;

	constructor(sql: RunCardSqlStorage) {
		this.#sql = sql;
		this.#sql.exec(`
			CREATE TABLE IF NOT EXISTS slack_agent_run_card_meta (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				channel_id TEXT,
				thread_ts TEXT,
				active_submission_id TEXT,
				legacy_migrated INTEGER NOT NULL DEFAULT 0
			)
		`);
		this.#sql.exec(`
			CREATE TABLE IF NOT EXISTS slack_agent_run_cards (
				submission_id TEXT PRIMARY KEY,
				desired_json TEXT NOT NULL,
				desired_revision INTEGER NOT NULL,
				delivered_revision INTEGER NOT NULL,
				message_ts TEXT,
				card_post_state TEXT NOT NULL,
				notification_text TEXT,
				notification_ts TEXT,
				notification_post_state TEXT NOT NULL,
				next_attempt_at INTEGER NOT NULL DEFAULT 0
			)
		`);
		this.#sql.exec('INSERT OR IGNORE INTO slack_agent_run_card_meta (id) VALUES (1)');
	}

	destination(): RunCardDestination | undefined {
		const row = this.#sql
			.exec('SELECT channel_id, thread_ts FROM slack_agent_run_card_meta WHERE id = 1')
			.toArray()[0];
		return typeof row?.channel_id === 'string' && typeof row.thread_ts === 'string'
			? { channelId: row.channel_id, threadTs: row.thread_ts }
			: undefined;
	}

	setDestination(destination: RunCardDestination): void {
		this.#sql.exec(
			'UPDATE slack_agent_run_card_meta SET channel_id = ?, thread_ts = ? WHERE id = 1',
			destination.channelId,
			destination.threadTs,
		);
	}

	legacyMigrationComplete(): boolean {
		const row = this.#sql
			.exec('SELECT legacy_migrated FROM slack_agent_run_card_meta WHERE id = 1')
			.toArray()[0];
		if (row?.legacy_migrated === 0) return false;
		if (row?.legacy_migrated === 1) return true;
		throw new Error('Stored run-card migration state is invalid.');
	}

	markLegacyMigrationComplete(): void {
		this.#sql.exec('UPDATE slack_agent_run_card_meta SET legacy_migrated = 1 WHERE id = 1');
	}

	activeSubmissionId(): string | undefined {
		const row = this.#sql
			.exec('SELECT active_submission_id FROM slack_agent_run_card_meta WHERE id = 1')
			.toArray()[0];
		return typeof row?.active_submission_id === 'string' ? row.active_submission_id : undefined;
	}

	setActiveSubmissionId(submissionId: string): void {
		this.#sql.exec(
			'UPDATE slack_agent_run_card_meta SET active_submission_id = ? WHERE id = 1',
			submissionId,
		);
	}

	get(submissionId: string): RunCardDeliveryRecord | undefined {
		const row = this.#sql
			.exec('SELECT * FROM slack_agent_run_cards WHERE submission_id = ?', submissionId)
			.toArray()[0];
		return row === undefined ? undefined : recordFromRow(row);
	}

	put(record: RunCardDeliveryRecord): void {
		this.#sql.exec(
			`INSERT INTO slack_agent_run_cards (
				submission_id, desired_json, desired_revision, delivered_revision,
				message_ts, card_post_state, notification_text, notification_ts,
				notification_post_state, next_attempt_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(submission_id) DO UPDATE SET
				desired_json = excluded.desired_json,
				desired_revision = excluded.desired_revision,
				delivered_revision = excluded.delivered_revision,
				message_ts = excluded.message_ts,
				card_post_state = excluded.card_post_state,
				notification_text = excluded.notification_text,
				notification_ts = excluded.notification_ts,
				notification_post_state = excluded.notification_post_state,
				next_attempt_at = excluded.next_attempt_at`,
			record.submissionId,
			JSON.stringify(record.desired),
			record.desiredRevision,
			record.deliveredRevision,
			record.messageTs,
			record.cardPostState,
			record.notificationText ?? null,
			record.notificationTs,
			record.notificationPostState,
			record.nextAttemptAt,
		);
	}

	pending(): RunCardDeliveryRecord[] {
		return this.#sql
			.exec(
				`SELECT * FROM slack_agent_run_cards
				 WHERE message_ts IS NULL
				    OR delivered_revision < desired_revision
				    OR notification_post_state IN ('pending', 'unknown')
				 ORDER BY submission_id`,
			)
			.toArray()
			.map(recordFromRow);
	}
}

function recordFromRow(row: Record<string, unknown>): RunCardDeliveryRecord {
	if (
		typeof row.submission_id !== 'string' ||
		typeof row.desired_json !== 'string' ||
		typeof row.desired_revision !== 'number' ||
		typeof row.delivered_revision !== 'number' ||
		(row.message_ts !== null && typeof row.message_ts !== 'string') ||
		typeof row.card_post_state !== 'string' ||
		(row.notification_text !== null && typeof row.notification_text !== 'string') ||
		(row.notification_ts !== null && typeof row.notification_ts !== 'string') ||
		typeof row.notification_post_state !== 'string' ||
		typeof row.next_attempt_at !== 'number'
	) {
		throw new Error('Stored run-card delivery record is invalid.');
	}
	const desired = parseDesired(row.desired_json);
	if (desired === undefined) throw new Error('Stored run-card desired state is invalid.');
	return {
		submissionId: row.submission_id,
		desired,
		desiredRevision: row.desired_revision,
		deliveredRevision: row.delivered_revision,
		messageTs: row.message_ts,
		cardPostState: parsePostState(row.card_post_state, false),
		notificationText: row.notification_text ?? undefined,
		notificationTs: row.notification_ts,
		notificationPostState: parsePostState(row.notification_post_state, true),
		nextAttemptAt: row.next_attempt_at,
	};
}

function parseDesired(json: string): RunCardDesired | undefined {
	try {
		const value: unknown = JSON.parse(json);
		if (!isRecord(value)) return undefined;
		if (typeof value.submissionId !== 'string') return undefined;
		if (!isCardStatus(value.status)) return undefined;
		if (typeof value.step !== 'string' || typeof value.startedAt !== 'number') return undefined;
		if (value.branchUrl !== undefined && typeof value.branchUrl !== 'string') return undefined;
		if (value.prUrl !== undefined && typeof value.prUrl !== 'string') return undefined;
		return {
			submissionId: value.submissionId,
			status: value.status,
			step: value.step,
			startedAt: value.startedAt,
			...(value.branchUrl === undefined ? {} : { branchUrl: value.branchUrl }),
			...(value.prUrl === undefined ? {} : { prUrl: value.prUrl }),
		};
	} catch {
		return undefined;
	}
}

function parsePostState(value: string, allowNone: false): 'pending' | 'unknown' | 'posted';
function parsePostState(value: string, allowNone: true): 'none' | 'pending' | 'unknown' | 'posted';
function parsePostState(
	value: string,
	allowNone: boolean,
): 'none' | 'pending' | 'unknown' | 'posted' {
	if (value === 'pending' || value === 'unknown' || value === 'posted') return value;
	if (allowNone && value === 'none') return value;
	throw new Error('Stored run-card delivery state is invalid.');
}

export function migrateLegacyRunCardState(
	repository: RunCardRepository,
	legacy: LegacyRunCardState,
): void {
	if (repository.legacyMigrationComplete()) return;
	if (legacy.submissionId === 'active') {
		// The old synthetic identity carries no Flue submission ID. Keep the
		// original hook state as evidence instead of assigning its message to a later run.
		repository.markLegacyMigrationComplete();
		return;
	}
	const submissionId = legacy.submissionId;
	const { messageTs, notifyPosted, submissionId: _legacySubmissionId, ...legacyDesired } = legacy;
	const desired: RunCardDesired = { ...legacyDesired, submissionId };
	const notificationText = terminalNotification(desired);
	const existing = repository.get(submissionId);
	if (existing !== undefined) {
		repository.put({
			...existing,
			messageTs: existing.messageTs ?? messageTs,
			cardPostState:
				existing.messageTs !== null || messageTs !== null ? 'posted' : existing.cardPostState,
			notificationText: existing.notificationText ?? notificationText,
			notificationPostState: notifyPosted
				? 'posted'
				: existing.notificationPostState !== 'none'
					? existing.notificationPostState
					: notificationText === undefined
						? 'none'
						: 'unknown',
			nextAttemptAt: existing.nextAttemptAt,
		});
		repository.markLegacyMigrationComplete();
		return;
	}
	repository.put({
		submissionId,
		desired,
		desiredRevision: 1,
		deliveredRevision: messageTs === null ? 0 : 1,
		messageTs,
		cardPostState: messageTs === null ? 'unknown' : 'posted',
		notificationText,
		notificationTs: null,
		notificationPostState:
			notificationText === undefined ? 'none' : notifyPosted ? 'posted' : 'unknown',
		nextAttemptAt: 0,
	});
	repository.markLegacyMigrationComplete();
}

function terminalNotification(state: RunCardDesired): string | undefined {
	if (state.status === 'completed' && state.prUrl) return `Done: ${state.prUrl}`;
	if (state.status === 'failed') return state.step.startsWith('Failed:') ? state.step : 'Failed.';
	if (state.status === 'aborted') return 'Aborted.';
	return undefined;
}

function slackPort(instanceId: string, token: string): RunCardDeliveryPort {
	const portKey = `${instanceId}\u0000${token}`;
	let port = slackPorts.get(portKey);
	if (port !== undefined) return port;
	const client = new WebClient(token, {
		retryConfig: { retries: 0 },
		rejectRateLimitedCalls: true,
		fetch: slackFetch,
		timeout: 10_000,
	});
	let botId: Promise<string | undefined> | undefined;
	port = {
		async postCard(args) {
			const result = await postWithIdentity(client, {
				channel: args.channel,
				thread_ts: args.threadTs,
				text: args.text,
				blocks: args.blocks,
				metadata: messageMetadata(args.submissionId, 'card'),
			});
			if (result.kind !== 'posted') {
				logDeliveryFailure(instanceId, args.submissionId, 'post-card', result.code ?? result.kind);
			}
			return result;
		},
		async updateCard(args) {
			try {
				await client.chat.update({
					channel: args.channel,
					ts: args.ts,
					text: args.text,
					blocks: args.blocks,
				});
			} catch (error) {
				logDeliveryFailure(instanceId, args.submissionId, 'update-card', slackErrorCode(error));
				if (error instanceof WebAPIRateLimitedError) {
					throw new RunCardRateLimitError(Date.now() + error.retryAfter * 1_000);
				}
				throw error;
			}
		},
		async postNotification(args) {
			const result = await postWithIdentity(client, {
				channel: args.channel,
				thread_ts: args.threadTs,
				text: args.text,
				metadata: messageMetadata(args.submissionId, 'notification'),
			});
			if (result.kind !== 'posted') {
				logDeliveryFailure(
					instanceId,
					args.submissionId,
					'post-notification',
					result.code ?? result.kind,
				);
			}
			return result;
		},
		async findPostedMessage(args) {
			let expectedBotId: string | undefined;
			try {
				botId ??= client.auth
					.test()
					.then((result) => (typeof result.bot_id === 'string' ? result.bot_id : undefined));
				expectedBotId = await botId;
			} catch (error) {
				botId = undefined;
				logDeliveryFailure(instanceId, args.submissionId, 'reconcile-auth', slackErrorCode(error));
				return { kind: 'incomplete', retryAt: retryAtFor(error) };
			}
			if (expectedBotId === undefined) return { kind: 'incomplete' };
			let cursor: string | undefined;
			try {
				do {
					const page = await client.conversations.replies({
						channel: args.channel,
						ts: args.threadTs,
						limit: 100,
						include_all_metadata: true,
						...(cursor === undefined ? {} : { cursor }),
					});
					for (const message of page.messages ?? []) {
						if (
							message.bot_id === expectedBotId &&
							message.ts &&
							matchesMetadata(message.metadata, args.submissionId, args.kind)
						) {
							return { kind: 'found', ts: message.ts };
						}
					}
					cursor = page.response_metadata?.next_cursor?.trim() || undefined;
				} while (cursor !== undefined);
				return { kind: 'not_found' };
			} catch (error) {
				logDeliveryFailure(
					instanceId,
					args.submissionId,
					`reconcile-${args.kind}`,
					slackErrorCode(error),
				);
				return { kind: 'incomplete', retryAt: retryAtFor(error) };
			}
		},
	};
	slackPorts.set(portKey, port);
	return port;
}

async function postWithIdentity(
	client: WebClient,
	args: Parameters<WebClient['chat']['postMessage']>[0],
): Promise<RunCardPostResult> {
	try {
		const result = await client.chat.postMessage(args);
		return typeof result.ts === 'string' ? { kind: 'posted', ts: result.ts } : { kind: 'unknown' };
	} catch (error) {
		return classifySlackPostError(error);
	}
}

export function classifySlackPostError(
	error: unknown,
): Exclude<RunCardPostResult, { kind: 'posted' }> {
	if (error instanceof WebAPIRateLimitedError) {
		return {
			kind: 'rejected',
			retryAt: Date.now() + error.retryAfter * 1_000,
			code: 'rate_limited',
		};
	}
	if (error instanceof WebAPIPlatformError) {
		return error.data.error === 'internal_error' || error.data.error === 'fatal_error'
			? { kind: 'unknown', code: error.data.error }
			: { kind: 'rejected', code: error.data.error };
	}
	return { kind: 'unknown', code: slackErrorCode(error) };
}

function messageMetadata(submissionId: string, kind: 'card' | 'notification') {
	return {
		event_type: 'slack_agent.run_card',
		event_payload: { version: 1, submission_id: submissionId, kind },
	};
}

function matchesMetadata(
	value: unknown,
	submissionId: string,
	kind: 'card' | 'notification',
): boolean {
	if (!isRecord(value) || value.event_type !== 'slack_agent.run_card') return false;
	const payload = value.event_payload;
	return (
		isRecord(payload) &&
		payload.version === 1 &&
		payload.submission_id === submissionId &&
		payload.kind === kind
	);
}

function isCardStatus(value: unknown): value is RunCardDesired['status'] {
	return (
		value === 'queued' ||
		value === 'hydrating' ||
		value === 'working' ||
		value === 'completed' ||
		value === 'failed' ||
		value === 'aborted'
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function slackErrorCode(error: unknown): string {
	if (error instanceof WebAPIPlatformError) return error.data.error;
	if (error instanceof WebAPIRateLimitedError) return 'rate_limited';
	if (isRecord(error) && typeof error.code === 'string') return error.code.slice(0, 80);
	return 'unknown';
}

function retryAtFor(error: unknown): number | undefined {
	return error instanceof WebAPIRateLimitedError
		? Date.now() + error.retryAfter * 1_000
		: undefined;
}

function logDeliveryFailure(
	conversationId: string,
	submissionId: string | undefined,
	operation: string,
	code: string,
): void {
	console.warn('Run-card delivery pending.', {
		conversationId,
		...(submissionId === undefined ? {} : { submissionId }),
		operation,
		code,
	});
}

function isCloudflareWorker(): boolean {
	return typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
}

class RunCardRateLimitError extends Error {
	readonly retryAt: number;

	constructor(retryAt: number) {
		super('Run-card update rate limited.');
		this.retryAt = retryAt;
	}
}
