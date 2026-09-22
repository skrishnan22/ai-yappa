import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, test, vi } from 'vitest';
import { WebAPIPlatformError } from '@slack/web-api';
import {
	resetDurableRunCardsForTests,
	bindDurableRunCards,
	classifySlackPostError,
	enqueueDurableCardEvent,
	migrateLegacyRunCardState,
	hasPendingRunCardDelivery,
	registerRunCardSql,
	resumeDurableRunCardDelivery,
	runScheduledRunCardRetry,
	withHydrationCardProgress,
	type RunCardSqlStorage,
} from './run-card-delivery.ts';
import {
	createMemoryRunCardRepository,
	deliverPendingRunCards,
	recordCardEvent,
	type RunCardDeliveryPort,
} from './run-card.ts';

function port(overrides: Partial<RunCardDeliveryPort> = {}): RunCardDeliveryPort {
	return {
		async postCard() {
			return { kind: 'posted', ts: 'card.ts' };
		},
		async updateCard() {},
		async postNotification() {
			return { kind: 'posted', ts: 'notice.ts' };
		},
		async findPostedMessage() {
			return { kind: 'not_found' };
		},
		...overrides,
	};
}

describe('durable run-card delivery', () => {
	test('keeps a failed update pending and retries the desired revision', async () => {
		const repository = createMemoryRunCardRepository({ channelId: 'C1', threadTs: '1.2' });
		recordCardEvent(repository, { type: 'submission_running', submissionId: 'sub-1' }, 1_000);
		await deliverPendingRunCards(repository, port());

		recordCardEvent(
			repository,
			{ type: 'tool_start', submissionId: 'sub-1', toolName: 'bash' },
			2_000,
		);
		let attempts = 0;
		await deliverPendingRunCards(
			repository,
			port({
				async updateCard() {
					attempts++;
					throw new Error('Slack unavailable');
				},
			}),
			1_000,
		);
		expect(repository.get('sub-1')?.deliveredRevision).toBe(1);

		await deliverPendingRunCards(
			repository,
			port({
				async updateCard() {
					attempts++;
				},
			}),
		);
		expect(attempts).toBe(2);
		expect(repository.get('sub-1')?.deliveredRevision).toBe(2);
	});

	test('honors an update retry time before attempting Slack again', async () => {
		const repository = createMemoryRunCardRepository({ channelId: 'C1', threadTs: '1.2' });
		recordCardEvent(repository, { type: 'submission_running', submissionId: 'sub-1' }, 1_000);
		await deliverPendingRunCards(repository, port(), 1_000);
		recordCardEvent(
			repository,
			{ type: 'tool_start', submissionId: 'sub-1', toolName: 'bash' },
			2_000,
		);
		let attempts = 0;
		const rateLimited = port({
			async updateCard() {
				attempts++;
				throw Object.assign(new Error('rate limited'), { retryAt: 50_000 });
			},
		});
		await deliverPendingRunCards(repository, rateLimited, 2_000);
		await deliverPendingRunCards(repository, rateLimited, 49_999);
		expect(attempts).toBe(1);
		await deliverPendingRunCards(repository, rateLimited, 50_000);
		expect(attempts).toBe(2);
	});

	test('reconciles an accepted post after the sender restarts before receiving its response', async () => {
		const repository = createMemoryRunCardRepository({ channelId: 'C1', threadTs: '1.2' });
		recordCardEvent(repository, { type: 'submission_running', submissionId: 'sub-1' }, 1_000);

		await deliverPendingRunCards(
			repository,
			port({
				async postCard() {
					return { kind: 'unknown' };
				},
			}),
			1_000,
		);
		expect(repository.get('sub-1')?.cardPostState).toBe('unknown');

		let reposts = 0;
		let reconciliations = 0;
		const recoveringPort = port({
			async postCard() {
				reposts++;
				return { kind: 'posted', ts: 'duplicate.ts' };
			},
			async findPostedMessage(args) {
				reconciliations++;
				expect(args).toMatchObject({ submissionId: 'sub-1', kind: 'card' });
				return { kind: 'found', ts: 'recovered.ts' };
			},
		});
		await deliverPendingRunCards(repository, recoveringPort, 2_000);
		expect(reconciliations).toBe(0);
		await deliverPendingRunCards(repository, recoveringPort, 31_001);

		expect(reposts).toBe(0);
		expect(repository.get('sub-1')).toMatchObject({
			messageTs: 'recovered.ts',
			cardPostState: 'posted',
			deliveredRevision: 1,
		});
	});

	test('a post acknowledgement merges into newer desired state without overwriting it', async () => {
		const repository = createMemoryRunCardRepository({ channelId: 'C1', threadTs: '1.2' });
		recordCardEvent(repository, { type: 'submission_running', submissionId: 'sub-1' }, 1_000);
		let release: ((result: { kind: 'posted'; ts: string }) => void) | undefined;
		const posted = new Promise<{ kind: 'posted'; ts: string }>((resolve) => {
			release = resolve;
		});
		const draining = deliverPendingRunCards(
			repository,
			port({
				async postCard() {
					return posted;
				},
			}),
		);

		recordCardEvent(
			repository,
			{
				type: 'tool',
				submissionId: 'sub-1',
				toolName: 'open_pull_request',
				result: { htmlUrl: 'https://github.com/org/repo/pull/8' },
			},
			2_000,
		);
		release?.({ kind: 'posted', ts: 'card.ts' });
		await draining;

		expect(repository.get('sub-1')).toMatchObject({
			desiredRevision: 2,
			deliveredRevision: 2,
			messageTs: 'card.ts',
			desired: { prUrl: 'https://github.com/org/repo/pull/8' },
		});
	});

	test('does not blindly repost when an ambiguous post is absent from a complete history scan', async () => {
		const repository = createMemoryRunCardRepository({ channelId: 'C1', threadTs: '1.2' });
		recordCardEvent(repository, { type: 'submission_running', submissionId: 'sub-1' }, 1_000);
		await deliverPendingRunCards(
			repository,
			port({
				async postCard() {
					return { kind: 'unknown' };
				},
			}),
			1_000,
		);

		let reposts = 0;
		await deliverPendingRunCards(
			repository,
			port({
				async postCard() {
					reposts++;
					return { kind: 'posted', ts: 'duplicate.ts' };
				},
				async findPostedMessage() {
					return { kind: 'not_found' };
				},
			}),
			31_001,
		);

		expect(reposts).toBe(0);
		expect(repository.get('sub-1')?.cardPostState).toBe('unknown');
	});

	test('keeps overlapping submissions and their links isolated', () => {
		const repository = createMemoryRunCardRepository({ channelId: 'C1', threadTs: '1.2' });
		recordCardEvent(repository, { type: 'submission_running', submissionId: 'sub-a' }, 1_000);
		recordCardEvent(repository, { type: 'submission_queued', submissionId: 'sub-b' }, 2_000);
		recordCardEvent(
			repository,
			{
				type: 'tool',
				submissionId: 'sub-a',
				toolName: 'open_pull_request',
				result: { htmlUrl: 'https://github.com/org/repo/pull/7' },
			},
			3_000,
		);

		expect(repository.get('sub-a')?.desired.prUrl).toBe('https://github.com/org/repo/pull/7');
		expect(repository.get('sub-b')?.desired.prUrl).toBeUndefined();
	});

	test('does not reopen a terminal card when submission_running is replayed', () => {
		const repository = createMemoryRunCardRepository({ channelId: 'C1', threadTs: '1.2' });
		recordCardEvent(repository, { type: 'submission_running', submissionId: 'sub-1' }, 1_000);
		recordCardEvent(
			repository,
			{ type: 'submission_settled', submissionId: 'sub-1', outcome: 'completed' },
			2_000,
		);
		recordCardEvent(repository, { type: 'submission_running', submissionId: 'sub-1' }, 3_000);

		expect(repository.get('sub-1')?.desired.status).toBe('completed');
	});

	test('merges a legacy message identity into a newer submission row', () => {
		const repository = createMemoryRunCardRepository({ channelId: 'C1', threadTs: '1.2' });
		recordCardEvent(repository, { type: 'submission_running', submissionId: 'sub-1' }, 2_000);

		migrateLegacyRunCardState(repository, {
			submissionId: 'sub-1',
			messageTs: 'legacy.ts',
			status: 'hydrating',
			step: 'Hydrating workspace',
			startedAt: 1_000,
		});

		expect(repository.get('sub-1')).toMatchObject({
			messageTs: 'legacy.ts',
			deliveredRevision: 0,
			desired: { status: 'working', startedAt: 2_000 },
		});
	});

	test('preserves a legacy terminal notification acknowledgement', () => {
		const repository = createMemoryRunCardRepository({ channelId: 'C1', threadTs: '1.2' });
		recordCardEvent(
			repository,
			{
				type: 'submission_settled',
				submissionId: 'sub-1',
				outcome: 'failed',
				error: 'failed',
			},
			2_000,
		);

		migrateLegacyRunCardState(repository, {
			submissionId: 'sub-1',
			messageTs: 'legacy.ts',
			status: 'failed',
			step: 'Failed: failed',
			startedAt: 1_000,
			notifyPosted: true,
		});

		expect(repository.get('sub-1')?.notificationPostState).toBe('posted');
	});

	test('does not attach an unidentifiable legacy active card to later submissions', () => {
		const repository = createMemoryRunCardRepository({ channelId: 'C1', threadTs: '1.2' });
		recordCardEvent(repository, { type: 'submission_running', submissionId: 'sub-a' }, 2_000);

		const legacy = {
			submissionId: 'active',
			messageTs: 'legacy.ts',
			status: 'hydrating' as const,
			step: 'Hydrating workspace',
			startedAt: 1_000,
		};
		migrateLegacyRunCardState(repository, legacy);
		recordCardEvent(
			repository,
			{ type: 'submission_settled', submissionId: 'sub-a', outcome: 'completed' },
			3_000,
		);
		recordCardEvent(repository, { type: 'submission_running', submissionId: 'sub-b' }, 4_000);
		migrateLegacyRunCardState(repository, legacy);

		expect(repository.get('sub-a')?.messageTs).toBeNull();
		expect(repository.get('sub-b')?.messageTs).toBeNull();
		expect(repository.legacyMigrationComplete()).toBe(true);
	});

	test('persists synthetic legacy migration ownership across SQLite restart', async () => {
		resetDurableRunCardsForTests();
		const directory = mkdtempSync(join(tmpdir(), 'run-card-legacy-'));
		const databasePath = join(directory, 'cards.sqlite');
		let database = new DatabaseSync(databasePath);
		const posts: string[] = [];
		const updates: string[] = [];
		const delivery = port({
			async postCard(args) {
				posts.push(args.submissionId);
				return { kind: 'posted', ts: `${args.submissionId}.ts` };
			},
			async updateCard(args) {
				updates.push(args.ts);
			},
		});
		const legacy = {
			submissionId: 'active',
			messageTs: 'old.ts',
			status: 'hydrating' as const,
			step: 'Hydrating workspace',
			startedAt: 1,
		};
		try {
			registerRunCardSql('conversation', sqliteStorage(database));
			await enqueueDurableCardEvent({
				instanceId: 'conversation',
				type: 'submission_running',
				submissionId: 'sub-a',
			});
			bindDurableRunCards({
				instanceId: 'conversation',
				channelId: 'C1',
				threadTs: '1.2',
				legacyState: legacy,
				port: delivery,
			});
			await resumeDurableRunCardDelivery('conversation');
			expect(
				database.prepare('SELECT legacy_migrated FROM slack_agent_run_card_meta').all()[0]
					?.legacy_migrated,
			).toBe(1);
			database.close();

			resetDurableRunCardsForTests();
			database = new DatabaseSync(databasePath);
			registerRunCardSql('conversation', sqliteStorage(database));
			await enqueueDurableCardEvent({
				instanceId: 'conversation',
				type: 'submission_running',
				submissionId: 'sub-b',
			});
			bindDurableRunCards({
				instanceId: 'conversation',
				channelId: 'C1',
				threadTs: '1.2',
				legacyState: legacy,
				port: delivery,
			});
			await resumeDurableRunCardDelivery('conversation');

			expect(posts).toEqual(['sub-a', 'sub-b']);
			expect(updates).not.toContain('old.ts');
		} finally {
			database.close();
			rmSync(directory, { recursive: true, force: true });
			resetDurableRunCardsForTests();
		}
	});

	test('keeps progress pending when no Slack token is configured', async () => {
		resetDurableRunCardsForTests();
		bindDurableRunCards({
			instanceId: 'conversation',
			channelId: 'C1',
			threadTs: '1.2',
		});
		await expect(
			enqueueDurableCardEvent({
				instanceId: 'conversation',
				type: 'submission_running',
				submissionId: 'sub-1',
			}),
		).resolves.toBeUndefined();
		expect(hasPendingRunCardDelivery('conversation')).toBe(true);
	});

	test('keeps conversations separate and creates one card per sequential submission', async () => {
		resetDurableRunCardsForTests();
		const posts: Array<{ channel: string; threadTs: string; submissionId: string }> = [];
		const capture = port({
			async postCard(args) {
				posts.push(args);
				return { kind: 'posted', ts: `${args.submissionId}.ts` };
			},
		});
		bindDurableRunCards({
			instanceId: 'conversation-a',
			channelId: 'CA',
			threadTs: '1.1',
			port: capture,
		});
		bindDurableRunCards({
			instanceId: 'conversation-b',
			channelId: 'CB',
			threadTs: '2.2',
			port: capture,
		});

		await enqueueDurableCardEvent({
			instanceId: 'conversation-a',
			type: 'submission_running',
			submissionId: 'a-1',
		});
		await enqueueDurableCardEvent({
			instanceId: 'conversation-b',
			type: 'submission_running',
			submissionId: 'b-1',
		});
		await enqueueDurableCardEvent({
			instanceId: 'conversation-a',
			type: 'submission_running',
			submissionId: 'a-2',
		});

		expect(posts).toEqual([
			expect.objectContaining({ channel: 'CA', threadTs: '1.1', submissionId: 'a-1' }),
			expect.objectContaining({ channel: 'CB', threadTs: '2.2', submissionId: 'b-1' }),
			expect.objectContaining({ channel: 'CA', threadTs: '1.1', submissionId: 'a-2' }),
		]);
	});

	test('terminal notification failure remains pending and retries', async () => {
		const repository = createMemoryRunCardRepository({ channelId: 'C1', threadTs: '1.2' });
		recordCardEvent(repository, { type: 'submission_running', submissionId: 'sub-1' }, 1_000);
		await deliverPendingRunCards(repository, port());
		recordCardEvent(
			repository,
			{
				type: 'submission_settled',
				submissionId: 'sub-1',
				outcome: 'failed',
				error: 'boom',
			},
			2_000,
		);

		await deliverPendingRunCards(
			repository,
			port({
				async postNotification() {
					return { kind: 'rejected' };
				},
			}),
			2_000,
		);
		expect(repository.get('sub-1')?.notificationPostState).toBe('pending');

		await deliverPendingRunCards(repository, port(), 32_001);
		expect(repository.get('sub-1')).toMatchObject({
			notificationPostState: 'posted',
			notificationTs: 'notice.ts',
		});
	});

	test('a failed card does not starve a later submission', async () => {
		resetDurableRunCardsForTests();
		const posted: string[] = [];
		bindDurableRunCards({
			instanceId: 'conversation',
			channelId: 'C1',
			threadTs: '1.2',
			port: port({
				async postCard(args) {
					if (args.submissionId === 'sub-1') throw new Error('unavailable');
					posted.push(args.submissionId);
					return { kind: 'posted', ts: 'later.ts' };
				},
			}),
		});
		await enqueueDurableCardEvent({
			instanceId: 'conversation',
			type: 'submission_running',
			submissionId: 'sub-1',
		});
		await enqueueDurableCardEvent({
			instanceId: 'conversation',
			type: 'submission_running',
			submissionId: 'sub-2',
		});

		expect(posted).toContain('sub-2');
	});

	test('active-card update failures do not fail Coworker hydration', async () => {
		resetDurableRunCardsForTests();
		let updates = 0;
		bindDurableRunCards({
			instanceId: 'conversation',
			channelId: 'C1',
			threadTs: '1.2',
			port: port({
				async updateCard() {
					updates++;
					throw new Error('Slack unavailable');
				},
			}),
		});
		await enqueueDurableCardEvent({
			instanceId: 'conversation',
			type: 'submission_running',
			submissionId: 'sub-1',
		});
		let hydrated = false;

		await expect(
			withHydrationCardProgress('conversation', async () => {
				hydrated = true;
				return { skipped: false, workspace: 'hydrated' };
			}),
		).resolves.toEqual({ skipped: false, workspace: 'hydrated' });
		await resumeDurableRunCardDelivery('conversation');

		expect(hydrated).toBe(true);
		expect(updates).toBeGreaterThan(0);
	});

	test('restores pending delivery from SQLite after controller restart', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		resetDurableRunCardsForTests();
		const directory = mkdtempSync(join(tmpdir(), 'run-card-'));
		const databasePath = join(directory, 'cards.sqlite');
		let database = new DatabaseSync(databasePath);
		let failUpdate = true;
		let posts = 0;
		let updates = 0;
		const delivery = port({
			async postCard() {
				posts++;
				return { kind: 'posted', ts: 'card.ts' };
			},
			async updateCard() {
				updates++;
				if (failUpdate) throw new Error('offline');
			},
		});
		try {
			registerRunCardSql('conversation', sqliteStorage(database));
			bindDurableRunCards({
				instanceId: 'conversation',
				channelId: 'C1',
				threadTs: '1.2',
				port: delivery,
			});
			await enqueueDurableCardEvent({
				instanceId: 'conversation',
				type: 'submission_running',
				submissionId: 'sub-1',
			});
			await enqueueDurableCardEvent({
				instanceId: 'conversation',
				type: 'tool_start',
				submissionId: 'sub-1',
				toolName: 'bash',
			});
			database.close();

			resetDurableRunCardsForTests();
			database = new DatabaseSync(databasePath);
			failUpdate = false;
			registerRunCardSql('conversation', sqliteStorage(database));
			bindDurableRunCards({
				instanceId: 'conversation',
				channelId: 'C1',
				threadTs: '1.2',
				port: delivery,
			});
			await resumeDurableRunCardDelivery('conversation');
			expect(updates).toBe(1);

			vi.advanceTimersByTime(31_000);
			await resumeDurableRunCardDelivery('conversation');

			expect(posts).toBe(1);
			expect(updates).toBe(2);
		} finally {
			database.close();
			rmSync(directory, { recursive: true, force: true });
			resetDurableRunCardsForTests();
			vi.useRealTimers();
		}
	});

	test('reschedules pending delivery across callbacks and restart, then stops when clean', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		resetDurableRunCardsForTests();
		const directory = mkdtempSync(join(tmpdir(), 'run-card-schedule-'));
		const databasePath = join(directory, 'cards.sqlite');
		let database = new DatabaseSync(databasePath);
		let unavailable = true;
		let scheduled = 0;
		const delivery = port({
			async postCard() {
				return unavailable ? { kind: 'rejected' } : { kind: 'posted', ts: 'card.ts' };
			},
		});
		const reschedule = async () => {
			scheduled++;
		};
		try {
			registerRunCardSql('conversation', sqliteStorage(database));
			bindDurableRunCards({
				instanceId: 'conversation',
				channelId: 'C1',
				threadTs: '1.2',
				port: delivery,
			});
			await enqueueDurableCardEvent({
				instanceId: 'conversation',
				type: 'submission_running',
				submissionId: 'sub-1',
			});

			vi.advanceTimersByTime(31_000);
			await runScheduledRunCardRetry('conversation', undefined, reschedule);
			expect(scheduled).toBe(1);

			database.close();
			resetDurableRunCardsForTests();
			database = new DatabaseSync(databasePath);
			registerRunCardSql('conversation', sqliteStorage(database));
			bindDurableRunCards({
				instanceId: 'conversation',
				channelId: 'C1',
				threadTs: '1.2',
				port: delivery,
			});
			vi.advanceTimersByTime(31_000);
			await runScheduledRunCardRetry('conversation', undefined, reschedule);
			expect(scheduled).toBe(2);

			unavailable = false;
			vi.advanceTimersByTime(31_000);
			await runScheduledRunCardRetry('conversation', undefined, reschedule);
			expect(scheduled).toBe(2);
		} finally {
			database.close();
			rmSync(directory, { recursive: true, force: true });
			resetDurableRunCardsForTests();
			vi.useRealTimers();
		}
	});

	test('treats Slack internal platform failures as an unknown post outcome', () => {
		const internal = new WebAPIPlatformError({ ok: false, error: 'internal_error' });
		const invalid = new WebAPIPlatformError({ ok: false, error: 'invalid_auth' });

		expect(classifySlackPostError(internal)).toEqual({
			kind: 'unknown',
			code: 'internal_error',
		});
		expect(classifySlackPostError(invalid)).toEqual({
			kind: 'rejected',
			code: 'invalid_auth',
		});
	});
});

function sqliteStorage(database: DatabaseSync): RunCardSqlStorage {
	return {
		exec(query, ...bindings) {
			const statement = database.prepare(query);
			const values = bindings.map(sqliteBinding);
			if (statement.columns().length > 0) {
				const rows = statement.all(...values);
				return { toArray: () => rows };
			}
			statement.run(...values);
			return { toArray: () => [] };
		},
	};
}

function sqliteBinding(value: unknown): SQLInputValue {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'bigint'
	) {
		return value;
	}
	throw new Error('Unsupported SQLite test binding.');
}
