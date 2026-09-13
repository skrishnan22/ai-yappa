# Simplify GitHub Authorization and Harden Checkpoint Push

> **For the implementing agent:** REQUIRED SUB-SKILL: use `executing-plans` or `subagent-driven-development` and implement this plan task-by-task. Use `test-driven-development` for behavior changes and `verification-before-completion` before reporting success.

**Goal:** Remove the internal Ed25519 capability-token mint/verify machinery, retain deterministic repository and operation authorization in trusted Worker code, reduce unnecessary GitHub installation-token minting, and harden the one remaining sandbox credential exposure during checkpoint push.

**Architecture:** GitHub tools remain narrow Flue tools backed by an in-process trusted integration boundary. The model supplies only operation-specific data; trusted conversation context supplies the repository, submission type, conversation id, and submission id. Normal GitHub operations use Worker-held cached installation tokens. Checkpoint push alone receives a fresh `contents:write`, single-repository installation token in one sandbox process, pushes to an explicit GitHub URL with hooks disabled, verifies the remote SHA, and revokes the token in `finally`-equivalent cleanup.

**Tech stack:** TypeScript, Vitest, `node:crypto` for GitHub App RS256 JWT signing only, GitHub REST API, Flue tools, Daytona sandbox execution. No new package, HTTP proxy service, database, or provider-specific secret integration.

**Prepared against:** branch `m3-run-card` at `2251efebde9c`. Recheck the branch and diff before implementation; do not silently transplant the plan if the credential paths have changed.

## Decision status

This plan records the agreed v1 decision:

- Remove the internal capability token. Its signer and verifier currently run in the same Worker trust boundary, so the signature, expiry, and `kid` add key management and per-call work without separating authority.
- Keep authorization. `submissionType -> allowed operation` policy, repo pinning, typed tool inputs, output sanitization, audit records, deterministic branch naming, and GitHub App permission scoping remain security controls.
- Do not add a network credential proxy. The current “proxy” is an in-process trusted integration layer and should remain one.
- Accept bounded checkpoint-token exposure for the current internal pilot. The sandbox receives a real GitHub installation token during one `git push`; this is not strict secret isolation.
- Defer Daytona Secrets/egress substitution. A live SDK check with `@daytona/sdk@0.207.0` authenticated successfully enough to list sandboxes, but both `daytona.secret.list()` and `daytona.secret.create()` returned `403 DaytonaAuthorizationError: Access denied`. No secret or sandbox was created. The result does not distinguish plan availability from a missing `manage:secrets` scope.

The implementation must not describe the result as “the sandbox never handles a GitHub token.” The accurate statement is: the model never receives the token in a tool result, while the sandbox Git process receives a fresh, repo-scoped token for the duration of checkpoint push.

## Why the deterministic policy still matters

Removing the signed wrapper does not mean accepting arbitrary model instructions. The reasoning loop consumes attacker-influenceable issue text, repository files, command output, and Slack content. Trusted code must therefore continue to decide:

1. which repository this conversation owns;
2. whether the submission is `code-change` or `investigation`;
3. which named operations that submission type permits;
4. the working branch name;
5. the GitHub installation-token repository and permission set; and
6. the exact destination used by checkpoint push.

The replacement for a capability claim is not model input. It is an `OperationContext` assembled by the conversation owner from trusted initial data and runtime metadata.

## Security invariants

The finished implementation must preserve all of these invariants:

- The GitHub App private key stays in Worker secrets and never enters sandbox creation options, command environments, tool results, errors, or logs.
- A model-callable tool can neither choose a repository nor request a permission set.
- Operation parameters do not contain `repo`; handlers receive the canonical repo from trusted `OperationContext`.
- Investigation submissions cannot call `createBranch`, `createPullRequest`, or `vendPushToken`.
- `vendPushToken` remains internal and is never registered as a Flue/model tool.
- Read and trusted-side write installation tokens remain inside the Worker and may be cached until five minutes before expiry.
- A push token is minted fresh for each checkpoint, scoped to exactly one repository and `contents:write`, never cached, and revoked after success or failure.
- Checkpoint push targets `https://github.com/<owner>/<repo>.git` constructed from canonical trusted context. It never uses mutable `origin`.
- Checkpoint push uses `--no-verify`, so repository-controlled pre-push hooks do not run in the token-bearing process.
- The local `HEAD` must equal `expectedSha` before token issuance, and the remote branch SHA must equal it before checkpoint success is returned.
- Push stdout/stderr from the token-bearing process is not returned to the model. A malicious or replaced executable could print its environment.
- Trusted application code creates and pushes only the deterministic conversation branch. The temporary `contents:write` token itself has repository-content authority during its exposure window, so branch protection remains necessary. Merge, deploy, workflow modification, repository administration, and arbitrary ref selection remain outside the application API.
- Audit records include the canonical repository after `repo` is removed from operation params; an invalid, non-canonicalizable context records `repo: null`.

