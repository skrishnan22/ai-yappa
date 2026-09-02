import { DaytonaFileNotFoundError, DaytonaNotFoundError, DaytonaProcessExecutionTimeoutError } from '@daytona/sdk';
import { SandboxDiedError } from '@flue/runtime';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	assertContainer,
	CONTAINER_AUTO_ARCHIVE_MINUTES,
	CONTAINER_AUTO_STOP_MINUTES,
	CONTAINER_RESOURCES,
	CONTAINER_SNAPSHOT_NAME,
	createContainerSandbox,
	daytona,
	M1_PERSISTENCE_PROBE_PATH,
	verifyContainerStopStartPersistence,
} from './daytona.ts';
import type { DaytonaClientLike, DaytonaSandboxLike } from './daytona.ts';

afterEach(() => {
	vi.useRealTimers();
});

function fileDetails(args: { isDir: boolean; size: number; modifiedAt: string; name: string }) {
	return args;
}

function createFakeSandbox(overrides?: Partial<DaytonaSandboxLike> & { files?: Map<string, Buffer> }): DaytonaSandboxLike {
	const files = overrides?.files ?? new Map<string, Buffer>();
	const dirs = new Set<string>(['/workspace']);
	let state: string | undefined = overrides?.state ?? 'started';

	const sandbox: DaytonaSandboxLike = {
		id: overrides?.id ?? 'sb-1',
		sandboxClass: overrides?.sandboxClass ?? 'container',
		get state() {
			return state;
		},
		set state(value: string | undefined) {
			state = value;
		},
		async refreshData() {
			if (overrides?.refreshData) {
				await overrides.refreshData();
				return;
			}
		},
		async stop() {
			if (overrides?.stop) {
				await overrides.stop();
				return;
			}
			state = 'stopped';
		},
		async start() {
			if (overrides?.start) {
				await overrides.start();
				return;
			}
			state = 'started';
		},
		fs: overrides?.fs ?? {
			async downloadFile(remotePath: string) {
				const content = files.get(remotePath);
				if (!content) {
					throw new DaytonaFileNotFoundError(`missing ${remotePath}`);
				}
				return content;
			},
			async uploadFile(file: Buffer, remotePath: string) {
				files.set(remotePath, file);
			},
			async getFileDetails(path: string) {
				if (dirs.has(path)) {
					return fileDetails({ isDir: true, size: 0, modifiedAt: '2026-08-30T00:00:00.000Z', name: path });
				}
				const content = files.get(path);
				if (!content) {
					throw new DaytonaFileNotFoundError(`missing ${path}`);
				}
				return fileDetails({
					isDir: false,
					size: content.byteLength,
					modifiedAt: '2026-08-30T12:00:00.000Z',
					name: path,
				});
			},
			async listFiles(path: string) {
				if (!dirs.has(path)) {
					throw new DaytonaFileNotFoundError(`missing ${path}`);
				}
				const prefix = path.endsWith('/') ? path : `${path}/`;
				const names = new Set<string>();
				for (const filePath of files.keys()) {
					if (filePath.startsWith(prefix)) {
						const rest = filePath.slice(prefix.length);
						const name = rest.split('/')[0];
						if (name) names.add(name);
					}
				}
				return [...names].map((name) => ({ name }));
			},
			async createFolder(path: string) {
				dirs.add(path);
			},
			async deleteFile(path: string) {
				if (!files.delete(path) && !dirs.delete(path)) {
					throw new DaytonaFileNotFoundError(`missing ${path}`);
				}
			},
		},
		process: overrides?.process ?? {
			async executeCommand(command, cwd, env, timeout) {
				return { exitCode: 0, result: `${command}|${cwd ?? ''}|${JSON.stringify(env ?? {})}|${timeout ?? ''}` };
			},
		},
	};

	return sandbox;
}

