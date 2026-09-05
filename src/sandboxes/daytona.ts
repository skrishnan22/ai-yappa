/**
 * Daytona adapter for Flue.
 *
 * Wraps an already-created Daytona sandbox into Flue's SandboxFactory.
 * Creating, stopping, starting, and deleting the provider sandbox stay
 * application-owned around this factory.
 */
import {
	DaytonaNotFoundError,
	DaytonaProcessExecutionTimeoutError,
	Image,
	SandboxClass,
	SandboxState,
	type CreateSandboxFromSnapshotParams,
	type CreateSnapshotParams,
	type ListSandboxesQuery,
} from '@daytona/sdk';
import { sandboxFromDriver, SandboxDiedError } from '@flue/runtime';
import type { FileStat, Sandbox, SandboxDriver, SandboxFactory } from '@flue/runtime';

export const CONTAINER_SNAPSHOT_NAME = 'slack-agent-container-v1';
export const CONTAINER_AUTO_STOP_MINUTES = 15;
export const CONTAINER_AUTO_ARCHIVE_MINUTES = 7 * 24 * 60;
export const CONTAINER_RESOURCES = { cpu: 2, memory: 4, disk: 3 };
export const M1_PERSISTENCE_PROBE_PATH = '/workspace/.slack-agent-persistence-probe';

const SANDBOX_LIVENESS_POLL_MS = 5_000;
const PROBE_SILENCE_MS = 10_000;

const DEAD_STATES = new Set<SandboxState>([
	'destroyed',
	'destroying',
	'error',
	'stopped',
	'stopping',
	'paused',
	'pausing',
	'archived',
	'archiving',
	'build_failed',
]);

export type DaytonaSandboxLike = {
	id: string;
	sandboxClass?: SandboxClass;
	state?: SandboxState;
	refreshData(): Promise<void>;
	stop(timeout?: number, force?: boolean): Promise<void>;
	start(timeout?: number): Promise<void>;
	delete?(timeout?: number, wait?: boolean): Promise<void>;
	fs: {
		downloadFile(remotePath: string): Promise<Buffer>;
		uploadFile(file: Buffer, remotePath: string): Promise<void>;
		getFileDetails(path: string): Promise<{
			isDir: boolean;
			size: number;
			modifiedAt: string;
			name: string;
		}>;
		listFiles(path: string): Promise<Array<{ name: string }>>;
		createFolder(path: string, mode: string): Promise<void>;
		deleteFile(path: string, recursive?: boolean): Promise<void>;
	};
	process: {
		executeCommand(
			command: string,
			cwd?: string,
			env?: Record<string, string>,
			timeout?: number,
		): Promise<{ exitCode: number; result: string }>;
	};
};

export type DaytonaClientLike = {
	create(
		params?: CreateSandboxFromSnapshotParams,
		options?: { timeout?: number },
	): Promise<DaytonaSandboxLike>;
	get(id: string): Promise<DaytonaSandboxLike>;
	list(query?: ListSandboxesQuery): AsyncIterableIterator<DaytonaSandboxLike>;
	snapshot: {
		get(name: string): Promise<{ sandboxClass?: SandboxClass }>;
		create(params: CreateSnapshotParams, options?: { timeout?: number }): Promise<unknown>;
	};
};

export interface DaytonaAdapterOptions {
	cwd?: string;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isMissingPathError(error: unknown): boolean {
	return error instanceof DaytonaNotFoundError;
}

function containerImage(): Image {
	return Image.base('node:22-bookworm').dockerfileCommands([
		'RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*',
		'RUN mkdir -p /workspace',
		'WORKDIR /workspace',
	]);
}

/**
 * Await a Daytona SDK call while watching for sandbox death. Toolbox HTTP
 * can leave a call pending after the sandbox is gone, so a bare await can hang
 * an agent forever. While the call is pending, this polls `refreshData()`
 * and rejects with `SandboxDiedError` once the sandbox is no longer started.
 *
 * There is deliberately no deadline: a started sandbox, however long the call
 * has been running, counts as alive.
 *
 * Liveness only: this never races the caller's abort signal.
 */
function raceSandboxDeath<T>(
	sandbox: DaytonaSandboxLike,
	operation: string,
	call: Promise<T>,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let pollTimer: ReturnType<typeof setTimeout> | undefined;
		let silenceTimer: ReturnType<typeof setTimeout> | undefined;

		const settle = (complete: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(pollTimer);
			clearTimeout(silenceTimer);
			complete();
		};

		const probe = (): void => {
			silenceTimer = setTimeout(() => {
				settle(() => reject(new SandboxDiedError({ operation, reason: 'probe_silent' })));
			}, PROBE_SILENCE_MS);
			sandbox.refreshData().then(
				() => {
					if (settled) return;
					clearTimeout(silenceTimer);
					if (sandbox.state !== undefined && DEAD_STATES.has(sandbox.state)) {
						settle(() => reject(new SandboxDiedError({ operation, reason: 'stopped' })));
					} else {
						pollTimer = setTimeout(probe, SANDBOX_LIVENESS_POLL_MS);
					}
				},
				(error: unknown) => {
					if (settled) return;
					clearTimeout(silenceTimer);
					if (error instanceof DaytonaNotFoundError) {
						settle(() => reject(new SandboxDiedError({ operation, reason: 'stopped' })));
						return;
					}
					pollTimer = setTimeout(probe, SANDBOX_LIVENESS_POLL_MS);
				},
			);
		};
		pollTimer = setTimeout(probe, SANDBOX_LIVENESS_POLL_MS);

		call.then(
			(value) => settle(() => resolve(value)),
			(error: unknown) => settle(() => reject(error)),
		);
	});
}