## Explicit residual risk accepted for v1

The hardening above reduces exposure but does not create a secret boundary inside the sandbox. Code with sufficient access in the same sandbox may observe another process environment, replace or wrap `git`, or otherwise exercise the short-lived token while it is valid. Revocation shortens the window but cannot undo an action already accepted by GitHub.

The external controls are therefore part of the v1 posture:

- install the GitHub App only on enrolled repositories;
- grant only the permissions actually needed by the application;
- protect default and release branches;
- do not grant administration, actions/workflows, deployment, secret, merge-bypass, or organization-wide permissions;
- ensure the agent pushes only to the deterministic working branch; and
- use this design for the internal pilot, not as a claim of hostile multi-tenant sandbox isolation.

## Non-goals

Do not add any of the following in this change:

- Daytona Secrets, secret placeholders, `domainAllowList`, or custom egress policy;
- a forward proxy, reverse proxy, new Worker route, sidecar, Agent Vault, or credential relay;
- support for arbitrary authenticated CLI commands;
- Cloudflare/AWS integration operations;
- a D1 audit migration;
- merge, deploy, branch deletion, or workflow-file mutation;
- changes to sandbox hydration;
- changes to `.env` or `.dev.vars` contents;
- deletion of deployed Cloudflare secrets; or
- a live push against a real repository without separate human authorization.

## Target control flow

```text
model requests checkpoint(expectedSha)
  -> Flue validates the narrow tool input
  -> owner attaches trusted OperationContext
  -> owner verifies local HEAD equals expectedSha without credentials
  -> policy allows vendPushToken only for code-change
  -> GitHub App mints fresh repo-only contents:write token
  -> sandbox runs one explicit git push with token in per-exec env
  -> Worker reads the exact remote branch ref using trusted GitHub handler
  -> Worker compares remote SHA with expectedSha
  -> Worker revokes push token on every post-mint path
  -> model receives only branch/SHA/URL or a sanitized error
```

## File map

| File | Required change |
|---|---|
| `src/proxy/capabilities.ts` | Delete after callers move. |
| `src/proxy/capabilities.test.ts` | Delete; preserve policy tests in `policy.test.ts`. |
| `src/proxy/policy.ts` | New home for submission types, operation names, allowlist, and repo canonicalization. No cryptography. |
| `src/proxy/policy.test.ts` | Test repo canonicalization and submission operation policy. |
| `src/proxy/ops.ts` | Replace verified claims with trusted `OperationContext`; keep authorization, execution, and audit. |
| `src/proxy/ops.test.ts` | Replace signed-token tests with trusted-context authorization and repo-pinning tests. |
| `src/proxy/github.ts` | Use context repo, introduce precise permission profiles, and cache only Worker-held tokens. |
| `src/proxy/github.test.ts` | Assert exact token permissions, cache behavior, and sanitized mapped outputs. |
| `src/proxy/checkpoint.ts` | Remove capability minting and harden explicit push, error handling, confirmation, and revocation. |
| `src/proxy/checkpoint.test.ts` | Cover command destination, hooks, token exposure boundary, SHA checks, and cleanup. |
| `src/agents/github-tools.ts` | Remove capability keys/env parsing and call the trusted operation executor directly. |
| `src/agents/github-tools.test.ts` | Prove tools work without `CAPABILITY_*` and the model cannot select repo or push-token permissions. |
| `SLACK_AGENT_SPEC.md` | Replace D13/D14 and all current capability-token claims with the accepted v1 design. |
| `SLACK_AGENT_HANDOFF.md` | Replace the capability invariant and link this implementation plan. |
| `CONTEXT.md` | Remove `Capability Grant`; redefine the current in-process `Credential Proxy`. |
| `README.md` | Remove capability-key setup and document GitHub App requirements/current risk. |
| `docs/adr/0016-simplify-github-authorization.md` | Record the new decision and deferred strict-isolation alternative. |
| `docs/adr/README.md` | Add ADR 0016 and mark ADR 0013 partially superseded. |

