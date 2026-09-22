import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { init, useModel } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	loadThreadContext: vi.fn<() => Promise<string>>(async () => 'Earlier thread message from Slack'),
	getSlackClient: vi.fn<() => { conversations: { replies: () => Promise<never> } }>(() => ({
		conversations: { replies: vi.fn<() => Promise<never>>() },
	})),
}));

vi.mock('./thread-context.ts', () => ({ loadThreadContext: mocks.loadThreadContext }));
vi.mock('./slack-reply.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('./slack-reply.ts')>()),
	getSlackClient: mocks.getSlackClient,
}));

const { useSlackThreadContext } = await import('./thread-context-hook.ts');
const faux = fauxProvider({
	provider: 'opencode-go',
	models: [{ id: 'deepseek-v4-flash' }],
});
let runtime: Awaited<ReturnType<typeof start>>;
let modelInput = '';

function ContextAgent() {
	useModel('opencode-go/deepseek-v4-flash');
	useSlackThreadContext({ channelId: 'C1', threadTs: '1.2' }, 'xoxb-test');
	return 'Answer once.';
}

describe('Slack thread context hook', () => {
	beforeAll(async () => {
		faux.setResponses([
			(context) => {
				modelInput = JSON.stringify(context.messages);
				return fauxAssistantMessage('done');
			},
		]);
		runtime = await start({ agents: [ContextAgent], providers: [faux.provider] });
	});

	afterAll(async () => {
		await runtime.stop();
	});

	test('appends history to model input once after duplicate admission', async () => {
		const handle = init(ContextAgent, { id: 'context-hook-integration' });
		const request = {
			idempotencyKey: 'Ev-1',
			message: {
				kind: 'signal' as const,
				type: 'slack.app_mention',
				body: 'New request',
				attributes: { eventId: 'Ev-1' },
			},
		};
		const first = await handle.dispatch(request);
		const duplicate = await handle.dispatch(request);
		await handle.read(first);

		expect(duplicate.submissionId).toBe(first.submissionId);
		expect(mocks.loadThreadContext).toHaveBeenCalledOnce();
		expect(modelInput).toContain('New request');
		expect(modelInput).toContain('slack.thread_context');
		expect(modelInput).toContain('Earlier thread message from Slack');
	});
});
