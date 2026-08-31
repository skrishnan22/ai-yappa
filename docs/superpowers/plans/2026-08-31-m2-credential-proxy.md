# M2 Credential Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the M2 credential proxy: Ed25519 capability mint/verify, typed GitHub ops, and a deterministic working-branch push that vends a token into one `exec` then revokes it.

**Architecture:** Same Worker as Slack/Coworker (no package split). Owner code mints a one-op capability; `executeProxy` verifies, authorizes, talks to GitHub, and audits. The model never receives a credential. `vendPushToken` is not a Flue tool. HTTP route split, D1 audit table, `cfRead`/`awsRead`, rate limits, and hydration wait.

**Tech Stack:** TypeScript, Vitest, `node:crypto` (Ed25519 + RS256), `fetch` to `api.github.com`, existing Flue `defineTool` / `harness.sandbox.exec`. No new npm dependency.

## Global Constraints

- Read `SLACK_AGENT_SPEC.md` D6, D11, D13, D14, §§4.5, 5, 10 before editing.
- Reusable GitHub credentials never enter the sandbox. The only credential-shaped value inside a sandbox is a vended installation token in the environment of one `git push`.
- Capability contents are set by deterministic owner code. No LLM-callable tool returns a credential.
- Investigation tokens structurally cannot include `createBranch`, `createPullRequest`, or `vendPushToken`.
- Repo in a capability is canonical `owner/name`. Ops that name a different repo refuse.
- Do not add `cfRead`, `awsRead`, HTTP `/github/*` routes, a D1 table, octokit, hydration, live run cards, `commandId`/fencing, merge, or deploy.
- Follow existing `src/<area>/<file>.ts` + colocated `*.test.ts` layout.
- Do not commit or push unless the human explicitly asks.

---

### File map

| File | Responsibility |
|------|----------------|
| `src/proxy/capabilities.ts` | Ed25519 key helpers, mint, verify, canonical repo |
| `src/proxy/ops.ts` | Submission→ops table, `executeProxy` pipeline, audit records |
| `src/proxy/github.ts` | `GitHubPort`, production fetch/App JWT, op handlers |
| `src/proxy/checkpoint.ts` | vend → env-injected push → confirm ref → revoke |
| `src/agents/github-tools.ts` | Flue tools that mint one-op tokens and call the proxy |
| `src/agents/coworker.ts` | Mount tools; pin conversation repo; prompt |
| `src/config.ts` | Optional GitHub installation id if needed by the live port |
| `README.md` / `SLACK_AGENT_SPEC.md` | Secrets + dated M2 layout note |

---

### Task 1: Capability tokens

**Files:**
- Create: `src/proxy/capabilities.ts`
- Test: `src/proxy/capabilities.test.ts`

**Interfaces:**
- Produces: `SubmissionType`, `ProxyOp`, `CapabilityClaims`, `generateCapabilityKeyPair`, `mintCapability`, `verifyCapability`, `canonicalRepo`, `OPS_BY_SUBMISSION`, `assertOpAllowed`

- [ ] **Step 1: Write the failing tests**

```ts
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
	assertOpAllowed,
	canonicalRepo,
	generateCapabilityKeyPair,
	mintCapability,
	verifyCapability,
} from './capabilities.ts';

describe('canonicalRepo', () => {
	test('normalizes a github https url to owner/name', () => {
		expect(canonicalRepo('https://github.com/skrishnan22/codevil.git')).toBe(
			'skrishnan22/codevil',
		);
	});

	test('accepts owner/name', () => {
		expect(canonicalRepo('skrishnan22/codevil')).toBe('skrishnan22/codevil');
	});

	test('rejects a non-github host', () => {
		expect(() => canonicalRepo('https://gitlab.com/org/repo.git')).toThrow(/github/i);
	});
});

describe('capability tokens', () => {
	test('round-trips a one-op token', () => {
		const keys = generateCapabilityKeyPair();
		const token = mintCapability({
			keys,
			now: 1_000_000,
			claims: {
				conversationId: 'c1',
				submissionId: 's1',
				submissionType: 'code-change',
				repo: 'skrishnan22/codevil',
				allowedOps: ['readIssue'],
			},
		});
		const verified = verifyCapability({ token, keys, now: 1_000_000 });
		expect(verified).toEqual({
			conversationId: 'c1',
			submissionId: 's1',
			submissionType: 'code-change',
			repo: 'skrishnan22/codevil',
			allowedOps: ['readIssue'],
			exp: 1_000_000 + 600,
			kid: keys.kid,
		});
	});

	test('rejects an expired token', () => {
		const keys = generateCapabilityKeyPair();
		const token = mintCapability({
			keys,
			now: 1_000_000,
			claims: {
				conversationId: 'c1',
				submissionId: 's1',
				submissionType: 'code-change',
				repo: 'skrishnan22/codevil',
				allowedOps: ['readIssue'],
			},
		});
		expect(() => verifyCapability({ token, keys, now: 1_000_000 + 601 })).toThrow(/expir/i);
	});

	test('rejects a token signed by a different key', () => {
		const a = generateCapabilityKeyPair();
		const b = generateCapabilityKeyPair();
		const token = mintCapability({
			keys: a,
			now: 1_000_000,
			claims: {
				conversationId: 'c1',
				submissionId: 's1',
				submissionType: 'code-change',
				repo: 'skrishnan22/codevil',
				allowedOps: ['readIssue'],
			},
		});
		expect(() => verifyCapability({ token, keys: b, now: 1_000_000 })).toThrow(/signat/i);
	});
});

describe('assertOpAllowed', () => {
	test('investigation cannot vend a push token', () => {
		expect(() => assertOpAllowed({ submissionType: 'investigation', op: 'vendPushToken' })).toThrow(
			/investigation/i,
		);
	});

	test('code-change can vend a push token', () => {
		expect(() => assertOpAllowed({ submissionType: 'code-change', op: 'vendPushToken' })).not.toThrow();
	});
});
```