---

## Task 1: Separate policy from capability cryptography

**Files:**

- Create: `src/proxy/policy.ts`
- Create: `src/proxy/policy.test.ts`
- Delete after migration: `src/proxy/capabilities.ts`
- Delete after migration: `src/proxy/capabilities.test.ts`

- [ ] First, create `policy.test.ts` by moving only the existing `canonicalRepo` and `assertOpAllowed` coverage. Add cases for an investigation read and investigation write refusal.
- [ ] Run `npx vitest run src/proxy/policy.test.ts`; expect failure because `policy.ts` does not exist.
- [ ] Move the non-cryptographic declarations and functions into `policy.ts`:

```ts
export type SubmissionType = 'code-change' | 'investigation';

export type ProxyOp =
	| 'readIssue'
	| 'readRepoMetadata'
	| 'readRef'
	| 'createBranch'
	| 'createPullRequest'
	| 'vendPushToken';

export const OPS_BY_SUBMISSION = {
	'code-change': [
		'readIssue',
		'readRepoMetadata',
		'readRef',
		'createBranch',
		'createPullRequest',
		'vendPushToken',
	],
	investigation: ['readIssue', 'readRepoMetadata', 'readRef'],
} as const satisfies Record<SubmissionType, readonly ProxyOp[]>;

export function assertOpAllowed(args: {
	submissionType: SubmissionType;
	op: ProxyOp;
}): void {
	const allowed: readonly ProxyOp[] = OPS_BY_SUBMISSION[args.submissionType];
	if (!allowed.includes(args.op)) {
		throw new Error(`op ${args.op} is not allowed for ${args.submissionType} submissions`);
	}
}
```

Keep `canonicalRepo` behavior unchanged: accept `owner/name` and GitHub HTTPS URLs, normalize optional `.git`, and reject other hosts or malformed input.

- [ ] Do not move any of these symbols: `CAPABILITY_TTL_SECONDS`, `CapabilityKeys`, `CapabilityClaims`, `generateCapabilityKeyPair`, `mintCapability`, `verifyCapability`, signing/parsing helpers, or Ed25519 imports.
- [ ] Migrate every production and test import from `./capabilities.ts` to `./policy.ts` before deleting the old files. Do not leave a compatibility re-export.
- [ ] Run `npx vitest run src/proxy/policy.test.ts`; expect pass.

The point of this task is deletion: the final repository must have no internal capability-token format, signing key, verification key, expiry check, `kid`, or Ed25519 dependency.

---

## Task 2: Replace capability claims with trusted operation context

**Files:**

- Modify: `src/proxy/ops.ts`
- Modify: `src/proxy/ops.test.ts`

- [ ] Rewrite tests first around the target API.
- [ ] Add the following domain type:

```ts
export type OperationContext = {
	conversationId: string;
	submissionId: string;
	submissionType: SubmissionType;
	repo: string;
};
```

- [ ] Change handlers to receive the context rather than verified claims:

```ts
export type ProxyHandler = (args: {
	context: OperationContext;
	params: unknown;
}) => Promise<unknown>;
```

- [ ] Change `executeProxy` to this input shape:

```ts
export async function executeProxy(args: {
	context: OperationContext;
	op: ProxyOp;
	params: unknown;
	now: number;
	handlers: Record<ProxyOp, ProxyHandler>;
	audit: AuditSink;
}): Promise<ProxyResult>;
```

