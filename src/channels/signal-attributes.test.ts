import { describe, expect, test } from 'vitest';
import { buildSignalAttributes } from './signal-attributes.ts';

describe('buildSignalAttributes', () => {
	test('carries the invoking user on every signal', () => {
		expect(buildSignalAttributes('Ev1', 'U_B', 'earlier messages')).toEqual({
			eventId: 'Ev1',
			userId: 'U_B',
			threadContext: 'earlier messages',
		});
	});

	test('omits userId when Slack sent no user', () => {
		expect(buildSignalAttributes('Ev2', undefined, undefined)).toEqual({ eventId: 'Ev2' });
	});
});
