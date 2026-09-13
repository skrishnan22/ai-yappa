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
import { classifyTelemetryError, emitTelemetry } from '../observability.ts';

export const CONTAINER_SNAPSHOT_NAME = 'slack-agent-container-v2';
export const CONTAINER_AUTO_STOP_MINUTES = 15;
export const CONTAINER_AUTO_ARCHIVE_MINUTES = 7 * 24 * 60;
export const CONTAINER_RESOURCES = { cpu: 2, memory: 4, disk: 3 };
export const M1_PERSISTENCE_PROBE_PATH = '/workspace/.slack-agent-persistence-probe';
export const CONTAINER_IMAGE_COMMANDS = [
	'RUN apt-get update && apt-get install -y git build-essential python3 && rm -rf /var/lib/apt/lists/*',
	'RUN corepack enable',
	'RUN mkdir -p /workspace',
	'WORKDIR /workspace',
];

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
	return Image.base('node:22-bookworm').dockerfileCommands(CONTAINER_IMAGE_COMMANDS);
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
	constructor(
		private sandbox: DaytonaSandboxLike,
		private conversationId: string,
	) {}

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
		operation: 'exec' | 'mkdir',
		command: string,
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			timeoutMs?: number;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const started = Date.now();
		const sandboxCommandId = crypto.randomUUID();
		const timeoutSeconds =
			typeof options?.timeoutMs === 'number' ? Math.ceil(options.timeoutMs / 1000) : undefined;
		try {
			const response = await this.guarded(
				operation,
				this.sandbox.process.executeCommand(command, options?.cwd, options?.env, timeoutSeconds),
			);
			const result = { stdout: response.result, stderr: '', exitCode: response.exitCode };
			emitTelemetry({
				event_name: 'sandbox.command',
				outcome: response.exitCode === 0 ? 'ok' : 'failed',
				conversation_id: this.conversationId,
				sandbox_id: this.sandbox.id,
				sandbox_command_id: sandboxCommandId,
				operation,
				cwd_class: cwdClass(options?.cwd),
				timeout_bucket: timeoutBucket(options?.timeoutMs),
				exit_code: response.exitCode,
				stdout_bytes: byteLength(result.stdout),
				stderr_bytes: 0,
				duration_ms: Math.max(0, Date.now() - started),
			});
			return result;
		} catch (error) {
			if (error instanceof DaytonaProcessExecutionTimeoutError) {
				const result = {
					stdout: '',
					stderr: `[flue:daytona] Command timed out after ${options?.timeoutMs} milliseconds.`,
					exitCode: 124,
				};
				emitTelemetry({
					event_name: 'sandbox.command',
					outcome: 'timeout',
					conversation_id: this.conversationId,
					sandbox_id: this.sandbox.id,
					sandbox_command_id: sandboxCommandId,
					operation,
					cwd_class: cwdClass(options?.cwd),
					timeout_bucket: timeoutBucket(options?.timeoutMs),
					exit_code: result.exitCode,
					stdout_bytes: 0,
					stderr_bytes: byteLength(result.stderr),
					duration_ms: Math.max(0, Date.now() - started),
					...classifyTelemetryError(error),
				});
				return result;
			}
			emitTelemetry({
				event_name: 'sandbox.command',
				outcome: 'failed',
				conversation_id: this.conversationId,
				sandbox_id: this.sandbox.id,
				sandbox_command_id: sandboxCommandId,
				operation,
				cwd_class: cwdClass(options?.cwd),
				timeout_bucket: timeoutBucket(options?.timeoutMs),
				duration_ms: Math.max(0, Date.now() - started),
				...classifyTelemetryError(error),
			});
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

async function ensureContainerSnapshot(client: DaytonaClientLike): Promise<'existing' | 'created'> {
	try {
		const snapshot = await client.snapshot.get(CONTAINER_SNAPSHOT_NAME);
		if (snapshot.sandboxClass !== undefined && snapshot.sandboxClass !== SandboxClass.CONTAINER) {
			throw new Error(
				`[slack-agent] snapshot ${CONTAINER_SNAPSHOT_NAME} is ${snapshot.sandboxClass}, not container`,
			);
		}
		return 'existing';
	} catch (error) {
		if (!(error instanceof DaytonaNotFoundError)) throw error;
	}

	await client.snapshot.create({
		name: CONTAINER_SNAPSHOT_NAME,
		image: containerImage(),
		sandboxClass: SandboxClass.CONTAINER,
		resources: CONTAINER_RESOURCES,
	});
	return 'created';
}

async function sandboxNameForConversation(conversationId: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(conversationId));
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

async function startConversationSandbox(sandbox: DaytonaSandboxLike): Promise<DaytonaSandboxLike> {
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
	const lookupStarted = Date.now();
	let existing: DaytonaSandboxLike | undefined;
	try {
		existing = await findConversationSandbox(client, { ...args, name });
		emitTelemetry({
			event_name: 'sandbox.lifecycle',
			outcome: 'ok',
			conversation_id: args.conversationId,
			sandbox_id: existing?.id,
			phase: 'lookup',
			reused: existing !== undefined,
			duration_ms: Math.max(0, Date.now() - lookupStarted),
		});
	} catch (error) {
		emitTelemetry({
			event_name: 'sandbox.lifecycle',
			outcome: 'failed',
			conversation_id: args.conversationId,
			phase: 'lookup',
			duration_ms: Math.max(0, Date.now() - lookupStarted),
			...classifyTelemetryError(error),
		});
		throw error;
	}
	if (existing) {
		const priorState = existing.state;
		const phase = priorState === SandboxState.STARTED ? 'reuse' : 'start';
		const reuseStarted = Date.now();
		try {
			const reused = await startConversationSandbox(existing);
			emitTelemetry({
				event_name: 'sandbox.lifecycle',
				outcome: 'ok',
				conversation_id: args.conversationId,
				sandbox_id: reused.id,
				phase,
				sandbox_class: reused.sandboxClass,
				prior_state: priorState,
				final_state: reused.state,
				reused: true,
				duration_ms: Math.max(0, Date.now() - reuseStarted),
			});
			return reused;
		} catch (error) {
			emitTelemetry({
				event_name: 'sandbox.lifecycle',
				outcome: 'failed',
				conversation_id: args.conversationId,
				sandbox_id: existing.id,
				phase,
				prior_state: priorState,
				duration_ms: Math.max(0, Date.now() - reuseStarted),
				...classifyTelemetryError(error),
			});
			throw error;
		}
	}

	const snapshotStarted = Date.now();
	try {
		const snapshot = await ensureContainerSnapshot(client);
		emitTelemetry({
			event_name: 'sandbox.lifecycle',
			outcome: snapshot === 'existing' ? 'skipped' : 'ok',
			conversation_id: args.conversationId,
			phase: 'snapshot',
			skipped: snapshot === 'existing',
			duration_ms: Math.max(0, Date.now() - snapshotStarted),
		});
	} catch (error) {
		emitTelemetry({
			event_name: 'sandbox.lifecycle',
			outcome: 'failed',
			conversation_id: args.conversationId,
			phase: 'snapshot',
			duration_ms: Math.max(0, Date.now() - snapshotStarted),
			...classifyTelemetryError(error),
		});
		throw error;
	}

	const createStarted = Date.now();
	let sandbox: DaytonaSandboxLike | undefined;
	try {
		sandbox = await client.create(
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
		assertContainer(sandbox);
		emitTelemetry({
			event_name: 'sandbox.lifecycle',
			outcome: 'ok',
			conversation_id: args.conversationId,
			sandbox_id: sandbox.id,
			phase: 'create',
			sandbox_class: sandbox.sandboxClass,
			final_state: sandbox.state,
			reused: false,
			duration_ms: Math.max(0, Date.now() - createStarted),
		});
		return sandbox;
	} catch (error) {
		if (sandbox !== undefined) await sandbox.delete?.(60, true);
		emitTelemetry({
			event_name: 'sandbox.lifecycle',
			outcome: 'failed',
			conversation_id: args.conversationId,
			sandbox_id: sandbox?.id,
			phase: 'create',
			duration_ms: Math.max(0, Date.now() - createStarted),
			...classifyTelemetryError(error),
		});
		throw error;
	}
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
export function daytona(
	sandbox: DaytonaSandboxLike,
	options?: DaytonaAdapterOptions,
): SandboxFactory {
	return {
		async createSandbox(createOptions): Promise<Sandbox> {
			const sandboxCwd = options?.cwd ?? '/workspace';
			const driver = new DaytonaSandboxDriver(sandbox, createOptions.id);
			return sandboxFromDriver(driver, sandboxCwd);
		},
	};
}

function cwdClass(cwd: string | undefined): 'workspace' | 'repository' | 'other' | 'default' {
	if (cwd === undefined) return 'default';
	if (cwd === '/workspace/repo' || cwd.startsWith('/workspace/repo/')) return 'repository';
	if (cwd === '/workspace' || cwd.startsWith('/workspace/')) return 'workspace';
	return 'other';
}

function timeoutBucket(timeoutMs: number | undefined): 'none' | 'short' | 'medium' | 'long' {
	if (timeoutMs === undefined) return 'none';
	if (timeoutMs <= 5_000) return 'short';
	if (timeoutMs <= 60_000) return 'medium';
	return 'long';
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}