- [ ] At the start of `executeProxy`, create a normalized context with `repo: canonicalRepo(args.context.repo)`. Treat canonicalization failure as `invalid`, not `upstream`.
- [ ] Call `assertOpAllowed({ submissionType: context.submissionType, op: args.op })` before selecting a handler. Return/audit `unauthorized` when it refuses.
- [ ] Remove `token`, `keys`, `verifyCapability`, `claims.allowedOps`, `repoFromParams`, and the params-vs-claim comparison.
- [ ] Do not accept `repo` in operation params. Pass canonical `context.repo` to the handler. This makes cross-repository operation requests unrepresentable in the internal API instead of detecting them after the fact.
- [ ] Add `repo: string | null` to `AuditRecord`. Removing repo from params would otherwise remove the target resource from the audit trail. Record the canonical repo for every request that passes canonicalization and `null` only when canonicalization itself fails. Never copy malformed raw repo text into the audit record. Keep `paramsDigest` limited to operation-specific params and do not put tokens in either field.
- [ ] Preserve the existing outcomes: `ok`, `unauthorized`, `invalid`, `upstream`.
- [ ] Preserve `digestParams` and canonical JSON behavior.

Required tests:

1. a code-change read calls its handler and audits `ok` with canonical `repo`;
2. an investigation read is allowed;
3. an investigation `createBranch` and `vendPushToken` are refused before handler execution and audit `unauthorized`;
4. a GitHub URL in context becomes canonical `owner/name` before handler execution;
5. malformed context repo returns/audits `invalid` with `repo: null`;
6. handler failure returns/audits `upstream`;
7. params digest is stable and contains no implicit repo; and
8. the handler input contains authoritative context plus operation-specific params only.

- [ ] Run `npx vitest run src/proxy/ops.test.ts`; expect pass.

---

## Task 3: Make GitHub installation-token profiles explicit

**Files:**

- Modify: `src/proxy/github.ts`
- Modify: `src/proxy/github.test.ts`

The internal Ed25519 token is being deleted. GitHub installation access tokens remain necessary: the GitHub App JWT is exchanged for them, and GitHub REST/Git operations use them. Avoid describing this GitHub exchange as capability minting.

- [ ] Change the permission type so individual fields are optional and exact profiles are expressible:

```ts
export type GitHubInstallationPermissions = {
	contents?: 'read' | 'write';
	issues?: 'read' | 'write';
	pull_requests?: 'read' | 'write';
};

export type GitHubPort = {
	createInstallationToken(args: {
		repo: string;
		permissions: GitHubInstallationPermissions;
	}): Promise<{ token: string; expiresAt: string }>;
	// existing revokeInstallationToken and request members
};
```

- [ ] Define three immutable profiles:

```ts
const READ_PERMISSIONS = {
	contents: 'read',
	issues: 'read',
	pull_requests: 'read',
} as const;

const TRUSTED_WRITE_PERMISSIONS = {
	contents: 'write',
	pull_requests: 'write',
} as const;

const PUSH_PERMISSIONS = { contents: 'write' } as const;
```

`TRUSTED_WRITE_PERMISSIONS` is acceptable because its token never leaves trusted Worker code and `executeProxy` still limits the available named operation. `PUSH_PERMISSIONS` must not include `pull_requests` because that token enters the sandbox.

- [ ] Replace the single-entry `createReadTokenCache` with a small reusable cache keyed by canonical repo. Construct one cache for `READ_PERMISSIONS` and one for `TRUSTED_WRITE_PERMISSIONS` inside `githubHandlers`.
- [ ] Keep the existing five-minute expiry skew. Inject a `now: () => number = Date.now` clock into the cache or `githubHandlers` so expiry behavior is deterministic in tests.
- [ ] `readIssue`, `readRepoMetadata`, and `readRef` use the read cache.
- [ ] `createBranch` and `createPullRequest` use the trusted-write cache. This removes a GitHub installation-token creation request from every trusted-side write operation.
- [ ] `vendPushToken` bypasses all caches and calls `createInstallationToken` with `PUSH_PERMISSIONS` every time.
- [ ] Every handler obtains `repo` from `context.repo`. Delete `requireRepo`; update parsers to parse only operation-specific fields.
- [ ] Keep token values private. Normal handler outputs must remain mapped/sanitized, and only the internal `vendPushToken` result contains a token.
- [ ] Keep `createGitHubPort` narrowing issuance with `repositories: [name]` and the selected permission profile.
- [ ] Remove capability-specific wording from GitHub App RSA key errors. For example:

