import type { FlueObservation } from '@flue/runtime';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createD1PlanningStore } from '../planning/d1-decision-log.ts';
import { createPlanningStartup } from '../planning/planning-startup.ts';
import { setPlanningStore } from '../planning/planning-store.ts';
import { openTestDatabase } from '../testing/d1.ts';

let middleware = createPlanningStartup();

beforeEach(() => {
	middleware = createPlanningStartup();
});

afterEach(() => {
	setPlanningStore(undefined);
	vi.restoreAllMocks();
});

function activate(conversationId: string, name = 'grill-me') {
	const event: FlueObservation = {
		v: 3,
		eventIndex: 0,
		timestamp: new Date().toISOString(),
		type: 'tool_start',
		toolName: 'activate_skill',
		toolCallId: 'activation',
		args: { name },
	};

	const context = {
		id: conversationId,
		agentName: 'Coworker',
		env: {},
		req: undefined,
		log: { info() {}, warn() {}, error() {} },
	};

	return Promise.resolve(middleware.observe(event, context));
}

async function execute(conversationId: string, toolName: string, next: () => Promise<void>) {
	await middleware.interceptor(
		{ type: 'tool', toolName, toolCallId: toolName },
		{ instanceId: conversationId },
		next,
	);
}

test('end_planning waits for startup and stays ended after a slow start', async () => {
	const db = await openTestDatabase();
	const store = createD1PlanningStore(db);
	setPlanningStore(store);
	const release = Promise.withResolvers<void>();
	const originalStart = store.sessions.start.bind(store.sessions);

	const start = vi.spyOn(store.sessions, 'start').mockImplementation(async (...args) => {
		await release.promise;
		await originalStart(...args);
	});

	const deliveries = activate('conv-1');
	const skill = execute('conv-1', 'activate_skill', async () => {});
	let ended = false;

	const work = execute('conv-1', 'end_planning', async () => {
		ended = true;
		await store.sessions.end('conv-1', new Date().toISOString());
	});

	try {
		await Promise.resolve();
		expect(ended).toBe(false);
	} finally {
		release.resolve();
		await Promise.all([skill, work, deliveries]);
	}

	const active = await store.sessions.isActive('conv-1');
	expect(active).toBe(false);
	expect(start).toHaveBeenCalledOnce();
});

test('the skill runs after startup, and later tools do not restart ended planning', async () => {
	const db = await openTestDatabase();
	const store = createD1PlanningStore(db);
	setPlanningStore(store);
	const deliveries = activate('conv-1');
	await execute('conv-1', 'activate_skill', async () => {
		const active = await store.sessions.isActive('conv-1');
		expect(active).toBe(true);
	});
	await deliveries;
	await store.sessions.end('conv-1', new Date().toISOString());
	await execute('conv-1', 'reply_in_slack_thread', async () => {});
	const active = await store.sessions.isActive('conv-1');
	expect(active).toBe(false);
});

test('a slow startup does not hold up another conversation', async () => {
	const db = await openTestDatabase();
	const store = createD1PlanningStore(db);
	setPlanningStore(store);
	const release = Promise.withResolvers<void>();
	const originalStart = store.sessions.start.bind(store.sessions);
	vi.spyOn(store.sessions, 'start').mockImplementation(async (...args) => {
		await release.promise;
		await originalStart(...args);
	});
	const deliveries = activate('conv-1');
	let firstRan = false;

	const pending = execute('conv-1', 'activate_skill', async () => {
		firstRan = true;
	});

	try {
		await execute('conv-2', 'reply_in_slack_thread', async () => {});
		expect(firstRan).toBe(false);
	} finally {
		release.resolve();
		await Promise.all([pending, deliveries]);
	}

	expect(firstRan).toBe(true);
});

test('failed startup blocks activation but can be retried', async () => {
	const db = await openTestDatabase();
	const store = createD1PlanningStore(db);
	setPlanningStore(store);
	vi.spyOn(store.sessions, 'start').mockRejectedValueOnce(new Error('D1 unavailable'));
	const next = vi.fn<() => Promise<void>>(async () => {});
	await activate('conv-1');
	await expect(execute('conv-1', 'activate_skill', next)).rejects.toThrow('D1 unavailable');
	expect(next).not.toHaveBeenCalled();
	await activate('conv-1');
	await execute('conv-1', 'activate_skill', next);
	expect(next).toHaveBeenCalledOnce();
	const active = await store.sessions.isActive('conv-1');
	expect(active).toBe(true);
});
