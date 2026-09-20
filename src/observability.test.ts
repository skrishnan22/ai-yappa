import { afterEach, describe, expect, test, vi } from 'vitest';
import { emitSemanticEvent, type SlackAdmissionEvent } from './observability.ts';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('emitSemanticEvent', () => {
	test('emits a flat admission record without accepting message content', () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});

		const event = {
			event_name: 'slack_admission',
			outcome: 'dispatched',
			conversation_id: 'conversation-1',
			slack_event_id: 'event-1',
			signal_type: 'slack.app_mention',
			decision: 'dispatch',
			submission_id: 'submission-1',
			agent_uid: 'agent-1',
		} satisfies SlackAdmissionEvent;

		emitSemanticEvent(event);

		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				schema_version: 1,
				service: 'slack-agent',
				timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
				...event,
			}),
		);
	});

	test('contains logging failures so observability cannot change admission behavior', () => {
		vi.spyOn(console, 'info').mockImplementation(() => {
			throw new Error('console unavailable');
		});

		expect(() =>
			emitSemanticEvent({
				event_name: 'slack_admission',
				outcome: 'failed',
				conversation_id: 'conversation-1',
				slack_event_id: 'event-1',
				signal_type: 'slack.message',
				decision: 'admission-error',
			}),
		).not.toThrow();
	});
});