```text
GITHUB_APP_PRIVATE_KEY must be the RSA .pem downloaded for the GitHub App.
```

Required tests:

1. all reads for one repo reuse a valid read token;
2. different repos use different cached tokens;
3. an expired or within-five-minutes token is refreshed;
4. `createBranch` and `createPullRequest` reuse the trusted-write token for the same repo;
5. trusted-write tokens have exactly `contents:write` and `pull_requests:write`;
6. each `vendPushToken` call creates a new token;
7. push-token permissions equal exactly `{ contents: 'write' }`;
8. token requests name exactly one repository;
9. normal mapped outputs contain no token; and
10. GitHub App key errors no longer refer to Ed25519 or `CAPABILITY_PRIVATE_KEY`.

- [ ] Run `npx vitest run src/proxy/github.test.ts`; expect pass.

---

## Task 4: Harden checkpoint push while keeping the accepted temporary exposure

**Files:**

- Modify: `src/proxy/checkpoint.ts`
- Modify: `src/proxy/checkpoint.test.ts`

- [ ] Rewrite checkpoint fixtures to use `OperationContext`; remove generated capability keys from every test.
- [ ] Change `checkpointWorkingBranch` to accept `context: OperationContext` plus `expectedSha`, `now`, handlers, audit, exec, and revoke. Do not accept duplicated conversation/repo/submission fields.
- [ ] Retain the up-front `vendPushToken` policy check or rely on `executeProxy` before any token is issued. There must be no path where an investigation reaches the vend handler.
- [ ] Keep this sequence exactly:

1. canonicalize trusted context repo;
2. derive deterministic branch with `workingBranchName(context.conversationId)`;
3. execute `git rev-parse HEAD` without credentials;
4. compare local SHA to `expectedSha`;
5. execute internal `vendPushToken` through the trusted policy layer;
6. run the one token-bearing push;
7. execute `readRef` through the same trusted policy layer;
8. compare remote SHA to `expectedSha`;
9. revoke the push token after every post-issuance success or failure; and
10. return only `{ branch, sha, htmlUrl }`.

- [ ] Use an explicit trusted remote URL and disable hooks:

