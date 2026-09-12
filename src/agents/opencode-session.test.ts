import { describe, expect, test } from 'vitest';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { recoverOpenCodeStreamError, withOpenCodeSessionHeader } from './opencode-session.ts';

function assistant(args: {
	content: AssistantMessage['content'];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: 'assistant',
		content: args.content,
		api: 'openai-completions',
		provider: 'opencode-go',
		model: 'deepseek-v4-flash',
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: 'error',
		errorMessage: args.errorMessage,
		timestamp: 0,
	};
}

function missingFinish(content: AssistantMessage['content']): AssistantMessageEvent {
	return {
		type: 'error',
		reason: 'error',
		error: assistant({ content, errorMessage: 'Stream ended without finish_reason' }),
	};
}

describe('withOpenCodeSessionHeader', () => {
	test('copies sessionId onto x-opencode-session', () => {
		expect(withOpenCodeSessionHeader({ sessionId: 'slack:v1:T1:C1:1.2' })).toEqual({
			sessionId: 'slack:v1:T1:C1:1.2',
			headers: { 'x-opencode-session': 'slack:v1:T1:C1:1.2' },
		});
	});

	test('leaves an explicit header override in place', () => {
		expect(
			withOpenCodeSessionHeader({
				sessionId: 'conv-1',
				headers: { 'x-opencode-session': 'already-set' },
			}),
		).toEqual({
			sessionId: 'conv-1',
			headers: { 'x-opencode-session': 'already-set' },
		});
	});

	test('does nothing without a sessionId', () => {
		expect(withOpenCodeSessionHeader({ headers: { accept: 'application/json' } })).toEqual({
			headers: { accept: 'application/json' },
		});
		expect(withOpenCodeSessionHeader(undefined)).toBeUndefined();
	});
});

describe('recoverOpenCodeStreamError', () => {
	test('turns a truncated tool-call stream into toolUse', () => {
		const recovered = recoverOpenCodeStreamError(
			missingFinish([
				{ type: 'toolCall', id: '1', name: 'read_github_issue', arguments: { number: 3 } },
			]),
		);
		expect(recovered?.type).toBe('done');
		expect(recovered?.type === 'done' && recovered.reason).toBe('toolUse');
	});

	test('turns truncated assistant text into stop', () => {
		const recovered = recoverOpenCodeStreamError(missingFinish([{ type: 'text', text: 'done' }]));
		expect(recovered?.type === 'done' && recovered.reason).toBe('stop');
	});

	test('does not invent a stop from thinking-only output', () => {
		expect(
			recoverOpenCodeStreamError(missingFinish([{ type: 'thinking', thinking: 'hmm' }])),
		).toBeUndefined();
	});

	test('leaves other stream errors alone', () => {
		expect(
			recoverOpenCodeStreamError({
				type: 'error',
				reason: 'error',
				error: assistant({
					content: [{ type: 'text', text: 'x' }],
					errorMessage: 'Request was aborted',
				}),
			}),
		).toBeUndefined();
	});
});
