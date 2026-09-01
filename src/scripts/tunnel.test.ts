import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

async function script(name: string): Promise<string> {
	return readFile(new URL(`../../scripts/${name}`, import.meta.url), 'utf8');
}

describe('tunnel process ownership', () => {
	test('run records the project tunnel pid and removes it on exit', async () => {
		const source = await script('run-tunnel.sh');

		expect(source).toContain('.tunnel.pid');
		expect(source).toContain('trap cleanup');
	});

	test('stop targets the recorded process instead of every tunnel on the machine', async () => {
		const source = await script('stop-tunnel.sh');

		expect(source).toContain('.tunnel.pid');
		expect(source).not.toMatch(/\bkillall\b|\bpkill\b/);
	});

	test('the tunnel pid file is ignored by git', async () => {
		const source = await readFile(new URL('../../.gitignore', import.meta.url), 'utf8');

		expect(source.split(/\r?\n/)).toContain('.tunnel.pid');
	});
});