```ts
const remote = `https://github.com/${repo}.git`;
const refspec = `HEAD:refs/heads/${branch}`;
const command = `git push --no-verify ${shellQuote(remote)} ${shellQuote(refspec)}`;

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
```

Implement or reuse a minimal shell-quoting helper. Although `repo` and `branch` are validated/sanitized trusted values, quoting keeps command construction visibly correct. Do not use `origin`, repository Git config, or a model-provided URL.

- [ ] Keep GitHub Basic authentication in the per-exec environment. A suitable target is:

```ts
return {
	GIT_CONFIG_COUNT: '2',
	GIT_CONFIG_KEY_0: 'http.extraHeader',
	GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
	GIT_CONFIG_KEY_1: 'http.followRedirects',
	GIT_CONFIG_VALUE_1: 'false',
	GIT_TERMINAL_PROMPT: '0',
};
```

The real token still enters this process environment. Do not claim otherwise. Disabling redirects avoids forwarding the authorization header to a redirected destination; if GitHub repository rename redirects are later required, handle that only after trusted-side resolution and a security review. `GIT_TERMINAL_PROMPT=0` prevents an authentication failure from turning into an interactive hang.

- [ ] Never return raw push `stdout` or `stderr` to `runGithubTool`. A hostile executable can print `GIT_CONFIG_VALUE_0`. On non-zero push exit, return a static error such as `git push exited 128`; trusted internal logs must also avoid raw token-bearing process output.
- [ ] `git rev-parse` output may continue to be used because that command receives an empty env and runs before token issuance.
- [ ] Preserve combined error behavior: if checkpoint work fails and revocation also fails, report the sanitized primary error plus `failed to revoke push token`. Never include the token.

Required tests:

1. local SHA mismatch causes no token issuance and no push;
2. investigation causes no token issuance and no sandbox execution;
3. command contains the explicit canonical GitHub URL, deterministic branch, and `--no-verify`;
4. command contains neither `origin` nor token;
5. only the push exec has the Basic header; `rev-parse` has an empty env;
6. push config disables redirects and interactive credential prompting;
7. push failure revokes the token;
8. read-ref failure revokes the token;
9. remote SHA mismatch revokes the token;
10. success revokes the token exactly once;
11. revoke failure is surfaced without exposing the token;
12. a push process that writes the token into stdout/stderr still produces only the static error; and
13. the returned URL points to the canonical repo and deterministic working branch.

- [ ] Run `npx vitest run src/proxy/checkpoint.test.ts`; expect pass.

---

## Task 5: Remove capability setup from model-facing GitHub tools

**Files:**

- Modify: `src/agents/github-tools.ts`
- Modify: `src/agents/github-tools.test.ts`

- [ ] Remove `createPrivateKey`, `createPublicKey`, `CapabilityKeys`, `mintCapability`, `capabilityKeysFromEnv`, and the generic PEM parser used only by capability keys.
- [ ] Change `OwnerProxyCtx` to contain trusted operation context plus execution dependencies:

```ts
export type OwnerProxyCtx = OperationContext & {
	now: number;
	handlers: Record<ProxyOp, ProxyHandler>;
	audit: AuditSink;
};
```

- [ ] Rename `mintAndExecute` to `executeOperation` and call `executeProxy` directly:

```ts
function executeOperation(
	ctx: OwnerProxyCtx,
	op: ProxyOp,
	params: Record<string, unknown>,
): Promise<unknown> {
	return executeAndUnwrap(ctx, op, params);
}
```

- [ ] `executeAndUnwrap` supplies an `OperationContext` assembled from `ctx`; it passes no token or keys.
- [ ] Continue to canonicalize the conversation repo in `liveOwner` before constructing context. Do not add repo to any tool schema.
- [ ] Keep the current deterministic working branch. The model supplies `fromSha`, PR title/body/base, issue number, or checkpoint expected SHA, but never head branch or repo.
- [ ] `liveOwner` must require only `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_INSTALLATION_ID` for GitHub integration setup. Absence of all `CAPABILITY_*` values must not disable tools.
- [ ] Keep mapped public outputs. No tool except the non-model-callable internal vend handler may produce credential-shaped data.
- [ ] Keep `checkpoint_working_branch` as a harness tool calling `harness.sandbox.exec`; pass the same trusted context to checkpoint.

Required tests:

1. read/create/PR calls use the context repo even though inputs contain no repo;
2. tool schemas do not expose repo, branch head, token, permissions, destination URL, or arbitrary headers;
3. working branch remains deterministic from conversation id;
4. tools initialize and run with `CAPABILITY_PRIVATE_KEY`, `CAPABILITY_PUBLIC_KEY`, and `CAPABILITY_KID` absent;
5. missing GitHub App configuration still returns a safe configuration error;
6. normal output mapping remains unchanged; and
7. checkpoint errors never expose the push token.

- [ ] Run `npx vitest run src/agents/github-tools.test.ts`; expect pass.

---

## Task 6: Delete the legacy API in the same migration wave

**Files:**

- Delete: `src/proxy/capabilities.ts`
- Delete: `src/proxy/capabilities.test.ts`
- Inspect all TypeScript and current documentation

- [ ] After all callers compile against `policy.ts`, delete both capability files.
- [ ] Do not keep deprecated aliases or re-exports.
- [ ] Run:

```sh
rg -n "CAPABILITY_|CapabilityClaims|CapabilityKeys|CAPABILITY_TTL_SECONDS|generateCapabilityKeyPair|mintCapability|verifyCapability|Ed25519" src README.md SLACK_AGENT_SPEC.md SLACK_AGENT_HANDOFF.md CONTEXT.md
```

Expected result after Task 7: no matches. Historical ADR 0013 and the old M2 implementation plan may retain historical wording; current source-of-truth documents must not.

- [ ] Run the focused suite:

```sh
npx vitest run \
	src/proxy/policy.test.ts \
	src/proxy/ops.test.ts \
	src/proxy/github.test.ts \
	src/proxy/checkpoint.test.ts \
	src/agents/github-tools.test.ts