describe('daytona factory', () => {
	test('exec forwards cwd, env, and timeout rounded up to seconds', async () => {
		const sandbox = createFakeSandbox();
		const flueSandbox = await daytona(sandbox, { cwd: '/workspace' }).createSandbox({ id: 'c1' });

		const result = await flueSandbox.exec('ls', {
			cwd: '/workspace/repo',
			env: { FOO: 'bar' },
			timeoutMs: 1500,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe('ls|/workspace/repo|{"FOO":"bar"}|2');
		expect(result.stderr).toBe('');
	});

	test('exec maps a provider timeout to exit code 124', async () => {
		const sandbox = createFakeSandbox({
			process: {
				async executeCommand() {
					throw new DaytonaProcessExecutionTimeoutError('timed out');
				},
			},
		});
		const flueSandbox = await daytona(sandbox, { cwd: '/workspace' }).createSandbox({ id: 'c1' });

		const result = await flueSandbox.exec('sleep 10', { timeoutMs: 1000 });

		expect(result.exitCode).toBe(124);
		expect(result.stderr).toContain('1000');
	});

	test('reads and writes files through the Daytona filesystem', async () => {
		const sandbox = createFakeSandbox();
		const flueSandbox = await daytona(sandbox, { cwd: '/workspace' }).createSandbox({ id: 'c1' });

		await flueSandbox.writeFile('/workspace/hello.txt', 'hi');
		await expect(flueSandbox.readFile('/workspace/hello.txt')).resolves.toBe('hi');
		await expect(flueSandbox.exists('/workspace/hello.txt')).resolves.toBe(true);
		await expect(flueSandbox.exists('/workspace/missing.txt')).resolves.toBe(false);

		const stat = await flueSandbox.stat('/workspace/hello.txt');
		expect(stat.isFile).toBe(true);
		expect(stat.isDirectory).toBe(false);
		expect(stat.size).toBe(2);
		expect(stat.mtime?.toISOString()).toBe('2026-08-30T12:00:00.000Z');
		expect(stat.isSymbolicLink).toBeUndefined();
	});

	test('readdir, mkdir, and rm use native filesystem calls', async () => {
		const sandbox = createFakeSandbox();
		const flueSandbox = await daytona(sandbox, { cwd: '/workspace' }).createSandbox({ id: 'c1' });

		await flueSandbox.mkdir('/workspace/src');
		await flueSandbox.writeFile('/workspace/src/a.ts', 'a');
		await expect(flueSandbox.readdir('/workspace/src')).resolves.toEqual(['a.ts']);
		await flueSandbox.rm('/workspace/src/a.ts');
		await expect(flueSandbox.exists('/workspace/src/a.ts')).resolves.toBe(false);
	});

	test('rejects in-flight work with SandboxDiedError when the sandbox is gone', async () => {
		vi.useFakeTimers();
		const sandbox = createFakeSandbox({
			process: {
				async executeCommand() {
					return await new Promise(() => {});
				},
			},
		});
		sandbox.refreshData = async () => {
			sandbox.state = 'destroyed';
		};
		const flueSandbox = await daytona(sandbox, { cwd: '/workspace' }).createSandbox({ id: 'c1' });

		const pending = flueSandbox.exec('sleep 30');
		const rejection = expect(pending).rejects.toBeInstanceOf(SandboxDiedError);
		await vi.advanceTimersByTimeAsync(5_000);
		await rejection;
	});

	test('rejects in-flight work when the sandbox lookup returns not found', async () => {
		vi.useFakeTimers();
		const sandbox = createFakeSandbox({
			process: {
				async executeCommand() {
					return await new Promise(() => {});
				},
			},
		});
		sandbox.refreshData = async () => {
			throw new DaytonaNotFoundError('sandbox deleted');
		};
		const flueSandbox = await daytona(sandbox, { cwd: '/workspace' }).createSandbox({ id: 'c1' });
		let failure: unknown;
		void flueSandbox.exec('sleep 30').catch((error: unknown) => {
			failure = error;
		});

		await vi.advanceTimersByTimeAsync(5_000);

		expect(failure).toBeInstanceOf(SandboxDiedError);
	});
});

describe('container lease', () => {
	test('assertContainer rejects a Linux VM sandbox', () => {
		expect(() => assertContainer(createFakeSandbox({ sandboxClass: 'linux-vm' }))).toThrow(
			/container/,
		);
	});

	test('creates a retained container with the specified lifecycle', async () => {
		const created: unknown[] = [];
		const snapshots: unknown[] = [];
		const sandbox = createFakeSandbox({ id: 'container-1' });
		const client: DaytonaClientLike = {
			async create(params) {
				created.push(params);
				return sandbox;
			},
			async get() {
				throw new DaytonaNotFoundError('missing named sandbox');
			},
			async *list() {},
			snapshot: {
				async get() {
					throw new DaytonaNotFoundError('missing snapshot');
				},
				async create(params) {
					snapshots.push(params);
					return { name: CONTAINER_SNAPSHOT_NAME, sandboxClass: 'container' };
				},
			},
		};

		await createContainerSandbox(client, { conversationId: 'conv-1' });

		expect(snapshots).toEqual([
			expect.objectContaining({
				name: CONTAINER_SNAPSHOT_NAME,
				sandboxClass: 'container',
				resources: CONTAINER_RESOURCES,
			}),
		]);
		expect(created).toEqual([
			expect.objectContaining({
				snapshot: CONTAINER_SNAPSHOT_NAME,
				autoStopInterval: CONTAINER_AUTO_STOP_MINUTES,
				autoPauseInterval: 0,
				autoArchiveInterval: CONTAINER_AUTO_ARCHIVE_MINUTES,
				autoDeleteInterval: -1,
				ephemeral: false,
				labels: { flueConversationId: 'conv-1' },
			}),
		]);
	});

	test('reuses the single sandbox already labeled for the conversation', async () => {
		const existing = createFakeSandbox({ id: 'container-existing' });
		const created: unknown[] = [];
		const requestedNames: string[] = [];
		const client = {
			async create(params: unknown) {
				created.push(params);
				return createFakeSandbox({ id: 'container-new' });
			},
			async get(name: string) {
				requestedNames.push(name);
				throw new DaytonaNotFoundError('missing named sandbox');
			},
			async *list() {
				yield existing;
			},
			snapshot: {
				async get() {
					throw new Error('snapshot lookup should not run when reusing a sandbox');
				},
				async create() {
					throw new Error('snapshot creation should not run when reusing a sandbox');
				},
			},
		};

		const sandbox = await createContainerSandbox(client, { conversationId: 'conv-1' });

		expect(sandbox).toBe(existing);
		expect(created).toEqual([]);
		expect(requestedNames).toEqual([expect.stringMatching(/^slack-agent-[0-9a-f]{32}$/)]);
	});

	test.each(['stopped', 'archived'])('starts a %s sandbox before reusing it', async (state) => {
		const events: string[] = [];
		const existing = createFakeSandbox({ id: `container-${state}`, state });
		existing.start = async () => {
			events.push('start');
			existing.state = 'started';
		};
		const client = {
			async create() {
				throw new Error('should not create a replacement');
			},
			async get() {
				return existing;
			},
			async *list() {},
			snapshot: {
				async get() {
					throw new Error('should not inspect a snapshot');
				},
				async create() {
					throw new Error('should not create a snapshot');
				},
			},
		};

		const sandbox = await createContainerSandbox(client, { conversationId: 'conv-1' });

		expect(sandbox).toBe(existing);
		expect(events).toEqual(['start']);
	});

	test('creates a deterministically named sandbox when none exists', async () => {
		const created: unknown[] = [];
		const requestedNames: string[] = [];
		const sandbox = createFakeSandbox({ id: 'container-new' });
		const client = {
			async create(params: unknown) {
				created.push(params);
				return sandbox;
			},
			async get(name: string) {
				requestedNames.push(name);
				throw new DaytonaNotFoundError('missing named sandbox');
			},
			async *list() {},
			snapshot: {
				async get() {
					return { sandboxClass: 'container' };
				},
				async create() {
					throw new Error('snapshot already exists');
				},
			},
		};

		await createContainerSandbox(client, { conversationId: 'conv-1' });

		const expectedName = requestedNames[0];
		expect(expectedName).toMatch(/^slack-agent-[0-9a-f]{32}$/);
		expect(created).toEqual([
			expect.objectContaining({
				name: expectedName,
				labels: { flueConversationId: 'conv-1' },
			}),
		]);
	});

	test('fails closed when more than one legacy sandbox has the conversation label', async () => {
		const client = {
			async create() {
				return createFakeSandbox({ id: 'container-new' });
			},
			async get() {
				throw new DaytonaNotFoundError('missing named sandbox');
			},
			async *list() {
				yield createFakeSandbox({ id: 'container-1' });
				yield createFakeSandbox({ id: 'container-2' });
			},
			snapshot: {
				async get() {
					throw new Error('should not inspect a snapshot');
				},
				async create() {
					throw new Error('should not create a snapshot');
				},
			},
		};

		await expect(
			createContainerSandbox(client, { conversationId: 'conv-1' }),
		).rejects.toThrow(/multiple Daytona sandboxes/);
	});

	test('proves a filesystem marker survives stop and start on the same id', async () => {
		const events: string[] = [];
		const files = new Map<string, Buffer>();
		const sandbox = createFakeSandbox({ id: 'container-9', files });
		sandbox.stop = async () => {
			events.push('stop');
			sandbox.state = 'stopped';
		};
		sandbox.start = async () => {
			events.push('start');
			sandbox.state = 'started';
		};

		const restarted = await verifyContainerStopStartPersistence(sandbox);

		expect(restarted.id).toBe('container-9');
		expect(events).toEqual(['stop', 'start']);
		expect(files.has(M1_PERSISTENCE_PROBE_PATH)).toBe(false);
	});
});
