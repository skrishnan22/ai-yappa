# Repo-optional Conversations and DMs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Yappa works in any channel the bot is in and in DMs, with no repo required; the agent attaches one repo per conversation, checked against the GitHub App installation.

**Architecture:** The Coworker keeps its repo in persistent state (seeded from `initialData.repo`). With no repo it mounts only `attach_repo`; once set, Flue attaches the Daytona sandbox at the next turn boundary and the GitHub tools mount. Admission drops the `no-repo` refusal and treats a DM like a mention ("addressed").

**Tech Stack:** TypeScript, Flue (`@flue/runtime`, `@flue/slack`), valibot, Vitest, Cloudflare Workers.

**Spec:** `docs/superpowers/specs/2026-10-13-repo-optional-conversations-design.md`

## Global Constraints

- One repo per conversation, permanent once attached.
- Repo access is decided in code against the GitHub App installation, never by the model.
- External Slack Connect users stay refused, in channels and DMs. Bots stay ignored.
- Repo values stored and passed to hydration are HTTPS clone URLs (`https://github.com/<owner>/<name>.git`), matching `channelRepos`.
- Check optional values by truthiness (`AGENTS.md` Conventions).
- Every batch ends green: `pnpm test`, `pnpm run check:types`, `pnpm run lint`, `pnpm run fmt:check`.

## Review Focus

- A repo typed with different case (`Acme/API`) attaches as the installation's canonical name. Test in Task 2.
- A typo'd repo gets suggestions instead of a bare refusal. Test in Task 2.
- A DM that mentions the bot still dispatches, since `app_mention` does not fire in DMs. Test in Task 5.
- An existing conversation created with `initialData.repo` keeps its sandbox and tools after deploy. Covered by the `repo ?? initialData.repo` fallback in Task 3; reviewer checks the expression.
- The GitHub installation lookup failing (secrets missing, GitHub down) surfaces as a tool error the model can explain, not a crashed submission. Test in Task 2.

## Batches

Stop after each batch for the user's review before starting the next.

1. **GitHub repo lookup and `attach_repo`** (Tasks 1–2): new, unused code.
2. **Coworker without a repo** (Task 3): the agent can run repo-less.
3. **Admission and DMs** (Tasks 4–5): user-visible behavior change.
4. **Manifest and docs** (Task 6).

---

## Batch 1 — GitHub repo lookup and `attach_repo`

### Task 1: List the GitHub App installation's repositories

**Files:**
- Modify: `src/proxy/github.ts` (add `listInstallationRepositories`; extract the App config read shared with `createGitHubPort`)
- Test: `src/proxy/github.test.ts`

**Interfaces:**
- Produces: `listInstallationRepositories(env?: NodeJS.ProcessEnv): Promise<string[]>`, returning `owner/name` for every repository the installation can access.

