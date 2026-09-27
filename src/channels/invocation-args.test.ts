import { describe, expect, test } from 'vitest';
import { parseInvocationArgs } from './invocation-args.ts';

describe('parseInvocationArgs', () => {
	test('reads model and think anywhere in the mention and strips them', () => {
		expect(parseInvocationArgs('<@U1> model:luna think:high fix the flaky test')).toEqual({
			ok: true,
			args: { model: 'luna', think: 'high', body: '<@U1> fix the flaky test' },
		});
		expect(parseInvocationArgs('<@U1> why is CI red on main? think:low')).toEqual({
			ok: true,
			args: { think: 'low', body: '<@U1> why is CI red on main?' },
		});
		expect(parseInvocationArgs('<@U1> use Model:Kimi, then fix it')).toEqual({
			ok: true,
			args: { model: 'Kimi', body: '<@U1> use, then fix it' },
		});
	});

	test('keeps dotted model ids and drops sentence punctuation', () => {
		expect(parseInvocationArgs('<@U1> try model:gpt-5.6-luna.')).toEqual({
			ok: true,
			args: { model: 'gpt-5.6-luna', body: '<@U1> try.' },
		});
	});

	test('ignores arguments in code, code blocks, and quotes', () => {
		const text = [
			'<@U1> why does `model:gpt-4o` time out?',
			'```',
			'model:kimi think:high',
			'```',
			'&gt; model:sol said so',
			'> think:low too',
		].join('\n');

		expect(parseInvocationArgs(text)).toEqual({ ok: true, args: { body: text } });
	});

	test('needs the exact key:value shape', () => {
		for (const text of [
			'<@U1> the model: luna is slow',
			'<@U1> see https://example.com/model:luna',
			'<@U1> set config.model:luna',
			'<@U1> tag env:model:luna',
			'<@U1> path model:luna/v2',
			'<@U1> remodel:luna',
			'<@U1> (model:luna)',
		]) {
			expect(parseInvocationArgs(text)).toEqual({ ok: true, args: { body: text } });
		}
	});

	test('keeps the line structure of the rest of the message', () => {
		expect(parseInvocationArgs('<@U1> model:glm\nline two\n  indented')).toEqual({
			ok: true,
			args: { model: 'glm', body: '<@U1>\nline two\n  indented' },
		});
	});

	test('refuses conflicting values and allows repeats', () => {
		expect(parseInvocationArgs('<@U1> model:luna do it model:kimi')).toEqual({
			ok: false,
			error: 'Conflicting `model:` values: `luna` and `kimi`.',
		});
		expect(parseInvocationArgs('<@U1> think:high go think:HIGH')).toEqual({
			ok: true,
			args: { think: 'high', body: '<@U1> go' },
		});
	});
});