- [ ] **Step 2: Run tests — expect FAIL** (module missing)

```sh
npx vitest run src/proxy/capabilities.test.ts
```

- [ ] **Step 3: Implement**

Types and table:

```ts
export type SubmissionType = 'code-change' | 'investigation';

export type ProxyOp =
	| 'readIssue'
	| 'readRepoMetadata'
	| 'createBranch'
	| 'createPullRequest'
	| 'vendPushToken';

export const OPS_BY_SUBMISSION = {
	'code-change': [
		'readIssue',
		'readRepoMetadata',
		'createBranch',
		'createPullRequest',
		'vendPushToken',
	],
	investigation: ['readIssue', 'readRepoMetadata'],
} as const satisfies Record<SubmissionType, readonly ProxyOp[]>;

export type CapabilityKeys = {
	kid: string;
	privateKeyPem: string;
	publicKeyPem: string;
};

export type CapabilityClaims = {
	conversationId: string;
	submissionId: string;
	submissionType: SubmissionType;
	repo: string;
	allowedOps: ProxyOp[];
	exp: number;
	kid: string;
};
```

- `generateCapabilityKeyPair()` uses `generateKeyPairSync('ed25519')`, exports PKCS8/SPKI PEM, `kid` is first 8 hex chars of SHA-256 of the public PEM.
- Token format: `base64url(JSON header).base64url(JSON payload).base64url(sig)` with `{ alg: 'EdDSA', kid }`. Sign/verify with `node:crypto` `sign(null, …)` / `verify(null, …)` on Ed25519 keys imported from PEM.
- `mintCapability` sets `exp = now + 600`. Refuse `allowedOps` empty, refuse ops not in `OPS_BY_SUBMISSION[submissionType]`, refuse `exp` window other than 600s.
- `canonicalRepo`: accept `https://github.com/{owner}/{name}` with optional `.git` and trailing slash, or `{owner}/{name}`. Throw otherwise.
- `assertOpAllowed`: `OPS_BY_SUBMISSION[type]` must include `op`.

- [ ] **Step 4: Run tests — expect PASS**

```sh
npx vitest run src/proxy/capabilities.test.ts
```

---

### Task 2: executeProxy pipeline

**Files:**
- Create: `src/proxy/ops.ts`
- Test: `src/proxy/ops.test.ts`

**Interfaces:**
- Consumes: Task 1 mint/verify/canonicalRepo
- Produces: `AuditRecord`, `AuditSink`, `executeProxy`, `ProxyExecuteArgs`

`executeProxy` does: verify token → `op ∈ claims.allowedOps` → op allowed for `submissionType` → `canonicalRepo(params.repo) === claims.repo` → dispatch handler → write audit.

Params always include `repo: string`. Extra fields per op are validated by the handler (Task 3). For this task, inject a handler map so tests do not need GitHub.

