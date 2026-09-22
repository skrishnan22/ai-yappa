import { describe, expect, test } from 'vitest';
import { applyCardEvent, formatElapsed, renderRunCard, type RunCardDesired } from './run-card.ts';

function working(overrides?: Partial<RunCardDesired>): RunCardDesired {
	return {
		submissionId: 'sub-1',
		status: 'working',
		step: 'Working',
		startedAt: 1_000,
		...overrides,
	};
}

describe('applyCardEvent', () => {
	test('opens a desired card on submission_running', () => {
		expect(
			applyCardEvent(null, { type: 'submission_running', submissionId: 'sub-1' }, 5_000),
		).toEqual({
			state: {
				submissionId: 'sub-1',
				status: 'working',
				step: 'Working',
				startedAt: 5_000,
			},
		});
	});

	test('does not downgrade working or reopen a terminal submission on replay', () => {
		expect(
			applyCardEvent(working(), { type: 'submission_queued', submissionId: 'sub-1' }, 2_000)?.state,
		).toMatchObject({ status: 'working', step: 'Working' });
		expect(
			applyCardEvent(
				working({ status: 'completed', step: 'Completed' }),
				{ type: 'submission_running', submissionId: 'sub-1' },
				3_000,
			)?.state.status,
		).toBe('completed');
	});

	test('requires a real running submission before hydration', () => {
		expect(applyCardEvent(null, { type: 'hydration', phase: 'start' }, 1_000)).toBeUndefined();
		const start = applyCardEvent(working(), { type: 'hydration', phase: 'start' }, 2_000);
		expect(start?.state).toMatchObject({
			submissionId: 'sub-1',
			status: 'hydrating',
			step: 'Hydrating workspace',
		});
		const done = applyCardEvent(
			start!.state,
			{ type: 'hydration', phase: 'done', skipped: true },
			3_000,
		);
		expect(done?.state).toMatchObject({ status: 'working', step: 'Workspace ready' });
	});

	test('ignores missing, stale, and terminal tool events', () => {
		expect(
			applyCardEvent(
				working(),
				{ type: 'tool_start', submissionId: undefined, toolName: 'bash' },
				2_000,
			),
		).toBeUndefined();
		expect(
			applyCardEvent(
				working(),
				{ type: 'tool_start', submissionId: 'sub-2', toolName: 'bash' },
				2_000,
			),
		).toBeUndefined();
		expect(
			applyCardEvent(
				working({ status: 'completed', step: 'Completed' }),
				{ type: 'tool_start', submissionId: 'sub-1', toolName: 'bash' },
				2_000,
			),
		).toBeUndefined();
	});

	test('maps tool steps and extracts only matching submission links', () => {
		expect(
			applyCardEvent(
				working(),
				{ type: 'tool_start', submissionId: 'sub-1', toolName: 'open_pull_request' },
				2_000,
			)?.state.step,
		).toBe('Opening pull request');

		const withBranch = applyCardEvent(
			working(),
			{
				type: 'tool',
				submissionId: 'sub-1',
				toolName: 'checkpoint_working_branch',
				result: { output: { htmlUrl: 'https://github.com/org/repo/tree/agent/x' } },
			},
			2_000,
		);
		expect(withBranch?.state.branchUrl).toBe('https://github.com/org/repo/tree/agent/x');

		const withPr = applyCardEvent(
			withBranch!.state,
			{
				type: 'tool',
				submissionId: 'sub-1',
				toolName: 'open_pull_request',
				result: { details: { htmlUrl: 'https://github.com/org/repo/pull/4' } },
			},
			3_000,
		);
		expect(withPr?.state).toMatchObject({
			branchUrl: 'https://github.com/org/repo/tree/agent/x',
			prUrl: 'https://github.com/org/repo/pull/4',
		});
	});

	test('settles with the correct terminal notification', () => {
		const completed = applyCardEvent(
			working({ prUrl: 'https://github.com/org/repo/pull/4' }),
			{ type: 'submission_settled', submissionId: 'sub-1', outcome: 'completed' },
			4_000,
		);
		expect(completed).toMatchObject({
			state: { status: 'completed', step: 'Pull request opened' },
			notify: 'Done: https://github.com/org/repo/pull/4',
		});

		const failed = applyCardEvent(
			working(),
			{ type: 'submission_settled', submissionId: 'sub-1', outcome: 'failed', error: 'boom' },
			4_000,
		);
		expect(failed).toMatchObject({
			state: { status: 'failed', step: 'Failed: boom' },
			notify: 'Failed: boom',
		});
	});
});

describe('renderRunCard', () => {
	test('uses supported section/context blocks with elapsed time and links', () => {
		const rendered = renderRunCard(
			working({
				startedAt: 0,
				prUrl: 'https://github.com/org/repo/pull/4',
				step: 'Opening pull request',
			}),
			65_000,
		);
		expect(rendered.text).toContain('Working');
		expect(JSON.stringify(rendered.blocks)).not.toContain('"type":"header"');
		expect(JSON.stringify(rendered.blocks)).toContain('1m 5s');
		expect(JSON.stringify(rendered.blocks)).toContain('pull request');
	});
});

test('formatElapsed formats seconds and minutes', () => {
	expect(formatElapsed(900)).toBe('0s');
	expect(formatElapsed(4_000)).toBe('4s');
	expect(formatElapsed(60_000)).toBe('1m');
	expect(formatElapsed(65_000)).toBe('1m 5s');
});