class DaytonaSandboxDriver implements SandboxDriver {
	constructor(private sandbox: DaytonaSandboxLike) {}

	private guarded<T>(operation: string, call: Promise<T>): Promise<T> {
		return raceSandboxDeath(this.sandbox, operation, call);
	}

	async readFile(path: string): Promise<string> {
		const bytes = await this.guarded('readFile', this.sandbox.fs.downloadFile(path));
		return bytes.toString('utf8');
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const bytes = await this.guarded('readFile', this.sandbox.fs.downloadFile(path));
		return new Uint8Array(bytes);
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		const file = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
		await this.guarded('writeFile', this.sandbox.fs.uploadFile(file, path));
	}

	async stat(path: string): Promise<FileStat> {
		const details = await this.guarded('stat', this.sandbox.fs.getFileDetails(path));
		return {
			isFile: !details.isDir,
			isDirectory: details.isDir,
			size: details.size,
			mtime: new Date(details.modifiedAt),
		};
	}

	async readdir(path: string): Promise<string[]> {
		const entries = await this.guarded('readdir', this.sandbox.fs.listFiles(path));
		return entries.map((entry) => entry.name);
	}

	async exists(path: string): Promise<boolean> {
		try {
			await this.guarded('exists', this.sandbox.fs.getFileDetails(path));
			return true;
		} catch (error) {
			if (error instanceof SandboxDiedError) throw error;
			if (isMissingPathError(error)) return false;
			throw error;
		}
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		if (options?.recursive === true) {
			const result = await this.runCommand('mkdir', `mkdir -p ${shellQuote(path)}`);
			if (result.exitCode !== 0) {
				throw new Error(
					`[flue:daytona] mkdir failed for ${path}: ` +
						(result.stderr || result.stdout || `exit ${result.exitCode}`),
				);
			}
			return;
		}
		await this.guarded('mkdir', this.sandbox.fs.createFolder(path, '755'));
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		try {
			await this.guarded('rm', this.sandbox.fs.deleteFile(path, options?.recursive === true));
		} catch (error) {
			if (error instanceof SandboxDiedError) throw error;
			if (options?.force === true && isMissingPathError(error)) return;
			throw error;
		}
	}

	async exec(
		command: string,
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			timeoutMs?: number;
			signal?: AbortSignal;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return this.runCommand('exec', command, options);
	}

	private async runCommand(
		operation: string,
		command: string,
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			timeoutMs?: number;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const timeoutSeconds =
			typeof options?.timeoutMs === 'number' ? Math.ceil(options.timeoutMs / 1000) : undefined;
		try {
			const response = await this.guarded(
				operation,
				this.sandbox.process.executeCommand(command, options?.cwd, options?.env, timeoutSeconds),
			);
			return { stdout: response.result, stderr: '', exitCode: response.exitCode };
		} catch (error) {
			if (error instanceof DaytonaProcessExecutionTimeoutError) {
				return {
					stdout: '',
					stderr: `[flue:daytona] Command timed out after ${options?.timeoutMs} milliseconds.`,
					exitCode: 124,
				};
			}
			throw error;
		}
	}
}

export function assertContainer(sandbox: DaytonaSandboxLike): void {
	if (sandbox.sandboxClass !== SandboxClass.CONTAINER) {
		throw new Error(
			`[slack-agent] expected Daytona container sandbox, got ${sandbox.sandboxClass ?? 'unknown'}`,
		);
	}
}