```ts
export type AuditRecord = {
	ts: number;
	conversationId: string;
	submissionId: string;
	op: ProxyOp;
	paramsDigest: string;
	outcome: 'ok' | 'unauthorized' | 'invalid' | 'upstream';
	latencyMs: number;
};

export type AuditSink = {
	append(record: AuditRecord): void;
};

export type ProxyHandler = (args: {
	claims: CapabilityClaims;
	params: unknown;
}) => Promise<unknown>;

export async function executeProxy(args: {
	token: string;
	keys: CapabilityKeys;
	op: ProxyOp;
	params: unknown;
	now: number;
	handlers: Record<ProxyOp, ProxyHandler>;
	audit: AuditSink;
}): Promise<{ ok: true; data: unknown } | { ok: false; error: { kind: AuditRecord['outcome']; message: string } }>
```

- [ ] **Step 1: Write failing tests** covering:
  1. Happy path: one-op `readIssue` token, matching repo, handler returns `{ title: 'Bug' }`, audit `outcome: 'ok'`.
  2. Token whose `allowedOps` is `readIssue` cannot run `createPullRequest` (`unauthorized`).
  3. Investigation token cannot run `createBranch` even if someone stuffed it in `allowedOps` — mint already refuses; also execute refuses if claims were forged… execute uses `assertOpAllowed` on verified claims, so a validly minted investigation token never has write ops. Test execute with a code-change token that only allows `readIssue` attempting `vendPushToken`.
  4. Params repo `other/other` vs claims `skrishnan22/codevil` → `unauthorized`.
  5. `paramsDigest` is stable SHA-256 hex of canonical JSON of params (no secrets; vendPushToken params are just `{ repo }`).

- [ ] **Step 2: Run — expect FAIL**

```sh
npx vitest run src/proxy/ops.test.ts
```

- [ ] **Step 3: Implement** `executeProxy`. On handler throw, audit `upstream` and return `{ ok: false, error: { kind: 'upstream', message } }`. Never put handler results that look like tokens into audit (digest params only).

- [ ] **Step 4: Run — expect PASS**

```sh
npx vitest run src/proxy/ops.test.ts
```

---

### Task 3: GitHub op handlers

**Files:**
- Create: `src/proxy/github.ts`
- Test: `src/proxy/github.test.ts`

**Interfaces:**
- Consumes: `ProxyOp`, `canonicalRepo`, `CapabilityClaims`
- Produces: `GitHubPort`, `githubHandlers(port)`, production `createGitHubPort(env)`

```ts
export type GitHubPort = {
	createInstallationToken(args: {
		repo: string;
		permissions: { contents: 'read' | 'write'; pull_requests: 'read' | 'write' };
	}): Promise<{ token: string; expiresAt: string }>;
	revokeInstallationToken(token: string): Promise<void>;
	request(args: {
		method: 'GET' | 'POST';
		path: string;
		body?: unknown;
		token: string;
	}): Promise<{ status: number; json: unknown }>;
};
```

Handlers (params validated; extra keys ignored; missing keys → throw invalid):

| op | params | GitHub |
|----|--------|--------|
| `readIssue` | `{ repo, number }` | `GET /repos/{repo}/issues/{number}` |
| `readRepoMetadata` | `{ repo }` | `GET /repos/{repo}` |
| `createBranch` | `{ repo, name, fromSha }` | `POST /repos/{repo}/git/refs` body `{ ref: 'refs/heads/{name}', sha: fromSha }` |
| `createPullRequest` | `{ repo, head, base, title, body }` | `POST /repos/{repo}/pulls` |
| `vendPushToken` | `{ repo }` | `createInstallationToken` with contents+PRs write, **not cached** |

Return typed JSON to the caller: issue `{ number, title, state, htmlUrl, body }`; repo `{ fullName, defaultBranch, htmlUrl }`; branch `{ ref, sha }`; PR `{ number, htmlUrl, head, base }`; vend `{ token, expiresAt }` — **only `executeProxy` callers in owner code see vend**. Tools in Task 5 must not mount this op.

Read ops may reuse an installation token cached on the port until 5 minutes before `expiresAt`. Push tokens skip that cache.

- [ ] **Step 1: Write failing tests** with an in-memory fake `GitHubPort` that records calls:
  1. `readIssue` hits the issues path and maps fields (`html_url` → `htmlUrl`).
  2. `createPullRequest` posts to `/pulls` and does not call `createInstallationToken` with a token that gets returned from the handler… the handler obtains a token internally via `createInstallationToken` then `request`. Assert the returned object has `htmlUrl` and **no** `token` field.
  3. `vendPushToken` returns `{ token, expiresAt }` and uses write permissions.
  4. Two `readIssue` calls share one cached installation token; `vendPushToken` always calls `createInstallationToken` again.
  5. Non-2xx `request` throws with the status in the message.

