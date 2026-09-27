import { describe, expect, test } from 'vitest';
import { parseInvocationArgs } from './invocation-args.ts';

describe('parseInvocationArgs', () => {
	test('reads $model and $effort anywhere in the mention and strips them', () => {
		expect(parseInvocationArgs('<@U1> $model:luna $effort:high fix the flaky test')).toEqual({
			ok: true,
			args: { model: 'luna', effort: 'high', body: '<@U1> fix the flaky test' },
		});
		expect(parseInvocationArgs('<@U1> why is CI red on main? $effort:low')).toEqual({
			ok: true,
			args: { effort: 'low', body: '<@U1> why is CI red on main?' },
		});
		expect(parseInvocationArgs('<@U1> use $Model:Kimi, then fix it')).toEqual({
			ok: true,
			args: { model: 'Kimi', body: '<@U1> use, then fix it' },
		});
	});

	test('keeps dotted model ids and drops a sentence period', () => {
		expect(parseInvocationArgs('<@U1> try $model:gpt-5.6-luna.')).toEqual({
			ok: true,
			args: { model: 'gpt-5.6-luna', body: '<@U1> try.' },
		});
	});

	test('leaves text without the $ alone', () => {
		const text = '<@U1> the eval log says model:gpt-4o and think:high timed out';

		expect(parseInvocationArgs(text)).toEqual({ ok: true, args: { body: text } });
	});

	test('keeps the line structure of the rest of the message', () => {
		expect(parseInvocationArgs('<@U1> $model:glm\nline two\n  indented')).toEqual({
			ok: true,
			args: { model: 'glm', body: '<@U1>\nline two\n  indented' },
		});
	});

	test('refuses conflicting values and allows repeats', () => {
		expect(parseInvocationArgs('<@U1> $model:luna do it $model:kimi')).toEqual({
			ok: false,
			error: 'Conflicting `$model:` values: `luna` and `kimi`.',
		});
		expect(parseInvocationArgs('<@U1> $effort:high go $effort:HIGH')).toEqual({
			ok: true,
			args: { effort: 'high', body: '<@U1> go' },
		});
	});
});
