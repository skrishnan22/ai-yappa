import { describe, expect, test } from 'vitest';
import { findAsyncTernaries } from '../../scripts/check-async-ternary.mjs';

describe('async/await ternary lint', () => {
	test('flags await in either branch', () => {
		expect(findAsyncTernaries('async function f(c: boolean) { return c ? await a() : b; }').map((hit) => hit.kind)).toEqual([
			'await',
		]);
		expect(findAsyncTernaries('async function f(c: boolean) { return c ? a() : await b(); }').map((hit) => hit.kind)).toEqual([
			'await',
		]);
	});

	test('flags an async function as a ternary branch', () => {
		expect(findAsyncTernaries('const run = token ? async () => 1 : () => 0;').map((hit) => hit.kind)).toEqual(['async']);
	});

	test('ignores ordinary ternaries, optional props, and optional calls', () => {
		expect(findAsyncTernaries('const n = c ? 1 : 2;')).toEqual([]);
		expect(findAsyncTernaries('type T = { foo?: Promise<string> };')).toEqual([]);
		expect(findAsyncTernaries('async function f(obj?: { m(): Promise<void> }) { await obj?.m(); }')).toEqual(
			[],
		);
		expect(findAsyncTernaries('const msg = error instanceof Error ? error.message : "x";')).toEqual([]);
	});
});