async function ensureContainerSnapshot(client: DaytonaClientLike): Promise<void> {
	try {
		const snapshot = await client.snapshot.get(CONTAINER_SNAPSHOT_NAME);
		if (snapshot.sandboxClass !== undefined && snapshot.sandboxClass !== SandboxClass.CONTAINER) {
			throw new Error(
				`[slack-agent] snapshot ${CONTAINER_SNAPSHOT_NAME} is ${snapshot.sandboxClass}, not container`,
			);
		}
		return;
	} catch (error) {
		if (!(error instanceof DaytonaNotFoundError)) throw error;
	}

	await client.snapshot.create({
		name: CONTAINER_SNAPSHOT_NAME,
		image: containerImage(),
		sandboxClass: SandboxClass.CONTAINER,
		resources: CONTAINER_RESOURCES,
	});
}

async function sandboxNameForConversation(conversationId: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(conversationId),
	);
	const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
		'',
	);
	return `slack-agent-${hex.slice(0, 32)}`;
}

async function findConversationSandbox(
	client: DaytonaClientLike,
	args: { conversationId: string; name: string },
): Promise<DaytonaSandboxLike | undefined> {
	try {
		return await client.get(args.name);
	} catch (error) {
		if (!(error instanceof DaytonaNotFoundError)) throw error;
	}

	const matches: DaytonaSandboxLike[] = [];
	for await (const sandbox of client.list({
		labels: { flueConversationId: args.conversationId },
		limit: 2,
	})) {
		matches.push(sandbox);
		if (matches.length === 2) break;
	}
	if (matches.length > 1) {
		throw new Error(
			`[slack-agent] multiple Daytona sandboxes found for conversation ${args.conversationId}`,
		);
	}
	return matches[0];
}

async function startConversationSandbox(
	sandbox: DaytonaSandboxLike,
): Promise<DaytonaSandboxLike> {
	await sandbox.refreshData();
	assertContainer(sandbox);
	if (sandbox.state === SandboxState.STARTED) return sandbox;
	if (sandbox.state === SandboxState.STOPPED || sandbox.state === SandboxState.ARCHIVED) {
		await sandbox.start(180);
		return sandbox;
	}
	throw new Error(
		`[slack-agent] Daytona sandbox ${sandbox.id} cannot be attached from state ${sandbox.state ?? 'unknown'}`,
	);
}

export async function createContainerSandbox(
	client: DaytonaClientLike,
	args: { conversationId: string },
): Promise<DaytonaSandboxLike> {
	const name = await sandboxNameForConversation(args.conversationId);
	const existing = await findConversationSandbox(client, { ...args, name });
	if (existing) return startConversationSandbox(existing);

	await ensureContainerSnapshot(client);
	const sandbox = await client.create(
		{
			name,
			snapshot: CONTAINER_SNAPSHOT_NAME,
			language: 'typescript',
			autoStopInterval: CONTAINER_AUTO_STOP_MINUTES,
			autoPauseInterval: 0,
			autoArchiveInterval: CONTAINER_AUTO_ARCHIVE_MINUTES,
			autoDeleteInterval: -1,
			ephemeral: false,
			labels: { flueConversationId: args.conversationId },
		},
		{ timeout: 180 },
	);
	try {
		assertContainer(sandbox);
	} catch (error) {
		await sandbox.delete?.(60, true);
		throw error;
	}
	return sandbox;
}

export async function verifyContainerStopStartPersistence(
	sandbox: DaytonaSandboxLike,
): Promise<DaytonaSandboxLike> {
	const marker = Buffer.from(`sandbox:${sandbox.id}`, 'utf8');
	await sandbox.fs.uploadFile(marker, M1_PERSISTENCE_PROBE_PATH);
	await sandbox.stop();
	await sandbox.start();
	const restored = await sandbox.fs.downloadFile(M1_PERSISTENCE_PROBE_PATH);
	if (!restored.equals(marker)) {
		throw new Error('[slack-agent] Daytona container filesystem did not survive stop/start');
	}
	await sandbox.fs.deleteFile(M1_PERSISTENCE_PROBE_PATH);
	return sandbox;
}

/**
 * Create a Flue sandbox factory from an initialized Daytona sandbox.
 * The application owns the sandbox lifecycle; Flue wraps it for agent use.
 */
export function daytona(sandbox: DaytonaSandboxLike, options?: DaytonaAdapterOptions): SandboxFactory {
	return {
		async createSandbox(): Promise<Sandbox> {
			const sandboxCwd = options?.cwd ?? '/workspace';
			const driver = new DaytonaSandboxDriver(sandbox);
			return sandboxFromDriver(driver, sandboxCwd);
		},
	};
}
