# Daytona Container Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unavailable Daytona Linux VM path with a non-ephemeral Daytona container path that proves filesystem persistence across stop/start and never depends on RAM or process continuity.

**Architecture:** The Flue conversation owner continues to create the provider sandbox and wrap it with the existing `SandboxFactory`. The Daytona adapter creates a container-class snapshot and sandbox, performs one M1-only stop/start persistence probe before handing the sandbox to Flue, and retains the existing filesystem/exec driver. Git checkpoints remain recovery truth; the retained container filesystem is only a fast continuation cache.

**Tech Stack:** TypeScript 7, `@daytona/sdk` 0.207.x, `@flue/runtime` 2.0.x, Vitest 4.

## Global Constraints

- Read `AGENTS.md`, `SLACK_AGENT_SPEC.md` D2 and §§4.3, 7, 10–11, `CONTEXT.md`, and `SLACK_AGENT_HANDOFF.md` before editing.
- Use `SandboxClass.CONTAINER`; never request `SandboxClass.LINUX_VM` or call `pause()`.
- Configure `autoStopInterval: 15`, `autoPauseInterval: 0`, `autoArchiveInterval: 10080`, `autoDeleteInterval: -1`, and `ephemeral: false`.
- Stop/start must keep the same sandbox id and filesystem, while every process and all RAM state are treated as lost.
- Keep `DAYTONA_API_KEY` in the control plane and preserve the current no-credential-in-sandbox boundary.
- Preserve `SandboxDiedError`, command timeout mapping, and all existing filesystem-driver behavior.
- Do not add Modal, a Cloudflare Container bridge, a new dependency, or unrelated refactoring.
- Do not commit or push unless the human explicitly asks.

---

### Task 1: Specify the container lease behavior in tests

**Files:**
- Modify: `src/sandboxes/daytona.test.ts`

**Interfaces:**
- Consumes: the current fake `DaytonaSandboxLike` and `DaytonaClientLike` test doubles.
- Produces: failing tests for `assertContainer`, `createContainerSandbox`, and `verifyContainerStopStartPersistence`.

- [ ] **Step 1: Change the fake provider lifecycle from VM pause to container stop**

Change the fake sandbox's default class exactly from:

```ts
sandboxClass: overrides?.sandboxClass ?? 'linux-vm',
```

to:

```ts
sandboxClass: overrides?.sandboxClass ?? 'container',
```

Replace the complete fake `pause()` method:

```ts
async pause() {
	if (overrides?.pause) {
		await overrides.pause();
		return;
	}
	state = 'paused';
},
```

with:

```ts
async stop() {
	if (overrides?.stop) {
		await overrides.stop();
		return;
	}
	state = 'stopped';
},
```

Do not clear the function's existing `files` map in either `stop()` or `start()`; that map is the fake persistent filesystem exercised by the probe test.

- [ ] **Step 2: Replace the Linux VM lease tests with exact container expectations**

Import the new symbols and assert the creation contract:

```ts
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
				return sandbox;
			},
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
```

- [ ] **Step 3: Run the focused test and verify the new API is missing**

Rename the existing test title `rejects in-flight work with SandboxDiedError when the VM is gone` to `rejects in-flight work with SandboxDiedError when the sandbox is gone`; its test body stays unchanged.

Run: `npx vitest run src/sandboxes/daytona.test.ts`

Expected: FAIL because the new container exports do not exist yet.

---

### Task 2: Implement container creation and the stop/start persistence probe

**Files:**
- Modify: `src/sandboxes/daytona.ts`
- Test: `src/sandboxes/daytona.test.ts`

**Interfaces:**
- Consumes: `DaytonaClientLike`, `DaytonaSandboxLike`, and the existing Flue driver.
- Produces: `createContainerSandbox(client, { conversationId })`, `assertContainer(sandbox)`, and `verifyContainerStopStartPersistence(sandbox)`.

- [ ] **Step 1: Replace VM constants and lifecycle types**

```ts
export const CONTAINER_SNAPSHOT_NAME = 'slack-agent-container-v1';
export const CONTAINER_AUTO_STOP_MINUTES = 15;
export const CONTAINER_AUTO_ARCHIVE_MINUTES = 7 * 24 * 60;
export const CONTAINER_RESOURCES = { cpu: 2, memory: 4, disk: 20 };
export const M1_PERSISTENCE_PROBE_PATH = '/workspace/.slack-agent-persistence-probe';
```

In the existing `DaytonaSandboxLike` type, replace only:

```ts
pause(timeout?: number): Promise<void>;
```

with:

```ts
stop(timeout?: number, force?: boolean): Promise<void>;
```

Rename `linuxVmImage()` to `containerImage()` without changing its Node 22, git, and `/workspace` Dockerfile commands. In the file header change “Creating, pausing, resuming” to “Creating, stopping, starting”; in the liveness comment change “VM is gone” and “started VM” to “sandbox is gone” and “started sandbox.”

- [ ] **Step 2: Implement container snapshot validation and creation**

```ts
export function assertContainer(sandbox: DaytonaSandboxLike): void {
	if (sandbox.sandboxClass !== 'container') {
		throw new Error(
			`[slack-agent] expected Daytona container sandbox, got ${sandbox.sandboxClass ?? 'unknown'}`,
		);
	}
}

async function ensureContainerSnapshot(client: DaytonaClientLike): Promise<void> {
	try {
		const snapshot = await client.snapshot.get(CONTAINER_SNAPSHOT_NAME);
		if (snapshot.sandboxClass !== undefined && snapshot.sandboxClass !== 'container') {
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

export async function createContainerSandbox(
	client: DaytonaClientLike,
	args: { conversationId: string },
): Promise<DaytonaSandboxLike> {
	await ensureContainerSnapshot(client);
	const sandbox = await client.create(
		{
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
```

- [ ] **Step 3: Implement the M1 persistence proof**

```ts
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
```

This helper is an M1 provider proof, not the eventual idle lifecycle manager. It must finish before Flue receives the sandbox, so it cannot stop an active `exec`.

- [ ] **Step 4: Run the focused tests**

Run: `npx vitest run src/sandboxes/daytona.test.ts`

Expected: PASS with all Daytona adapter tests green.

---

### Task 3: Wire the container into Coworker and align current-facing docs

**Files:**
- Modify: `src/agents/coworker.ts`
- Modify: `README.md`
- Confirm: `AGENTS.md`, `SLACK_AGENT_SPEC.md`, `SLACK_AGENT_HANDOFF.md`, `CONTEXT.md`, `docs/adr/0015-use-daytona-for-sandbox-compute.md`, `docs/adr/README.md`

**Interfaces:**
- Consumes: `createContainerSandbox` and `verifyContainerStopStartPersistence` from Task 2.
- Produces: a Flue sandbox backed by an available Daytona container and documentation with no live Linux VM requirement.

- [ ] **Step 1: Replace the Coworker VM path**

```ts
import {
	createContainerSandbox,
	daytona,
	verifyContainerStopStartPersistence,
} from '../sandboxes/daytona.ts';

useSandbox({
	async createSandbox(options) {
		const apiKey = process.env.DAYTONA_API_KEY;
		if (!apiKey) {
			throw new Error('DAYTONA_API_KEY is required to create a sandbox.');
		}
		const client = new Daytona({ apiKey });
		const sandbox = await createContainerSandbox(client, { conversationId: options.id });
		await verifyContainerStopStartPersistence(sandbox);
		return daytona(sandbox, { cwd: '/workspace' }).createSandbox(options);
	},
});
```

Remove every import and call named `createLinuxVmSandbox` or `pauseAndResume`.

- [ ] **Step 2: Update runtime documentation**

In `README.md`, replace “Daytona Linux VM” with “Daytona container” and state exactly: “A stopped container retains its filesystem but loses RAM and running processes.” Change the M1 sentence to say that clone/`ls` output comes from a Daytona container. Do not describe pause/resume as supported or required.

- [ ] **Step 3: Scan for stale executable assumptions**

Run:

```sh
rg -n -i "createLinuxVmSandbox|pauseAndResume|LINUX_VM_|Linux VM Sandboxes|autoPauseInterval: 15|\.pause\(" \
  src README.md AGENTS.md SLACK_AGENT_SPEC.md SLACK_AGENT_HANDOFF.md CONTEXT.md docs/adr
```

Expected: no current implementation or current-decision reference remains. Historical/rejected-alternative prose in the spec and ADR may mention Linux VMs or pause/resume only to explain why they were rejected.

- [ ] **Step 4: Run full verification**

Run:

```sh
npm test
npm run check:types
npm run build
```

Expected: all Vitest tests pass, TypeScript exits 0, and the Cloudflare-target Vite build exits 0.

- [ ] **Step 5: Report the provider-dependent check separately**

If `DAYTONA_API_KEY` and network access are available, run the existing local Flue command from `README.md` and confirm the created sandbox reports class `container`, the stop/start probe passes, and clone/`ls` returns. If credentials or network are unavailable, do not claim the live Daytona path passed; report unit/type/build results separately from the unrun live check.