- [ ] **Step 2: Run — expect FAIL**

```sh
npx vitest run src/proxy/github.test.ts
```

- [ ] **Step 3: Implement handlers + fake-friendly port type.** Implement `createGitHubPort` against `api.github.com`:
  - Env: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PEM, `\n` unescaped), `GITHUB_APP_INSTALLATION_ID`.
  - App JWT: RS256, `iat = now-60`, `exp = now+540`, `iss = appId`, `node:crypto` `createSign('RSA-SHA256')`.
  - Create token: `POST /app/installations/{id}/access_tokens` with `{ repositories: [name], permissions }`.
  - Revoke: `DELETE https://api.github.com/installation/token` with that token as bearer.
  - If env is missing, `createGitHubPort()` throws a clear error (tests never call it).

- [ ] **Step 4: Run — expect PASS**

```sh
npx vitest run src/proxy/github.test.ts
```

---

### Task 4: Deterministic checkpoint push

**Files:**
- Create: `src/proxy/checkpoint.ts`
- Test: `src/proxy/checkpoint.test.ts`

**Interfaces:**
- Consumes: `executeProxy`, `githubHandlers`, `mintCapability`, `assertOpAllowed`
- Produces: `checkpointWorkingBranch`, `workingBranchName`

```ts
export function workingBranchName(conversationId: string): string {
  // 'agent/' + conversationId with characters outside [A-Za-z0-9._-] replaced by '-'
}

export async function checkpointWorkingBranch(args: {
  conversationId: string;
  submissionId: string;
  repo: string; // url or owner/name
  expectedSha: string;
  keys: CapabilityKeys;
  now: number;
  execute: typeof executeProxy extends never ? never : /* same executeProxy deps via a bound client */
  exec: (command: string, options: { env: Record<string, string> }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}): Promise<{ branch: string; sha: string; htmlUrl: string | null }>
```

Better: pass a bound `proxy` object `{ mint, execute }` plus `exec`.

Flow (all owner-side, not the model):

1. `assertOpAllowed({ submissionType: 'code-change', op: 'vendPushToken' })` — this path is code-change only.
2. Mint one-op `vendPushToken` for `canonicalRepo(repo)`.
3. `executeProxy` → `{ token, expiresAt }`.
4. `exec` git push **without interpolating the token into the command string**:

```ts
await exec(`git push origin HEAD:refs/heads/${branch}`, {
  env: {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: bearer ${token}`,
  },
});
```

`branch` is `workingBranchName(conversationId)`. If `exitCode !== 0`, still revoke, then throw (include stderr, never the env).

5. Mint one-op `readRepoMetadata` is not enough for the SHA. Confirm with a **non-tool** proxy read: add handler-internal use of `GET /repos/{repo}/git/ref/heads/{branch}` via the port from a new op `readRef`? **Do not add a sixth LLM-facing op.** Confirm inside `checkpointWorkingBranch` by minting `readRepoMetadata` is wrong. Instead: pass `GitHubPort` into checkpoint **only for confirm+revoke after vend** would skip the proxy for confirm.

Spec: confirm via a proxy read. Add proxy op `readRef` that is **not** in `OPS_BY_SUBMISSION` wait — then it can't be minted.

Simplest spec-faithful approach: extend `readRepoMetadata`? No.

Add `readRef` to `ProxyOp` and to **code-change and investigation** allowed ops, but **do not** mount a Flue tool for it. Checkpoint mints `readRef` with params `{ repo, ref: 'refs/heads/' + branch }` and handler `GET /repos/{repo}/git/ref/{ref}` (GitHub wants `heads/foo` encoded). Compare `object.sha` to `expectedSha`. Then revoke the push token.

If `readRef` is added in Task 3, update Task 1 table. **Do it in Task 1/3 as part of this task if missing:** add `'readRef'` to both submission types in `OPS_BY_SUBMISSION`.

6. Mint `vendPushToken` result token → `revokeInstallationToken`. Always revoke in `finally`.

7. Return `{ branch, sha: expectedSha, htmlUrl: 'https://github.com/{repo}/tree/{branch}' }`. Output to the model from the tool wrapper must not include any token.

- [ ] **Step 1: Tests**
  1. Push env contains `AUTHORIZATION: bearer ghs_test` and command does not contain `ghs_test`.
  2. Confirm calls `readRef`; mismatch SHA throws after revoke.
  3. Failed push (exit 1) still revokes.
  4. Investigation cannot call this function (throws before vend).
  5. `workingBranchName('C1/123.45')` is a legal git ref suffix (no `/` from the id except the `agent/` prefix — replace `/` in the id).

- [ ] **Step 2: FAIL then implement then PASS**

```sh
npx vitest run src/proxy/checkpoint.test.ts
```

---

### Task 5: Coworker brain-side tools

**Files:**
- Create: `src/agents/github-tools.ts`
- Modify: `src/agents/coworker.ts`
- Test: `src/agents/github-tools.test.ts`

Tools (each mints **one** op, `submissionType: 'code-change'`, `submissionId: 'active'`, repo from conversation `canonicalRepo(data.repo)` — **ignore any model-supplied repo**):

| name | model input | proxy op |
|------|-------------|----------|
| `read_github_issue` | `{ number }` | `readIssue` |
| `read_github_repo` | `{}` | `readRepoMetadata` |
| `create_working_branch` | `{ name, fromSha }` | `createBranch` — **override `name`** with `workingBranchName(conversationId)` if you want D4 one branch. Spec D4 is one working branch. **Ignore model `name`; use `workingBranchName`.** Input is `{ fromSha }` only. |
| `open_pull_request` | `{ title, body, base }` | `createPullRequest` with `head: workingBranchName(...)` |
| `checkpoint_working_branch` | `{ expectedSha }` | harness tool calling `checkpointWorkingBranch`; `harness: true` |

Keys: `capabilityKeysFromEnv()` reads `CAPABILITY_PRIVATE_KEY` / `CAPABILITY_PUBLIC_KEY` / `CAPABILITY_KID`. Missing keys: tools throw a clear error (local `flue run` without them fails closed). Tests pass keys in.

`checkpoint_working_branch` uses `harness.sandbox.exec`.

Prompt additions (keep clone/`ls` first-mention guidance): GitHub reads/PRs go through these tools; persist git with `checkpoint_working_branch`; never `git push` with a token; never merge or deploy.

- [ ] **Step 1: Tests** for tool wrappers with a fake `executeProxy`:
  1. `read_github_issue` mints `allowedOps: ['readIssue']` only and forces `repo` from conversation, not `data.repo` from the model. Pass model input that tries `number` only.
  2. `open_pull_request` output has `htmlUrl` and no `token` key.
  3. `checkpoint_working_branch` is not allowed to return `token`.

Tool modules should accept injected `{ keys, execute, now, conversationId, repo, submissionId }` factories so tests do not need Flue.

- [ ] **Step 2–4:** FAIL, implement, PASS

```sh
npx vitest run src/agents/github-tools.test.ts
```

Wire `useTool(...)` in `Coworker` with conversation id from `channel` instance — the agent function receives `props.id` if declared as `function Coworker(props: AgentProps)`. Use `props.id` as `conversationId`. `useInitialData().repo` as repo.

```ts
export function Coworker(props: AgentProps) {
  const data = useInitialData<...>();
  // ...
  for (const tool of githubTools({ conversationId: props.id, repo: data.repo })) {
    useTool(tool);
  }
}
```

`githubTools` returns the five tools. `createGitHubPort` + `executeProxy` with real handlers when env is present; if GitHub env is missing, still mount tools that return a typed error output `{ error: 'GITHUB_* secrets are not configured' }` so Slack clone/`ls` keeps working without GitHub. **Fail closed on actual GitHub calls, not on agent boot.**

---

### Task 6: Docs and spec note

**Files:**
- Modify: `README.md`
- Modify: `SLACK_AGENT_SPEC.md` under §11 M1 layout / a new **M2 layout (2026-08-31)** note

Document secrets: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`, `CAPABILITY_PRIVATE_KEY`, `CAPABILITY_PUBLIC_KEY`, `CAPABILITY_KID`.

Dated note: proxy is in-process in this Worker (`src/proxy/*`); HTTP split and D1 cross-conversation audit wait; `readRef` is proxy-only (not a model tool); hydration still not in this tree.

- [ ] **Step 1: Edit the two markdown files**
- [ ] **Step 2: Run full unit tests + types**

```sh
npm test && npm run check:types
```

Expected: all existing tests still pass; new proxy/tool tests pass.

---

## Self-review

1. **Spec coverage:** D6/D11/D13/D14, §4.5 GitHub ops, vend+revoke push, investigation cannot write. Not in this plan: cf/aws, D1 audit table, rate limits, fencing, hydration, progress card (M3).
2. **Placeholders:** none; `readRef` is specified as proxy-only.
3. **Names:** `executeProxy`, `GitHubPort`, `checkpointWorkingBranch`, `workingBranchName`, `canonicalRepo` are consistent across tasks.
