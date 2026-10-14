import { describe, expect, test } from 'vitest';
import { Coworker } from '../agents/coworker.ts';
import { type ConversationRuntime, startConversation } from './start.ts';

describe('startConversation', () => {
	test('dispatches the Coworker with initialData and the signal', async () => {
		const requests: Array<Parameters<ConversationRuntime['dispatch']>[1]> = [];

		const runtime: ConversationRuntime = {
			dispatch: async (agent, request) => {
				expect(agent).toBe(Coworker);
				requests.push(request);

				return { submissionId: 'sub-1', acceptedAt: '2026-10-14T03:30:00.000Z', uid: 'uid-1' };
			},
		};

		const receipt = await startConversation({
			runtime,
			now: new Date('2026-10-14T03:30:00.000Z'),
			start: {
				id: 'slack:v1:T1:C1:2.0',
				thread: { channelId: 'C1', threadTs: '2.0' },
				startedBy: 'U_OWNER',
				repo: 'https://github.com/acme/api.git',
				automationId: 'a1',
				idempotencyKey: 'automation:a1:2026-10-14T03:30:00.000Z',
				message: { type: 'automation.fire', body: 'Do it', attributes: { automationId: 'a1' } },
			},
		});

		expect(receipt.submissionId).toBe('sub-1');
		expect(requests).toEqual([
			{
				id: 'slack:v1:T1:C1:2.0',
				idempotencyKey: 'automation:a1:2026-10-14T03:30:00.000Z',
				initialData: {
					channelId: 'C1',
					threadTs: '2.0',
					startedBy: 'U_OWNER',
					startedAt: '2026-10-14T03:30:00.000Z',
					repo: 'https://github.com/acme/api.git',
					modelChoice: undefined,
					automationId: 'a1',
				},
				message: {
					kind: 'signal',
					type: 'automation.fire',
					body: 'Do it',
					attributes: { automationId: 'a1' },
				},
			},
		]);
	});
});