- [ ] **Step 1: Write the failing test** (append inside `describe('createGitHubPort', …)`'s file, as a new `describe`, reusing the `rsaPem` pattern)

```ts
describe('listInstallationRepositories', () => {
	const rsaPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
		.privateKey.export({ type: 'pkcs1', format: 'pem' })
		.toString();

	const env = {
		GITHUB_APP_ID: '1',
		GITHUB_APP_PRIVATE_KEY: rsaPem,
		GITHUB_APP_INSTALLATION_ID: '2',
	};

	test('pages through every repository with an unscoped token, then revokes it', async () => {
		const requests: { method: string; url: string; body: string | undefined }[] = [];
		const original = globalThis.fetch;
		const page1 = Array.from({ length: 100 }, (_, i) => ({ full_name: `acme/repo-${i}` }));

		globalThis.fetch = async (input, init) => {
			const url = String(input);
			const method = init?.method ?? 'GET';
			requests.push({ method, url, body: v.is(v.string(), init?.body) ? init.body : undefined });

			if (url.endsWith('/access_tokens')) {
				return new Response(JSON.stringify({ token: 'ghs_list', expires_at: '2099-01-01T00:00:00Z' }), {
					status: 201,
				});
			}

			if (method === 'DELETE') return new Response(null, { status: 204 });

			const page = new URL(url).searchParams.get('page');
			const repositories = page === '1' ? page1 : [{ full_name: 'acme/api' }];

			return new Response(JSON.stringify({ repositories }), { status: 200 });
		};

		try {
			const names = await listInstallationRepositories(env);

			expect(names).toHaveLength(101);
			expect(names.at(-1)).toBe('acme/api');
			expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({ permissions: { metadata: 'read' } });
			expect(requests.map((r) => r.method)).toEqual(['POST', 'GET', 'GET', 'DELETE']);
		} finally {
			globalThis.fetch = original;
		}
	});

	test('names the missing GitHub App secrets', async () => {
		await expect(listInstallationRepositories({})).rejects.toThrow(/GITHUB_APP_ID/);
	});
});
```

Add `listInstallationRepositories` to the import from `./github.ts`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/proxy/github.test.ts -t listInstallationRepositories`
Expected: FAIL, `listInstallationRepositories` is not exported.

- [ ] **Step 3: Implement**

In `src/proxy/github.ts`, extract the config read from `createGitHubPort` and use it in both:

```ts
function githubAppConfig(env: NodeJS.ProcessEnv): {
	appId: string;
	pem: string;
	installationId: string;
} {
	const appId = env.GITHUB_APP_ID;
	const pem = normalizeGithubAppPrivateKey(env.GITHUB_APP_PRIVATE_KEY);
	const installationId = env.GITHUB_APP_INSTALLATION_ID;

	if (!appId || !pem || !installationId) {
		throw new Error(
			'GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID are required.',
		);
	}

	return { appId, pem, installationId };
}
```

`createGitHubPort` starts with `const { appId, pem, installationId } = githubAppConfig(env);` and drops its own checks.

```ts
const INSTALLATION_PAGE_SIZE = 100;

/**
 * Every repository the App installation can reach, as `owner/name`. Mints a
 * metadata-only token for the whole installation and revokes it afterwards.
 */
export async function listInstallationRepositories(
	env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
	const { appId, pem, installationId } = githubAppConfig(env);
	const jwt = signAppJwt({ appId, privateKeyPem: pem, now: Math.floor(Date.now() / 1000) });

	const minted = mapToken(
		await githubOk(
			await githubFetch({
				method: 'POST',
				path: `/app/installations/${installationId}/access_tokens`,
				token: jwt,
				tokenType: 'Bearer',
				body: { permissions: { metadata: 'read' } },
			}),
		),
	);

	try {
		const names: string[] = [];

		for (let page = 1; ; page++) {
			const json = await githubOk(
				await githubFetch({
					method: 'GET',
					path: `/installation/repositories?per_page=${INSTALLATION_PAGE_SIZE}&page=${page}`,
					token: minted.token,
					tokenType: 'Bearer',
				}),
			);

			const { repositories } = parsedOutput(
				v.looseObject({ repositories: v.array(v.looseObject({ full_name: v.string() })) }),
				json,
				'GitHub returned an unexpected repository list',
			);

			names.push(...repositories.map((repository) => repository.full_name));

			if (repositories.length < INSTALLATION_PAGE_SIZE) return names;
		}
	} finally {
		// Best effort: the token expires within the hour anyway.
		await githubFetch({
			method: 'DELETE',
			path: '/installation/token',
			token: minted.token,
			tokenType: 'Bearer',
		}).catch(() => undefined);
	}
}
```

Check `parsedOutput`'s argument order against its other call sites in this file (`mapToken`) and match it.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/proxy/github.test.ts`
Expected: PASS, including the existing `createGitHubPort` tests.

- [ ] **Step 5: Commit**

```bash
git add src/proxy/github.ts src/proxy/github.test.ts
git commit -m "List the GitHub App installation's repositories"
```

### Task 2: `attach_repo` tool

**Files:**
- Create: `src/agents/attach-repo.ts`
- Test: `src/agents/attach-repo.test.ts`

**Interfaces:**
- Consumes: `canonicalRepo(input: string): string` from `src/proxy/policy.ts` (throws on bad input; returns `owner/name`).
- Produces:
  - `type RepoDirectory = { list(): Promise<string[]> }`
  - `cachedRepoDirectory(list: () => Promise<string[]>, now?: () => number): RepoDirectory`, 5-minute cache, failures not cached.
  - Revised in review: `RepoDirectory` became `{ find(repo); list() }` with no cache. `find` is an exact check (`findInstallationRepository` in `src/proxy/github.ts`, a repo-scoped metadata token mint); `list` runs only on a miss, for suggestions.
  - `attachRepoTool(args: { directory: RepoDirectory; attach: (repoUrl: string) => void }): ToolDefinition`, the tool named `attach_repo` with input `{ repo: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
import type { ToolDefinition } from '@flue/runtime';
import { describe, expect, test, vi } from 'vitest';
import { attachRepoTool, cachedRepoDirectory } from './attach-repo.ts';

const INSTALLED = ['acme/api', 'acme/web', 'acme/infra'];

function run(tool: ToolDefinition, repo: string) {
	return tool.run({ data: { repo }, toolCallId: 'attach', log: { info() {}, warn() {}, error() {} } });
}

function setup(list: () => Promise<string[]> = async () => INSTALLED) {
	const attached: string[] = [];
	const tool = attachRepoTool({
		directory: cachedRepoDirectory(list),
		attach: (repo) => attached.push(repo),
	});

	return { tool, attached };
}

describe('attach_repo', () => {
	test('attaches an installed repo given as owner/name or URL, as a clone URL', async () => {
		for (const input of ['acme/api', 'https://github.com/acme/api', 'https://github.com/acme/api.git']) {
			const { tool, attached } = setup();
			await run(tool, input);
			expect(attached).toEqual(['https://github.com/acme/api.git']);
		}
	});

	test('uses the installation spelling when case differs', async () => {
		const { tool, attached } = setup();
		await run(tool, 'Acme/API');
		expect(attached).toEqual(['https://github.com/acme/api.git']);
	});

	test('refuses a repo the App cannot access and suggests the closest', async () => {
		const { tool, attached } = setup();
		await expect(run(tool, 'acme/apii')).rejects.toThrow(/cannot access acme\/apii.*acme\/api/);
		expect(attached).toEqual([]);
	});

	test('refuses a non-GitHub value without a lookup', async () => {
		const list = vi.fn(async () => INSTALLED);
		const { tool } = setup(list);
		await expect(run(tool, 'https://gitlab.com/acme/api')).rejects.toThrow(/github.com/);
		expect(list).not.toHaveBeenCalled();
	});

	test('surfaces a failed installation lookup as a tool error', async () => {
		const { tool } = setup(async () => {
			throw new Error('GitHub 503');
		});
		await expect(run(tool, 'acme/api')).rejects.toThrow(/GitHub 503/);
	});
});

describe('cachedRepoDirectory', () => {
	test('reuses a lookup for five minutes and does not cache a failure', async () => {
		let now = 0;
		const list = vi
			.fn<() => Promise<string[]>>()
			.mockRejectedValueOnce(new Error('down'))
			.mockResolvedValue(INSTALLED);
		const directory = cachedRepoDirectory(list, () => now);

		await expect(directory.list()).rejects.toThrow('down');
		await directory.list();
		now = 4 * 60 * 1000;
		await directory.list();
		expect(list).toHaveBeenCalledTimes(2);
		now = 6 * 60 * 1000;
		await directory.list();
		expect(list).toHaveBeenCalledTimes(3);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/agents/attach-repo.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/agents/attach-repo.ts`**

```ts
import { defineTool, type ToolDefinition } from '@flue/runtime';
import levenshtein from 'damerau-levenshtein';
import * as v from 'valibot';
import { canonicalRepo } from '../proxy/policy.ts';

export type RepoDirectory = { list(): Promise<string[]> };

const DIRECTORY_TTL_MS = 5 * 60 * 1000;

const MAX_SUGGESTIONS = 5;

/** Per-isolate cache of the installation's repositories. A failed lookup is retried next call. */
export function cachedRepoDirectory(
	list: () => Promise<string[]>,
	now: () => number = Date.now,
): RepoDirectory {
	let cached: { names: string[]; at: number } | undefined;

	return {
		async list() {
			if (cached && now() - cached.at < DIRECTORY_TTL_MS) return cached.names;

			const names = await list();
			cached = { names, at: now() };

			return names;
		},
	};
}

function closestRepos(wanted: string, names: string[]): string[] {
	const name = (full: string) => full.split('/')[1] ?? full;

	return names
		.map((candidate) => ({
			candidate,
			steps: Math.min(
				levenshtein(wanted, candidate.toLowerCase()).steps,
				levenshtein(name(wanted), name(candidate.toLowerCase())).steps,
			),
		}))
		.sort((a, b) => a.steps - b.steps || a.candidate.localeCompare(b.candidate))
		.slice(0, MAX_SUGGESTIONS)
		.map(({ candidate }) => candidate);
}

/**
 * The one repository a conversation works on. Code checks it against the
 * GitHub App installation; the model only names it.
 */
export function attachRepoTool(args: {
	directory: RepoDirectory;
	attach: (repoUrl: string) => void;
}): ToolDefinition {
	return defineTool({
		name: 'attach_repo',
		description:
			'Attach the GitHub repository this conversation works on, as owner/name or a github.com URL. Call it before any code or GitHub work. A thread has one repository and cannot change it. If the repository is ambiguous, ask the user instead of guessing.',
		input: v.object({ repo: v.pipe(v.string(), v.minLength(1)) }),
		async run({ data }) {
			const wanted = canonicalRepo(data.repo).toLowerCase();
			const names = await args.directory.list();
			const match = names.find((name) => name.toLowerCase() === wanted);

			if (!match) {
				const closest = closestRepos(wanted, names);

				throw new Error(
					closest.length > 0
						? `The GitHub App cannot access ${wanted}. Closest it can access: ${closest.join(', ')}.`
						: `The GitHub App cannot access ${wanted}, and it is installed on no repositories.`,
				);
			}

			const repoUrl = `https://github.com/${match}.git`;
			args.attach(repoUrl);

			return {
				output: {
					attached: repoUrl,
					note: 'The workspace for this repository attaches before your next step.',
				},
			};
		},
	});
}
```

If `damerau-levenshtein` is imported differently in `src/agents/model-choice.ts`, match that import.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/agents/attach-repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Batch checks and commit**

Run: `pnpm run check:types && pnpm run lint && pnpm run fmt:check`

```bash
git add src/agents/attach-repo.ts src/agents/attach-repo.test.ts
git commit -m "Add attach_repo, checked against the GitHub App installation"
```

**⏸ Checkpoint 1.** Stop and show the user the two commits.

---

## Batch 2 — Coworker without a repo

### Task 3: Optional repo in the Coworker

**Files:**
- Modify: `src/agents/coworker.ts` (schema, persistent `repo`, conditional sandbox/GitHub tools/`attach_repo`)
- Modify: `src/sandboxes/hydrate.ts:48-71` (`coworkerInstructions(repo?: string)`)
- Test: `src/sandboxes/hydrate.test.ts`

**Interfaces:**
- Consumes: `attachRepoTool` (Task 2); `findInstallationRepository`, `listInstallationRepositories` (Task 1).
- Produces: `initialData.repo` is optional on `Coworker`. Persistent state key `'repo'` (`string | null`) holds an attached repo. Batch 3 dispatches with `repo: undefined`.

- [ ] **Step 1: Write the failing test** (add to `describe('coworkerInstructions', …)`)

```ts
test('without a repository, answers directly and attaches one before code work', () => {
	const prompt = coworkerInstructions(undefined);
	expect(prompt).toMatch(/has no repository yet/i);
	expect(prompt).toContain('attach_repo');
	expect(prompt).toMatch(/ask the user/i);
	expect(prompt).not.toContain(WORKSPACE_REPO_DIR);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/sandboxes/hydrate.test.ts -t "without a repository"`
Expected: FAIL (type error or the prompt still names the workspace).

- [ ] **Step 3: Implement instructions**

In `src/sandboxes/hydrate.ts`, change the signature to `coworkerInstructions(repo: string | undefined)` and replace the two binding lines (51–52) with a spread of:

```ts
const binding = repo
	? [
			`This conversation is bound to one Slack thread and the repository ${repo}.`,
			`The workspace is already cloned and dependencies are installed at ${WORKSPACE_REPO_DIR}.`,
		]
	: [
			'This conversation is bound to one Slack thread and has no repository yet.',
			'Answer requests that need no code directly, without a repository.',
			'When a request needs code or GitHub, infer the repository from the request and thread, then call attach_repo before any other code work; the workspace and GitHub tools appear after it succeeds.',
			'If the repository is ambiguous, or attach_repo refuses it, ask the user which one they mean. A thread works on one repository only.',
		];
```

- [ ] **Step 4: Implement the Coworker change**

In `src/agents/coworker.ts`:

1. Schema: `repo: v.optional(v.pipe(v.string(), v.url())),`
2. Imports: `attachRepoTool` from `./attach-repo.ts`; `findInstallationRepository`, `listInstallationRepositories` from `../proxy/github.ts`.
3. Module scope, after `instrument(...)`:

```ts
const installationRepos = {
	find: (repo: string) => findInstallationRepository(repo),
	list: () => listInstallationRepositories(),
};
```

4. In `Coworker`, after `const agentEnv = loadAgentEnv();`:

```ts
// An attached repo wins; older conversations carry theirs in initialData.
const [attachedRepo, setAttachedRepo] = usePersistentState<string | null>('repo', null);
const repo = attachedRepo ?? data.repo;
```

5. Wrap the `githubTools` loop: `if (repo) { for (const tool of githubTools({ …, repo, … })) useTool(tool); } else { useTool(attachRepoTool({ directory: installationRepos, attach: (url) => { setAttachedRepo(url); } })); }`
6. Wrap `useSandbox({...})` in `if (repo) { … }` and use `repo` instead of `data.repo` inside `hydrateWorkspace`.
7. `return coworkerInstructions(repo);`

No test for the render wiring: Flue renders need the runtime; the tool and the instructions are tested, and the acceptance check in Batch 3 covers the wiring.

- [ ] **Step 5: Run checks**

Run: `pnpm test && pnpm run check:types && pnpm run lint && pnpm run fmt:check`
Expected: all PASS. `src/channels/slack.ts` still always passes a repo, so behavior is unchanged until Batch 3.

- [ ] **Step 6: Local smoke**

Run: `pnpm flue run src/agents/coworker.ts --message "What is a monorepo? One sentence."` with an `initialData` that has no `repo` if `flue run` accepts one (see `pnpm flue docs read cli/run`). Expected: an answer with no Daytona sandbox created. If `flue run` cannot pass initialData, skip and note it for the checkpoint.

- [ ] **Step 7: Commit**

```bash
git add src/agents/coworker.ts src/sandboxes/hydrate.ts src/sandboxes/hydrate.test.ts
git commit -m "Let a Coworker run without a repo and attach one on demand"
```

**⏸ Checkpoint 2.** Stop for review.

---

## Batch 3 — Admission and DMs

### Task 4: Admission without `no-repo`, with addressed signals

**Files:**
- Modify: `src/channels/admit.ts`
- Modify: `src/channels/slack.ts` (drop the `no-repo` case and its refusal text)
- Modify: `src/observability.ts` (signal and decision unions)
- Test: `src/channels/admit.test.ts`

**Interfaces:**
- Produces:
  - `type SlackSignal = 'slack.app_mention' | 'slack.direct_message' | 'slack.message'`
  - `isAddressed(signal: SlackSignal): boolean`, true for a mention or a DM.
  - `AdmitDecision` dispatch variant `{ kind: 'dispatch'; repo: string | undefined }`; no `no-repo`.

- [ ] **Step 1: Update tests**

In `src/channels/admit.test.ts`, replace `'refuses a workspace member in a channel with no repo'` with:

```ts
test('a mention in a channel with no default repo dispatches without one', () => {
	expect(
		decideAdmit({
			signalType: 'slack.app_mention',
			external: false,
			repo: undefined,
			conversationExists: false,
			planningActive: false,
		}),
	).toEqual({ kind: 'dispatch', repo: undefined });
});

test('a direct message creates a conversation', () => {
	expect(
		decideAdmit({
			signalType: 'slack.direct_message',
			external: false,
			repo: undefined,
			conversationExists: false,
			planningActive: false,
		}),
	).toEqual({ kind: 'dispatch', repo: undefined });
});

test('an external direct message is refused', () => {
	expect(
		decideAdmit({
			signalType: 'slack.direct_message',
			external: true,
			repo: undefined,
			conversationExists: false,
			planningActive: false,
		}),
	).toEqual({ kind: 'refuse-external' });
});
```

In `describe('during a planning session', …)` add:

```ts
test('a direct message is dispatched', () => {
	expect(
		decideAdmit({
			signalType: 'slack.direct_message',
			external: false,
			repo: undefined,
			conversationExists: true,
			planningActive: true,
		}),
	).toEqual({ kind: 'dispatch', repo: undefined });
});
```

In the `decideInvocation` tests add:

```ts
test('parses model arguments on a direct message that creates a conversation', () => {
	expect(
		decideInvocation({
			signalType: 'slack.direct_message',
			text: '$model:kimi hello',
			chatgptConnected: false,
			conversationExists: false,
		}),
	).toMatchObject({ kind: 'proceed', body: 'hello' });
});
```

Check the expected `body` against an existing `$model:` test in the file and match its trimming.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/channels/admit.test.ts`
Expected: FAIL (`slack.direct_message` not assignable; `no-repo` returned).

- [ ] **Step 3: Implement `admit.ts`**

```ts
export type SlackSignal = 'slack.app_mention' | 'slack.direct_message' | 'slack.message';

/** A mention or any DM: the user is talking to Yappa, not only to the thread. */
export function isAddressed(signal: SlackSignal): boolean {
	return signal !== 'slack.message';
}
```

`AdmitDecision`: delete `{ kind: 'no-repo' }`; change dispatch to `{ kind: 'dispatch'; repo: string | undefined }`.

`decideAdmit` body:

```ts
const addressed = isAddressed(args.signalType);

if (!addressed && !args.conversationExists) return { kind: 'drop-untracked' };

if (args.external) return { kind: 'refuse-external' };

if (!addressed && args.planningActive) return { kind: 'drop-planning' };

return { kind: 'dispatch', repo: args.repo };
```

`decideInvocation`: `if (!isAddressed(args.signalType) || args.conversationExists) { … }`.

- [ ] **Step 4: Follow-through**

- `src/observability.ts`: `signal_type: SlackSignal` (import the type from `./channels/admit.ts`), delete `'no-repo'` from `decision`.
- `src/channels/slack.ts`: delete the `case 'no-repo':` block and `'no-repo'` from `refuse`'s `kind` union. `repo: decision.repo` stays and may now be `undefined`.

- [ ] **Step 5: Run checks**

Run: `pnpm test && pnpm run check:types`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/channels/admit.ts src/channels/admit.test.ts src/channels/slack.ts src/observability.ts
git commit -m "Admit mentions without a default repo; treat DMs as addressed"
```

### Task 5: DM ingress

**Files:**
- Modify: `src/channels/slack.ts` (`message` case)
- Modify: `src/agents/coworker.ts:150-153` (skill invocation on DMs)
- Test: `src/channels/slack.test.ts`

**Interfaces:**
- Consumes: `SlackSignal`, `isAddressed` (Task 4).

- [ ] **Step 1: Write failing tests** in `src/channels/slack.test.ts`

Extend `SlackEventPayload['event']` with `channel_type?: 'im' | 'channel'` and add `authorizations?: { user_id: string; is_bot: boolean }[]` to the payload type. Then add:

```ts
describe('direct messages', () => {
	const DM_CHANNEL = 'D0DIRECT';

	function dmPayload(eventId: string, text: string, thread_ts?: string): SlackEventPayload {
		return {
			type: 'event_callback',
			token: 'verification-token',
			team_id: WORKSPACE_TEAM,
			api_app_id: 'AAPP',
			event_id: eventId,
			event_time: 1710000000,
			authorizations: [{ user_id: 'UBOT', is_bot: true }],
			event: {
				type: 'message',
				channel_type: 'im',
				user: FOLLOW_UP_USER,
				text,
				channel: DM_CHANNEL,
				ts: '1710000100.000001',
				...(thread_ts ? { thread_ts } : {}),
			},
		};
	}

	function recording(exists: boolean) {
		const requests: Array<Parameters<SlackRuntime['dispatch']>[1]> = [];
		const runtime: SlackRuntime = {
			dispatch: async (_agent, request) => {
				requests.push(request);

				return { submissionId: 's', acceptedAt: '2026-10-13T00:00:00.000Z', uid: 'uid' };
			},
			getAgentInstance: async () => (exists ? { id: 'instance', uid: 'uid' } : null),
		};

		return { requests, runtime };
	}

	test('a top-level DM starts a conversation with no repo', async () => {
		const { requests, runtime } = recording(false);
		stubSlackApi(async () => ({ ok: true, messages: [] }));
		const channel = createSlackChannelForEnv(env, codexAuth, runtime);

		await channel.route().fetch(signedEventRequest(dmPayload('Ev-dm', 'what is new in AI?')));

		expect(requests).toHaveLength(1);
		expect(requests[0]?.initialData).toMatchObject({ channelId: DM_CHANNEL, threadTs: '1710000100.000001' });
		expect(requests[0]?.initialData?.repo).toBeUndefined();
		expect(requests[0]?.message).toMatchObject({ type: 'slack.direct_message' });
	});

	test('a DM that mentions the bot is still dispatched', async () => {
		const { requests, runtime } = recording(false);
		stubSlackApi(async () => ({ ok: true, messages: [] }));
		const channel = createSlackChannelForEnv(env, codexAuth, runtime);

		await channel.route().fetch(signedEventRequest(dmPayload('Ev-dm-mention', '<@UBOT> hi')));

		expect(requests).toHaveLength(1);
	});

	test('a reply in a DM thread continues that conversation', async () => {
		const { requests, runtime } = recording(true);
		stubSlackApi(async () => ({ ok: true, messages: [] }));
		const channel = createSlackChannelForEnv(env, codexAuth, runtime);

		await channel
			.route()
			.fetch(signedEventRequest(dmPayload('Ev-dm-reply', 'more please', '1710000000.000009')));

		expect(requests[0]?.initialData).toMatchObject({ threadTs: '1710000000.000009' });
	});
});

test('a mention in a channel with no default repo dispatches without one', async () => {
	const requests: Array<Parameters<SlackRuntime['dispatch']>[1]> = [];
	const runtime: SlackRuntime = {
		dispatch: async (_agent, request) => {
			requests.push(request);

			return { submissionId: 's', acceptedAt: '2026-10-13T00:00:00.000Z', uid: 'uid' };
		},
		getAgentInstance: async () => null,
	};
	stubSlackApi(async () => ({ ok: true, messages: [] }));
	const channel = createSlackChannelForEnv(env, codexAuth, runtime);
	const payload = eventPayload({
		eventId: 'Ev-unbound',
		type: 'app_mention',
		user: THREAD_STARTER,
		text: '<@UBOT> hi',
		ts: THREAD_TS,
	});
	payload.event.channel = 'C0UNBOUND';

	await channel.route().fetch(signedEventRequest(payload));

	expect(requests).toHaveLength(1);
	expect(requests[0]?.initialData?.repo).toBeUndefined();
});
```

If `initialData` is typed `unknown` on the request, read it through a small valibot `v.parse(v.looseObject({ repo: v.optional(v.string()), channelId: v.string(), threadTs: v.string() }), …)` instead of optional chaining.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/channels/slack.test.ts -t "direct messages"`
Expected: FAIL (no dispatch for a top-level DM).

- [ ] **Step 3: Implement the `message` case**

```ts
case 'message': {
	const event = payload.event;

	if (event.subtype !== undefined) return;

	if (event.bot_id !== undefined) return;

	const direct = event.channel_type === 'im';

	if (!direct && event.thread_ts === undefined) return;

	// app_mention does not fire in DMs, so a DM that mentions Yappa is still the DM.
	if (!direct && mentionsAuthorizedBot(event.text ?? '', payload.authorizations)) return;
	await admitThread({
		channel,
		env,
		codexAuth,
		runtime,
		planning,
		thread: {
			teamId: payload.team_id,
			channelId: event.channel,
			threadTs: event.thread_ts ?? event.ts,
		},
		userId: event.user,
		external: isExternalEvent(payload, event),
		eventId: payload.event_id,
		text: event.text ?? '',
		signalType: direct ? 'slack.direct_message' : 'slack.message',
		timeoutRetry,
	});

	return;
}
```

- [ ] **Step 4: Skill invocation on DMs** in `src/agents/coworker.ts`:

```ts
const invoked =
	delivery.kind === 'signal' &&
	(delivery.type === 'slack.app_mention' || delivery.type === 'slack.direct_message')
		? invokedSkills(delivery.body, new Set(skills.map((skill) => skill.name)))
		: [];
```

- [ ] **Step 5: Run checks**

Run: `pnpm test && pnpm run check:types && pnpm run lint && pnpm run fmt:check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/channels/slack.ts src/channels/slack.test.ts src/agents/coworker.ts
git commit -m "Start and continue conversations from direct messages"
```

**⏸ Checkpoint 3.** Stop for review. Live acceptance needs the manifest changes in Batch 4 applied to the Slack app.

---

## Batch 4 — Manifest and docs

### Task 6: Slack manifest, ADR 0024, and doc updates

**Files:**
- Modify: `slack-app-manifest.yaml`
- Create: `docs/adr/0024-github-app-installation-is-the-access-boundary.md`
- Modify: `docs/adr/README.md`, `SLACK_AGENT_SPEC.md`, `CONTEXT.md`, `AGENTS.md`, `README.md`, `src/config.ts` (comment only)

- [ ] **Step 1: Manifest**

```yaml
display_information:
  name: Slack Agent
  description: Internal coding coworker. Mention it in a channel or DM it to start a thread-bound conversation.
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user: …unchanged…
  slash_commands: …unchanged…
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - commands
      - channels:history
      - groups:history
      - im:history
settings:
  event_subscriptions:
    request_url: https://example.invalid/channels/slack/events
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
  interactivity: …unchanged…
```

- [ ] **Step 2: ADR 0024.** Same shape as `docs/adr/0022-channel-members-may-use-yappa.md`: Status (accepted; supersedes ADR 0022 decision 1), Context (DMs and repo-less work; binding as an access list blocks both), Decision (the GitHub App installation is the boundary; any workspace member in any channel the bot is in or a DM; one repo per conversation via `attach_repo`, checked in code; `channelRepos` is a default repo; external users refused; Codex admins unchanged), Consequences (installing the App on a repo is now the access decision; chat-only threads create no sandbox), Alternatives (allowlist for repo attach; read-only unbound conversations).

- [ ] **Step 3: Doc updates**

- `docs/adr/README.md`: add the 0024 row; mark 0022 "Partially superseded by ADR 0024 (decision 1)".
- `SLACK_AGENT_SPEC.md`: where admission and the channel→repo binding are described, state that a mention anywhere or a DM is admitted, the repo is attached per conversation, and `channelRepos` is a default.
- `CONTEXT.md`: bound channel → default repo; add "Attached repo".
- `AGENTS.md`: Slack ingress line (DMs; no-repo refusal gone) and `config.ts` line ("default repo per channel; GitHub App installation is the access boundary, ADR 0024").
- `README.md`: Slack app setup mentions the messages tab, `im:history`, and `message.im`.
- `src/config.ts`: update the `codexAdminIds` comment's "bound channel (ADR 0022)" wording to ADR 0024.

- [ ] **Step 4: Checks and commit**

Run: `pnpm run fmt:check && pnpm run lint`

```bash
git add slack-app-manifest.yaml docs/adr SLACK_AGENT_SPEC.md CONTEXT.md AGENTS.md README.md src/config.ts
git commit -m "Document repo-optional conversations and DMs (ADR 0024)"
```

**⏸ Checkpoint 4.** Stop for review. Then the user applies the manifest to the Slack app and runs the spec's acceptance checks: a DM answer with no sandbox; an unbound-channel mention that attaches `owner/name`; a refused unknown repo with suggestions; a bound channel unchanged; an external user refused.
