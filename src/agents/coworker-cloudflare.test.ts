import { beforeEach, expect, test, vi } from 'vitest';

type Schedule = (
	delay: number,
	method: string,
	payload: string,
	options: { idempotent: boolean },
) => Promise<void>;
type TestExtensionBase = (base: new () => { schedule: Schedule }) => new () => {
	schedule: Schedule;
	onStart(): Promise<void>;
	retryRunCards(): Promise<void>;
};

const mocks = vi.hoisted(
	(): {
		extensionBase?: TestExtensionBase;
		hasPending: ReturnType<typeof vi.fn<(instanceId: string) => boolean>>;
		registerScheduler: ReturnType<
			typeof vi.fn<(instanceId: string, schedule: () => Promise<void>) => void>
		>;
		registerSql: ReturnType<typeof vi.fn<(instanceId: string, sql: object) => void>>;
		runRetry: ReturnType<
			typeof vi.fn<
				(
					instanceId: string,
					token: string | undefined,
					reschedule: () => Promise<void>,
				) => Promise<void>
			>
		>;
	} => ({
		extensionBase: undefined,
		hasPending: vi.fn<(instanceId: string) => boolean>(() => false),
		registerScheduler: vi.fn<(instanceId: string, schedule: () => Promise<void>) => void>(),
		registerSql: vi.fn<(instanceId: string, sql: object) => void>(),
		runRetry: vi.fn<
			(
				instanceId: string,
				token: string | undefined,
				reschedule: () => Promise<void>,
			) => Promise<void>
		>(async (_instanceId, _token, reschedule) => {
			await reschedule();
		}),
	}),
);

vi.mock('@flue/runtime/cloudflare', () => ({
	extend: (definition: { base: TestExtensionBase }) => {
		mocks.extensionBase = definition.base;
		return {};
	},
	getCloudflareContext: () => ({
		env: { SLACK_BOT_TOKEN: 'xoxb-test' },
		storage: { sql: {} },
	}),
	getDurableObjectIdentity: () => ({ name: 'conversation' }),
}));

vi.mock('../channels/run-card-delivery.ts', () => ({
	hasPendingRunCardDelivery: mocks.hasPending,
	registerRunCardRetryScheduler: mocks.registerScheduler,
	registerRunCardSql: mocks.registerSql,
	runScheduledRunCardRetry: mocks.runRetry,
}));

await import('./coworker-cloudflare.ts');

test('the retry callback schedules a fresh non-idempotent one-shot', async () => {
	const schedule = vi.fn<Schedule>(async () => undefined);
	class FakeBase {
		schedule = schedule;
	}
	const Extended = mocks.extensionBase?.(FakeBase);
	if (Extended === undefined) throw new Error('Cloudflare extension was not registered.');

	await new Extended().retryRunCards();

	expect(schedule).toHaveBeenCalledWith(30, 'retryRunCards', 'retry', {
		idempotent: false,
	});
});

test('startup does not schedule retries for a clean conversation', async () => {
	const schedule = vi.fn<Schedule>(async () => undefined);
	class FakeBase {
		schedule = schedule;
	}
	const Extended = mocks.extensionBase?.(FakeBase);
	if (Extended === undefined) throw new Error('Cloudflare extension was not registered.');

	await new Extended().onStart();

	expect(schedule).not.toHaveBeenCalled();
});

beforeEach(() => {
	mocks.hasPending.mockClear();
	mocks.registerScheduler.mockClear();
	mocks.registerSql.mockClear();
	mocks.runRetry.mockClear();
});
