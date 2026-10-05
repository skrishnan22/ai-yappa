import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

async function tunnelFixture() {
	const root = await mkdtemp(join(tmpdir(), 'slack-tunnel-test-'));
	const bin = join(root, 'bin');
	const scripts = join(root, 'scripts');
	const program = join(root, 'ngrok.cjs');
	const pidFile = join(root, '.tunnel.pid');
	const readyFile = join(root, 'ngrok.ready');
	const unrelatedReadyFile = `${readyFile}.unrelated`;
	const children: ChildProcess[] = [];

	await mkdir(bin);
	await mkdir(scripts);
	await writeFile(
		program,
		`process.title = 'ngrok';
const ready = process.env.TUNNEL_TEST_READY + (process.argv.includes('--unrelated') ? '.unrelated' : '');
require('node:fs').writeFileSync(ready, process.pid + '\\n');
setInterval(() => {}, 1000);
`,
	);

	for (const name of ['run-tunnel.sh', 'stop-tunnel.sh']) {
		await copyFile(new URL(`../../scripts/${name}`, import.meta.url), join(scripts, name));
	}

	await writeFile(
		join(bin, 'ngrok'),
		'#!/bin/sh\nexec "$TUNNEL_TEST_NODE" "$TUNNEL_TEST_PROGRAM" "$@"\n',
		{ mode: 0o755 },
	);

	// Prevent a regression to machine-wide termination from reaching real tunnels.
	for (const name of ['killall', 'pkill']) {
		await writeFile(join(bin, name), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
	}

	function start(command: string, args: string[]) {
		const child = spawn(command, args, {
			cwd: root,
			detached: true,
			stdio: 'ignore',
			env: {
				PATH: `${bin}:/usr/bin:/bin`,
				TUNNEL_TEST_READY: readyFile,
				TUNNEL_TEST_NODE: process.execPath,
				TUNNEL_TEST_PROGRAM: program,
			},
		});

		children.push(child);

		const exited = new Promise<number | null>((resolve, reject) => {
			child.once('error', reject);
			child.once('exit', resolve);
		});

		async function waitForExit() {
			await vi.waitFor(
				() => {
					expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
				},
				{ timeout: 2000 },
			);

			return exited;
		}

		return { child, waitForExit };
	}

	async function ready() {
		await vi.waitFor(
			async () => {
				const recorded = await readFile(pidFile, 'utf8');
				const running = await readFile(readyFile, 'utf8');
				expect(recorded).toBe(running);
				process.kill(Number(recorded.trim()), 0);
			},
			{ timeout: 2000 },
		);
		const recorded = await readFile(pidFile, 'utf8');

		return Number(recorded.trim());
	}

	async function dispose() {
		for (const child of children) {
			if (!child.pid) continue;

			try {
				// Each fixture child owns a separate process group, including descendants.
				process.kill(-child.pid, 'SIGKILL');
			} catch {
				// An already exited process group needs no cleanup.
			}
		}

		await rm(root, { recursive: true, force: true });
	}

	return { scripts, program, pidFile, unrelatedReadyFile, start, ready, dispose };
}

describe('tunnel process ownership', () => {
	test('run records its tunnel pid and cleans up the process and file when interrupted', async () => {
		const fixture = await tunnelFixture();

		try {
			const runner = fixture.start('/bin/sh', [join(fixture.scripts, 'run-tunnel.sh')]);
			const pid = await fixture.ready();
			runner.child.kill('SIGTERM');
			await runner.waitForExit();

			await expect(readFile(fixture.pidFile)).rejects.toMatchObject({ code: 'ENOENT' });
			expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
		} finally {
			await fixture.dispose();
		}
	});

	test('stop terminates the recorded tunnel while leaving another ngrok process running', async () => {
		const fixture = await tunnelFixture();

		try {
			const unrelated = fixture.start(process.execPath, [fixture.program, '--unrelated']);
			await vi.waitFor(
				async () => {
					const ready = await readFile(fixture.unrelatedReadyFile, 'utf8');
					expect(Number(ready.trim())).toBe(unrelated.child.pid);
				},
				{ timeout: 2000 },
			);
			const runner = fixture.start('/bin/sh', [join(fixture.scripts, 'run-tunnel.sh')]);
			const pid = await fixture.ready();
			const stop = fixture.start('/bin/sh', [join(fixture.scripts, 'stop-tunnel.sh')]);

			await expect(stop.waitForExit()).resolves.toBe(0);
			await runner.waitForExit();
			await expect(readFile(fixture.pidFile)).rejects.toMatchObject({ code: 'ENOENT' });
			expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
			expect(unrelated.child.exitCode).toBeNull();
			expect(unrelated.child.signalCode).toBeNull();
			const unrelatedPid = unrelated.child.pid;

			if (!unrelatedPid) throw new Error('unrelated fixture process was not started');
			expect(() => process.kill(unrelatedPid, 0)).not.toThrow();
		} finally {
			await fixture.dispose();
		}
	});

	test('the tunnel pid file is ignored by git', async () => {
		const source = await readFile(new URL('../../.gitignore', import.meta.url), 'utf8');

		expect(source.split(/\r?\n/)).toContain('.tunnel.pid');
	});
});