```

---

## Task 7: Update source-of-truth documentation and ADR trail

**Files:**

- Modify: `SLACK_AGENT_SPEC.md`
- Modify: `SLACK_AGENT_HANDOFF.md`
- Modify: `CONTEXT.md`
- Modify: `README.md`
- Create: `docs/adr/0016-simplify-github-authorization.md`
- Modify: `docs/adr/README.md`

### `SLACK_AGENT_SPEC.md`

- [ ] Replace D13 with: authorization is deterministic trusted Worker policy, not a signed internal token. Repository and submission type come from trusted conversation context; the model supplies only typed operation parameters.
- [ ] Replace D14 with: no model-callable tool returns a credential or accepts repo/permission/destination fields. `vendPushToken` is internal checkpoint machinery.
- [ ] Replace §4.5’s HTTP-style route groups and Ed25519 verification pipeline with the actual in-process pipeline: validate tool input, attach `OperationContext`, enforce submission policy, run a typed handler, map output, audit.
- [ ] Replace the capability-token section with the three GitHub installation-token profiles: cached read, cached trusted write, fresh sandbox push.
- [ ] Update the secrets table: remove the capability signing keypair; retain GitHub App id/private key/installation id in Worker secrets.
- [ ] Update the layered-defense section with the accurate residual risk. Do not say “reusable credentials never enter the sandbox” without distinguishing the fresh push installation token.
- [ ] Update the checkpoint flow to state explicit trusted GitHub URL, `--no-verify`, redirects disabled, static error handling, SHA confirmation, and revocation.
- [ ] Update milestone/status notes so M2 no longer claims capability mint/verify.

### `SLACK_AGENT_HANDOFF.md`

- [ ] Replace “Capability token contents are set by deterministic code” with the trusted-context invariants above.
- [ ] Link this plan as the implementation handoff.
- [ ] Do not rewrite unrelated current milestone scope.

### `CONTEXT.md`

- [ ] Remove the `Capability Grant` glossary entry.
- [ ] Define `Credential Proxy` accurately as the in-process trusted integration boundary that authorizes named operations and holds the GitHub App credential. Note the bounded checkpoint exception.

### `README.md`

- [ ] Remove `CAPABILITY_PRIVATE_KEY`, `CAPABILITY_PUBLIC_KEY`, and `CAPABILITY_KID` from sample environment configuration.
- [ ] Remove Ed25519 generation instructions and capability/GitHub-key disambiguation.
- [ ] Document the GitHub App’s minimum required application permissions and single-repository installation expectation.
- [ ] State that checkpoint push temporarily injects a fresh repo-scoped token into one sandbox exec and immediately confirms/revokes it.
- [ ] Do not edit or print local `.env` or `.dev.vars` values.

### ADR 0016

- [ ] Record:

  - context: signer and verifier are in one Worker boundary; per-call capability tokens do not constrain a compromised Worker;
  - decision: use direct trusted `OperationContext` policy and in-process typed handlers;
  - decision: cache Worker-only GitHub installation tokens by repo/profile;
  - decision: use a fresh non-cached `contents:write` token for each checkpoint;
  - accepted consequence: bounded sandbox exposure remains;
  - rejected alternative: keep Ed25519 capabilities inside the same Worker;
  - deferred alternative: Daytona Secret substitution after entitlement/permission testing;
  - deferred alternative: external Git credential proxy or privileged publisher only if stricter isolation becomes a requirement.

- [ ] Add ADR 0016 to `docs/adr/README.md` as current. Mark ADR 0013 “partially superseded by ADR 0016”: the goal of keeping reusable credentials outside sandboxes holds, but the Capability Grant mechanism does not.

Do not rewrite historical ADR 0013 or the old dated M2 plan to pretend the earlier decision never existed.

---

## Task 8: Full verification and handoff evidence

- [ ] Run formatting only on files changed by this implementation. Do not format unrelated user work.
- [ ] Run:

```sh
npm run check:types
npm run lint
npm run fmt:check
npm test
npm run build
npm run check:env
```

- [ ] Re-run the residue check:

```sh
rg -n "CAPABILITY_|CapabilityClaims|CapabilityKeys|CAPABILITY_TTL_SECONDS|generateCapabilityKeyPair|mintCapability|verifyCapability|Ed25519" src README.md SLACK_AGENT_SPEC.md SLACK_AGENT_HANDOFF.md CONTEXT.md
```

Expected: no output.

- [ ] Confirm the token-bearing command structurally:

```sh
rg -n "git push|--no-verify|http\.extraHeader|http\.followRedirects|origin" src/proxy/checkpoint.ts src/proxy/checkpoint.test.ts
```

Expected: production push uses an explicit `https://github.com/...` URL, includes `--no-verify`, uses the per-exec Basic header, disables redirects, and does not push to `origin`. Test descriptions may mention `origin` only to assert its absence.

- [ ] Inspect `git diff --check` and `git status --short`. Preserve the user’s pre-existing untracked `.cursor/`, `assets/`, and `tech-backlog.md`; do not add, delete, format, or commit them as part of this implementation.
- [ ] Report exact test/build outcomes and any skipped live checks.
- [ ] Do not claim a live GitHub or Daytona proof unless it was separately authorized and actually run.
- [ ] Do not commit or push unless the implementation request explicitly includes that authorization. If it does, use small migration checkpoints, with final deletion and docs in the same branch before handoff.

## Acceptance criteria

The change is complete only when all of the following are true:

- [ ] No runtime or current setup path reads `CAPABILITY_PRIVATE_KEY`, `CAPABILITY_PUBLIC_KEY`, or `CAPABILITY_KID`.
- [ ] No internal capability token is generated, parsed, signed, verified, or expired.
- [ ] `SubmissionType`, `ProxyOp`, `OPS_BY_SUBMISSION`, `assertOpAllowed`, and `canonicalRepo` remain in a policy-only module.
- [ ] Trusted operation context, not model params, selects the repository and submission type.
- [ ] Investigation writes are still impossible through the operation executor.
- [ ] Read tokens and trusted-side write tokens are cached by repo/profile until the expiry-skew boundary.
- [ ] Each checkpoint receives a fresh, exact-repo, `contents:write` token and revokes it on all post-issuance paths.
- [ ] Checkpoint push ignores mutable `origin`, disables hooks and redirects, and never returns token-bearing process output.
- [ ] Local and remote SHA checks remain mandatory.
- [ ] Model-visible inputs and outputs contain no token, permission set, arbitrary headers, or destination URL.
- [ ] Current docs accurately describe the bounded sandbox exposure and do not claim strict credential isolation.
- [ ] The complete local verification suite passes.

## Deferred Daytona Secrets validation

Do not implement this in the current change. Preserve it as the next security experiment once an organization/API key with the necessary permission is available.

The future experiment must be provider-adapter scoped so switching away from Daytona does not affect GitHub tool policy. Introduce a portable interface only when implementing the experiment, for example:

```ts
type GitPushAuthLease = {
	env: Record<string, string>;
	release(): Promise<void>;
};

type GitPushAuthProvider = {
	acquire(args: { repo: string }): Promise<GitPushAuthLease>;
};
```

The existing direct token env becomes one provider; a future Daytona Secret placeholder becomes another. Do not add this abstraction now because there is only one working implementation.

Required future live checks:

1. obtain a Daytona API key or org role that can list/create/delete secrets;
2. determine whether the earlier 403 was `manage:secrets` scope or plan/tier entitlement;
3. store pre-base64 GitHub Basic credentials as a temporary Daytona Secret restricted to the required GitHub host set;
4. verify the sandbox sees only the opaque placeholder, not the real token;
5. verify Git sends the substituted header to the allowed GitHub host;
6. verify substitution does not occur for a disallowed host;
7. verify response scrubbing and redirect behavior;
8. verify clone/push behavior, hooks, background-process observation, and egress bypass resistance;
9. confirm remote SHA;
10. revoke the GitHub token and delete/reset the Daytona Secret on every path; and
11. repeat after sandbox stop/start and token rotation.

Adopt Daytona Secrets only after these checks pass. If they do not, keep the bounded v1 mechanism or evaluate a provider-neutral privileged publisher; do not jump directly to a custom universal proxy.
