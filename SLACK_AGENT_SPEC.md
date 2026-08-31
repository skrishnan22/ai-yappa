# Standalone Slack Agent — v1 Design Spec

Status: draft for implementation. This supersedes the exploratory working note; alternatives that were considered and rejected live in Appendix A and are not open for re-litigation unless a stated assumption breaks.

## 1. Decisions (fixed for v1)

| # | Decision | Rationale (one line) |
|---|----------|----------------------|
| D1 | Separate repository, application, and infrastructure from Codevil | Clean slate; Codevil contributes lessons only |
| D2 | Sandbox provider: **Daytona container Sandboxes** | Direct Cloudflare-runtime SDK support; stop/start preserves the hydrated filesystem; RAM/process continuity is not required |
| D3 | Control plane: **Cloudflare + Flue** ([flueframework.com](https://flueframework.com/docs/guide/getting-started/)) | Flue agents are addressable with persistent conversations on the Cloudflare runtime — conversation affinity, ownership, and persistence come from the framework |
| D4 | One conversation → one workspace → one working branch → one active submission | Coherent multi-step work; no cross-sandbox synchronization |
| D5 | Agent reasoning loop runs **outside** the sandbox | Sandbox is hands, not brain; no canonical state or credentials inside |
| D6 | Reusable credentials never enter the sandbox; a credential proxy performs trusted operations | The sole exception is a short-lived, repo-scoped GitHub token injected into one push process |
| D7 | v1 trigger: **explicit Slack invocation only** | One full vertical loop with a human present; GitHub issue-comment mention is v2, alert-thread invocation is v3 (§9) |
| D8 | Workspace correctness comes from **git checkpoints**, never provider disk | Sandbox death/expiry is routine, not exceptional |
| D9 | Lost command responses become **Unknown Tool Outcome**, resolved by evidence | Never auto-fail or auto-retry a possibly-succeeded command |
| D10 | No merge, no deploy, no admin cloud credentials, ever | Hard product boundary |
| D11 | Integration tools are **brain-side** via the credential proxy; the sandbox gets only workspace tools | Reading issues/alerts/logs needs no sandbox round-trip; only git push needs a credential-shaped thing inside |
| D12 | Two submission types: **code-change** and **investigation** (read-only capabilities) | Alert-triggered work is investigate-and-report; smaller blast radius, easier to auto-trigger later |
| D13 | Capability tokens are **asymmetric** (Ed25519): owner signs, proxy verifies | A compromised proxy can't mint capabilities; a compromised owner can't exceed proxy policy — neither alone escalates |
| D14 | Capability contents are set by **deterministic code**, never by the model; no LLM-callable tool returns a credential | Prompt injection can request operations, never permissions or secrets |

## 2. Architecture

```text
Slack ──────────────┐
                    ▼
        Cloudflare Worker (ingress)
          - Slack signature verification
          - event → conversation routing
                    │
                    ▼
        Flue Conversation Owner (one per Slack thread)
          - Agent Conversation state (canonical)
          - event log (append-only)
          - submission queue (one active)
          - agent reasoning loop (LLM calls)
          - progress card updates to Slack
          - sandbox lease
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
  Credential Proxy        SandboxAdapter → Daytona
  (Worker, narrow ops)      - create/attach/exec/stream
  - GitHub App tokens       - stop/start/cold-snapshot/delete
  - read issue/repo         - volume (dep cache) mounts
  - create branch/PR
```

The conversation owner is the credential proxy's only caller. It calls the proxy directly for integration tools (read issue, read alert, query logs, create PR) and for the short-lived GitHub token used by a checkpoint push. The sandbox never calls the proxy and never receives a Capability Grant. For a push, deterministic owner code injects the returned repo-scoped token into the environment of that single `git push` process, confirms the remote ref, and revokes the token.

## 3. Domain model

```text
Slack thread (1) ── Agent Conversation (1)
                        │  survives sandbox replacement
                        ├── Execution Workspace (1)   = working branch + checkpoint metadata
                        ├── Sandbox lease (0..1)      = Daytona container id + lifecycle state + fencing token
                        └── Submission (0..1 active)  = one user request being worked
```

Identity and canonical state live in the Flue conversation owner. The Daytona sandbox id is a disposable attribute of the lease, never an Agent Conversation or Execution Workspace identity.

Submissions have a type (D12):

- **code-change**: full workspace, capability set includes branch/PR creation; deliverable is a PR.
- **investigation**: read-only capability set (no `createBranch`/`createPullRequest`, no push token vending); deliverable is a report in the thread. May still use a sandbox for read-only repo inspection.

### Conversation states

`idle → hydrating → working → awaiting_human → checkpointing → idle`, plus `reconciling` (entered on lost command outcome or sandbox loss) and `failed` (terminal for a submission, not the conversation).

## 4. Components and interfaces

### 4.1 Slack ingress (Cloudflare Worker)

- Verifies Slack signatures; drops replays (timestamp window + event id dedup).
- `app_mention` in a channel → create conversation + thread; message in an existing tracked thread → route to that conversation. No slash command (slash commands don't live in threads, which breaks thread-as-identity).
- **Repo resolution**: channel → default repo mapping, configured when the agent is added to a channel; an explicit `repo:` argument in the invocation overrides it. Invocation without a resolvable repo gets an immediate in-thread setup prompt.
- **Invoker allowlist**: only allowlisted Slack users can start submissions; others get a polite refusal. Configured per workspace.
- Responsibilities end at routing; no business logic.

### 4.2 Conversation owner (Flue agent)

The owner is a Flue agent (`'use agent'` function) deployed on the Cloudflare runtime target and reached only through Slack channel dispatch; it has no public `createAgentRouter()` mount. The Flue agent ID **is** the conversation ID (derived from the Slack thread), which gives addressability and persistent conversation state from the framework; the reasoning loop is the Flue agent itself, with proxy operations and sandbox commands exposed as Flue tools. Owns everything listed in D3–D5. Key invariants:

- **One active submission.** New requests while working are queued and acknowledged in-thread ("queued behind current task").
- **Steering vs new submissions.** A thread message during active work is classified as *steering* (correction/context for the current task — injected into the reasoning loop at the next step) or a *new submission* (queued). Classification is done by the reasoning loop itself with a cheap prompt; when ambiguous, treat as steering and say so in-thread.
- **Fenced sandbox lease.** Every lease carries a monotonically increasing fencing token; commands are stamped with it; a superseded sandbox's late responses are discarded.
- **Append-only event log.** Every state transition, command issued, and outcome (including Unknown) is an event. The progress card is a projection of this log.

### 4.3 SandboxAdapter

```ts
interface SandboxAdapter {
  create(spec: SandboxSpec): Promise<SandboxHandle>;      // snapshot/image, cpu/mem/disk, volumes, lifecycle/network policy
  attach(id: SandboxId): Promise<SandboxHandle | null>;   // reconnect after owner restart
  exec(handle, cmd: Command): AsyncStream<ExecEvent>;     // cmd carries commandId + fencing token
  stop(handle): Promise<void>;                            // release compute; preserve container filesystem; clear RAM/processes
  start(id: SandboxId): Promise<SandboxHandle | null>;    // start the same retained container, including from archive
  snapshotFs(handle): Promise<SnapshotId>;
  terminate(handle): Promise<void>;                       // delete provider compute and retained state
}
```

Daytona implementation notes:

- **Runtime class:** use a non-ephemeral Daytona **container** Sandbox for model-written workspace commands. Require `sandboxClass: container`; do not request `linux-vm`. Daytona Linux VM runners are unavailable in the selected deployment and memory pause/resume is not a v1 requirement.
- **Starting size:** 2 vCPU, 4 GiB RAM, and 3 GiB disk. Tune from measured workspace-ready time, build percentiles, OOMs, and cost per completed PR; Daytona bills reserved CPU/RAM while started.
- **Lease lifecycle:** keep the container running for at most 15 idle minutes, then stop it (`autoStopInterval: 15`, `autoPauseInterval: 0`). [Daytona's persistence contract](https://www.daytona.io/docs/en/persistence/) retains the same sandbox id, filesystem, installed packages, repository, uncommitted files, and build artifacts across stop/start, but clears RAM and kills every process. A stopped container consumes disk quota until Daytona archives it; use the provider's seven-day auto-archive default unless the product cleanup policy chooses a shorter interval. Starting an archived container restores its filesystem. Disable auto-delete and delete only when cleanup releases the lease or recovery proves the provider state unusable.
- **Process continuity:** no state machine, command outcome, or recovery rule may depend on a process surviving idle. A later invocation relaunches any required dev server, watcher, shell, or other background process explicitly. Never stop a sandbox while an `exec` is active.
- **Dependency caches:** the retained container filesystem is the first-line cache for `node_modules`, package-manager stores, and build outputs. A Daytona Volume or prebuilt Snapshot may later provide cross-sandbox cache reuse, keyed by cache fingerprint (lockfile hash + runtime version + PM version + OS + arch). Neither is recovery truth.
- **Snapshots:** a prebuilt container Snapshot may define the base toolchain, and a cold filesystem snapshot may accelerate replacement hydration. Container snapshots do not preserve memory. Hot snapshots, forks, and pause/resume are outside v1.
- **Network:** production sandbox creation is fail-closed and receives a deterministic, versioned Daytona domain allowlist for the required git remotes and package registries. The model cannot change it. The sandbox does not need access to the Credential Proxy. Private-repository production requires Daytona Tier 3/4 custom policy support or an equivalent organization policy confirmed by Daytona.
- **Isolation boundary:** Daytona containers use container isolation, not a microVM. M1 is an internal controlled pilot. Before production use with private repositories or adversarial inputs, validate Daytona's isolation and organization policy against the threat model; if it is insufficient, revisit a gVisor/microVM provider without changing the adapter or recovery invariants.
- **Provider secret:** `DAYTONA_API_KEY` remains in the trusted conversation owner/SandboxAdapter and is never injected into the sandbox.

### 4.4 Command protocol (Unknown Tool Outcome)

Every command carries a client-generated `commandId`. Inside the sandbox, a thin runner wraps execution:

1. Write `commandId.started` marker; run command; capture exit code + output digest; write `commandId.done` with the result.
2. Stream output to the owner; owner persists terminal outcome to the event log.

If the stream dies before a terminal outcome arrives, the owner records **Unknown Tool Outcome** and enters `reconciling`:

- If the sandbox is reachable: read the `commandId.done` marker → resolve to the real outcome.
- If the sandbox is gone: v1 reconciles from **git-observable evidence only** — `git status`/HEAD of the last checkpoint, and remote branch state via the proxy. Anything not provable is reported to the human in-thread with the evidence, and the agent proposes (never assumes) a retry.

### 4.5 Credential proxy (Cloudflare Worker)

The proxy is the only component holding real **integration** credentials: the GitHub App private key, a read-only Cloudflare API token, and (later) read-only AWS credentials. The full secret inventory, trust-zone model, and end-to-end flows are in §5; this section defines the component's surface.

**Internal pipeline.** One Worker, four route groups (`/github/*`, `/cf/*`, `/aws/*`, `/capabilities/vend-push-token`), shared middleware:

1. **Verify** capability token: Ed25519 signature (D13), expiry ≤ 10 min, `conversationId`/`submissionId` present.
2. **Authorize**: op ∈ `allowedOps` and op class permitted for `submissionType` (investigation tokens structurally lack all write ops).
3. **Validate params** against a per-op schema — no caller-shaped upstream requests except the gated read-only passthroughs.
4. **Execute** with the real credential.
5. **Audit + limit**: append `{ts, conversationId, submissionId, op, paramsDigest, outcome, latency}` to the conversation event log **and** to a flat cross-conversation audit store (D1 table; enables "every write op across all conversations last week" queries); enforce per-conversation rate limits and concurrency caps.

The owner mints a fresh single-purpose capability token per proxy call (local signature, cheap); the 10-minute window is clock-skew slack, not a reuse budget.

**Tool access model (D11).** Tools split by where they run:

- **Brain-side tools** — typed operations the reasoning loop calls on the proxy directly. The sandbox is not involved; real credentials never leave the proxy. This covers all reads and all trusted writes.
- **Sandbox-side tools** — shell, filesystem, git, package managers. The only credential-shaped thing ever inside the sandbox is a proxy-vended GitHub App installation token (≤ 1 h, repo-scoped) for `git push`/`gh` against the working repo. `wrangler`/`aws` CLIs may exist in the image for unauthenticated local use (e.g. `wrangler dev`) but are **never** given credentials; infra reads happen brain-side.

**v1 operation surface** (GitHub App, least-privilege installation scopes):

- `readIssue(repo, number)` / `readRepoMetadata(repo)`
- `createBranch(repo, name, fromSha)` / `createPullRequest(repo, head, base, title, body)`
- `vendPushToken(repo)` → installation token for the sandbox (code-change submissions only)

**v3 additions for investigations** (read-only, no write analog exists):

- `cfRead(pathPrefix-allowlisted GET)` — read-only passthrough to the Cloudflare API: method locked to GET, host fixed, path validated against an allowlist of prefixes (alerts, analytics, Workers logs). This is deliberately more generic than the GitHub surface because investigation queries can't be fully enumerated up front; it stays principled by being **read-only + allowlisted-path + audited**, which is categorically different from an arbitrary authenticated proxy.
- `awsRead(service, operation, params)` — same pattern via SigV4 signing from the Worker, IAM policy restricted to `Describe*/Get*/List*` on the relevant services.

**Capability tokens.** Claims: `{conversationId, submissionId, submissionType, repo, allowedOps, exp ≤ 10 min}`, signed by the owner's Ed25519 private key; the proxy holds only the verify key (D13). The trigger type determines the submission type, and the submission type determines `allowedOps`, via a static table in the owner (D14) — the LLM requests operations, never permissions. Investigation tokens can never carry `createBranch`/`createPullRequest`/`vendPushToken`.

**GitHub token mechanics.** The proxy signs a short-lived App JWT and exchanges it for installation tokens **scoped at creation**: repository list narrowed to the working repo, permissions narrowed to `contents: write` + `pull_requests: write` (read-only variants for investigation clones). Installation tokens cannot be branch-scoped, so compensating controls are: branch protection on default branches of enrolled repos, and the App simply lacking admin/workflow permissions. Tokens for brain-side reads are cached per installation until ~5 min before their 1 h expiry; push tokens are minted fresh and **revoked** (`DELETE /installation/token`) as soon as the checkpoint is confirmed.

**Read-only passthrough gates.** `cfRead`: account id pinned server-side, method locked to GET, path checked against an allowlist of prefixes, responses size-capped. `awsRead`: SigV4 via `aws4fetch` against an IAM principal restricted to `Describe*/Get*/List*` on enumerated services — both the proxy allowlist and IAM would have to be wrong to permit a write.

**Growth rule.** The op surface may only grow with typed, individually-reviewed operations. The read-only passthroughs are the single sanctioned exception, and only because GET + pinned-host + path-allowlist + audit is mechanically enforceable. Explicitly rejected: any endpoint that forwards caller-constructed requests with write methods or to caller-chosen hosts.

### 4.6 Slack surface

- One progress card per submission (single message, edited in place): state, current step, elapsed, links to branch/PR when they exist.
- Clarifying questions and approvals are plain thread messages with the agent explicitly `awaiting_human`.
- Terminal outcomes always posted: PR link on success; on failure, what was tried and the evidence.

## 5. Secrets, trust zones, and credential flows

### 5.1 Secret inventory

Each real credential lives in exactly one place:

| Secret | Lives in | Used for |
|---|---|---|
| GitHub App private key | Credential proxy | Minting installation tokens |
| Cloudflare read-only API token | Credential proxy | `cfRead` passthrough |
| AWS read-only keys (SigV4) | Credential proxy | `awsRead` |
| Slack signing secret | Ingress worker | Verifying inbound events |
| Slack bot token | Conversation owner | Posting cards/messages |
| LLM API keys | Conversation owner (behind AI Gateway) | Reasoning loop |
| Daytona API key | Conversation owner (SandboxAdapter) | Sandbox lifecycle |
| Capability signing keypair | Private: owner; public: proxy | Capability tokens (D13) |

The proxy holds only *integration* credentials — those an agent decision could abuse against external systems. Slack, Daytona, and LLM keys stay in the control plane because trusted code uses them on its own behalf. All are stored as Worker secrets; the capability keypair rotates via a `kid` header.

### 5.2 Trust zones and threat model

Three zones:

1. **Trusted control plane** — ingress, conversation owner, proxy, adapter. Holds real secrets. Runs only reviewed code.
2. **Capability tokens in flight** — short-lived, single-purpose, unforgeable, non-escalating.
3. **Untrusted** — the sandbox, repo contents, and **all LLM inputs and outputs**.

The load-bearing observation: **the brain is trusted code making untrusted decisions.** Everything the reasoning loop reads — repo contents, issue text, alert payloads, command output — is attacker-influenceable, so prompt injection can make the brain *want* to call any tool it has. This is why brain-side tools still go through the proxy instead of the owner holding integration keys directly: the proxy is a policy boundary that holds even when the LLM is fully hijacked, because `allowedOps`/`submissionType` come from deterministic code (D14), never from the model.

**Worst-case blast radius** (reasoning loop fully hijacked by malicious content): it can read what the submission already allowed, push commits to the working branch, open a visible PR, post messages to its own Slack thread, and burn tokens up to the budget cap. It cannot merge, deploy, touch other repos, write to any infrastructure, mint capabilities, or obtain any credential outliving the hour. Every capability it does have is human-reviewed downstream (PR review) or human-visible (Slack). The design exists to keep this paragraph true.

### 5.3 End-to-end flows

**Brain-side read (any submission type).** Loop needs an issue → owner mints `{op: readIssue, repo, exp: +10m}` → proxy verifies/authorizes → cached installation token → GitHub API → typed JSON back into the loop → audit event. Sandbox uninvolved; no credential moved.

**Sandbox checkpoint push (code-change only).** Brain decides to checkpoint → owner (deterministic checkpoint code — `vendPushToken` is not an LLM-callable tool, per D14) requests a push token → proxy mints a fresh installation token (one repo, `contents: write`) → owner injects it into the **per-exec environment of the single `git push` command** — never the sandbox's ambient env, never a file → push lands on the working branch → owner confirms the remote ref via a proxy read → proxy revokes the token. Effective exposure is seconds-to-minutes, not the nominal hour. Defense in depth: the sandbox egress allowlist (proxy, `github.com`, package registries only) leaves an exfiltrated token almost nowhere to be sent from, and default branches of enrolled repos are protected.

**Investigation read (v3).** Alert thread → investigation submission → every capability carries `submissionType: investigation`, so write ops are unmintable and `vendPushToken` refuses — a compromised investigation cannot even push code. Brain calls `cfRead`/`awsRead`, reasons, posts the report. If repo inspection is needed, a sandbox hydrates via a `contents: read` clone token; no push vending exists for this type.

**LLM calls.** The loop runs in the conversation owner (D5), so LLM keys never approach the sandbox — agents that run their loop inside a sandbox must build an LLM proxy to get this property; we get it free. Flue is built on Pi and supports its providers; the Cloudflare runtime additionally offers a built-in `cloudflare/*` AI gateway needing no API keys. Either way, route through **Cloudflare AI Gateway** semantics: budgets, logging, caching, retries, key rotation. Per-conversation token budget enforced in the owner (a hijacked or looping agent burns a bounded amount before `awaiting_human`); global monthly cap at the gateway.

**Slack posting.** The bot token stays in the owner; the model's tool is `postToThread`, pinned to the conversation's own thread. The LLM never chooses a channel, so hijacked output cannot DM the workspace.

## 6. Repository setup and hydration

v1: **lockfile detection only** (`pnpm-lock.yaml` → frozen pnpm, `package-lock.json` → `npm ci`, `yarn.lock` → immutable, `bun.lock` → frozen). No `.agent/setup.sh`, no seed images — those are v2, adopted when a real repo needs them. One shared toolchain base image (git, Node via corepack, npm/pnpm/yarn/bun, build-essential, common native-module deps).

Hydration runs only for a new or replacement lease: create container → optionally mount a dep-cache volume → shallow-clone repo at working-branch tip (or default branch for a fresh workspace) → lockfile install → mark `workspace_ready` in the event log with timing metrics. A retained stopped or archived container instead starts with its existing filesystem and skips clone/install after verifying its `workspace_ready` marker and Workspace Fingerprint.

## 7. Checkpoint and recovery

- Checkpoint = commit all work to the working branch and push via proxy token. Taken: after each meaningful edit batch, before any risky/long command, on `awaiting_human`, and on graceful idle.
- Healthy running sandbox → attach to the same Daytona sandbox id and retain the existing fencing token.
- Healthy stopped or archived sandbox → start the same Daytona sandbox id, verify the lease, and retain the existing fencing token. Files remain; processes do not. Relaunch only the processes required by the next command.
- Sandbox loss (deletion, failed start, or Daytona incident) → owner marks the lease dead, bumps the fencing token, creates a replacement, and rehydrates from the working branch; it replays nothing because the event log records the durable progress.
- Daytona container filesystem persistence and cold snapshots are optional accelerators for fast continuation; they are never correctness dependencies (D8).
- Before stopping, snapshotting, or releasing a lease, no command may remain active. The owner confirms or reconciles any push, revokes its token, creates the required Code Checkpoint, and only then transitions the sandbox lifecycle.

## 8. Out of scope for v1

GitHub triggers, alert triggers, the filter/dedup agent, `.agent/setup.sh`, repository seed images, multi-repo conversations, process-preserving pause/resume, Daytona hot snapshots/forks, and any Gondolin/EC2/Fargate work. Each has a defined slot (§9 or v2+) and none blocks the vertical slice.

## 9. Trigger roadmap

All triggers are thin adapters emitting the same `TriggerEvent {source, repo?, humans, initialContext, submissionType}` into the one conversation-creation path. No generic webhook framework; three concrete adapters is the ceiling.

- **v1 — Slack mention** (§4.1). Interactive; default submission type code-change.
- **v2 — GitHub issue-comment mention.** `@agent` mentioned in an issue comment (chosen over labels: same explicit-intent property, and the comment carries the task description; labels carry only "go"). Conversation identity anchors to the **issue id** — repeat mentions in the same issue route to the existing conversation instead of spawning siblings. Guards: commenter must be an allowlisted human (never bots); GitHub→Slack identity map (static config) so the created Slack thread mentions the requester. Slack stays the canonical conversation surface; only terminal outcomes (started / PR link / failed) are mirrored to the issue.
- **v3 — Alert-thread invocation.** No alert webhook ingress. Alerts already land in Slack via existing alerting integrations; a human invokes the agent on the alert message ("@agent investigate this"), which is the v1 trigger pointed at an alert thread with `submissionType: investigation`. The agent reads the alert thread content as initial context and uses brain-side `cfRead`/`awsRead` for evidence. The "filter agent" is initially the human deciding which alerts merit investigation.
- **v3.5 — Auto-invocation.** After observing which alert types humans consistently forward: auto-invoke on those specific fingerprints, deduped by alert fingerprint, with a rate budget (max N auto-conversations/hour) so a storm cannot fan out into N sandboxes. Direct Cloudflare/AWS webhook ingress is built only if Slack-routed alerts prove insufficient.

## 10. Milestones

1. **M1 — Skeleton loop.** Slack mention → conversation owner → Daytona container → write a filesystem sentinel → stop/start the same container once and verify the sentinel → run `git clone` + `ls` → reply in thread. Proves ingress, Flue ownership, adapter, streaming, and filesystem persistence without relying on RAM/process continuity.
2. **M2 — Trusted integrations.** Credential proxy with the four operations; capability minting; branch push from sandbox via vended token.
3. **M3 — Real work.** Reasoning loop drives inspect → edit → install → test → checkpoint → PR on one pilot repo; progress card live.
4. **M4 — Failure and security hardening.** Kill sandboxes mid-command in tests; verify Unknown Tool Outcome, fencing, and rehydration behave per §4.4/§7. Adversarial proxy tests: investigation token attempting a write, expired token, cross-conversation token, `cfRead` path outside the allowlist — all must refuse and audit. Measure time-to-workspace-ready and cost per completed PR from real usage (this replaces the provider bakeoff).

## 11. Open questions (must be answered during M1–M2, none block starting)

- Pilot repository choice and its GitHub App installation scope.
- Daytona region selection and measured create/start latency from the deployed Cloudflare runtime.
- Confirmation that Daytona container Sandboxes are available at the selected region, tier, and resource shape. (2026-08-30: this account rejects 20 GiB disk, max 10 GiB per sandbox; M1 starts at 3 GiB.)
- Daytona paid-credit expiration/refund terms and whether a custom organization egress policy can be applied below Tier 3.
- The smallest deterministic domain allowlist that hydrates and builds the pilot repository.
- Agent Conversation retention and the corresponding stopped/archive/delete policy for retained container filesystems.
- Event-log retention and what, if anything, is surfaced for audit.
- Steering-vs-new-submission classifier prompt shape (and whether ambiguous cases need a human confirm).
- `cfRead` path-prefix allowlist contents when v3 lands (which Cloudflare API surfaces investigations actually need).
- How much of the append-only event log (§4.2) maps onto Flue's built-in conversation persistence vs. a custom store — resolve by reading Flue's persistence docs during M1, preferring the framework's primitives where they fit.
- Whether Flue's own tools/skills/sandboxes abstractions replace parts of the `SandboxAdapter` (§4.3) or Daytona stays behind our adapter — same M1 investigation; the adapter interface is the contract either way.

### M1 layout (2026-08-30)

The original M1 layout used the Flue Modal blueprint. On 2026-08-30 D2 first changed to Daytona Linux VMs, then to Daytona containers after the selected Daytona region reported no `linux-vm` runners and the UI reported that the VM snapshot was unavailable in every selectable region. The second change also corrected the architecture: Flue owns logical continuity, Git owns recovery truth, and the useful provider optimization is retained filesystem state. RAM/process continuity is optional and therefore cannot justify a VM or Modal's Alpha snapshot/restore path in v1.

- Follow Flue's project layout. Do not introduce `packages/{ingress,owner,proxy,sandbox-runner}`.
- Ingress is `@flue/slack` in `src/channels/slack.ts`, mounted at `/channels/slack`. Signature verification, replay window, and URL handshake stay in the channel package. Policy (invoker allowlist, channel→repo map) is application code in the handler, before `dispatch`.
- The conversation owner is `src/agents/coworker.ts`. It is dispatch-only: no public `createAgentRouter` mount. Conversation id is `channel.instanceId({ teamId, channelId, threadTs })`.
- Event log for M1 is Flue conversation persistence plus `initialData`. Lease/fencing metadata goes in `usePersistentState` when that protocol lands. A custom cross-conversation audit store waits for M2/M4.
- Implement Daytona behind Flue's `SandboxFactory` in `src/sandboxes/daytona.ts`. Spec §4.3 lifecycle operations remain application-owned around that factory. Spec §4.4 `commandId` markers are still ours; provider command/session ids strengthen reconciliation but do not replace the client-generated id.
- The Modal prototype is gone. Rework `src/agents/coworker.ts` and `src/sandboxes/daytona.ts` to create a Daytona container, then wrap it with the Flue factory. Prove stop/start filesystem persistence in `verifyContainerStopStartPersistence` unit tests, not on the Coworker create path. Do not call `pause`, request `linux-vm`, or add a Cloudflare Container gRPC bridge.
- Unmentioned thread messages continue a conversation only when `getAgentInstance(Coworker, id)` finds one. A mention may create. (2026-08-30)
- Do not use Cloudflare Sandbox or Cloudflare Computer for workspace exec.
- Credential proxy is still M2. Not in this tree yet.

## Appendix A — Rejected alternatives (recorded, closed)

- **Modal direct from the Durable Object**: rejected because the JavaScript SDK uses Node gRPC over HTTP/2, which the Cloudflare Worker/Durable Object runtime cannot execute even though the bundle builds.
- **Modal through a Cloudflare Container bridge**: technically viable and offers a stronger documented gVisor isolation boundary, but adds a permanent create/exec/stream/reconnect hop. Modal's non-VM memory snapshots are Alpha snapshot/terminate/restore into a new sandbox, with process and network limitations; they are not ordinary pause/resume, and v1 does not require RAM continuity. The bridge is not justified for v1.
- **Daytona Linux VM Sandboxes**: rejected for v1 because no `linux-vm` runner is configured in the selected region and the snapshot is unavailable in every selectable UI region. Even if availability changes, VM pause/resume is an optional performance feature rather than a correctness requirement; benchmark it later only if deterministic process relaunch becomes a measured bottleneck.
- **Fargate / AgentCore / E2B / Gondolin-on-EC2**: managed or self-hosted alternatives add cost, operational surface, or a plan floor without beating Daytona's direct control plus persistent workspace lifecycle for this workload. Revisit only on a hard data-residency requirement, a Daytona contract failure, or materially different scale.
- **Modal + Fargate command routing**: rejected; splits the workspace and creates checkpoint/sync/artifact-transfer complexity (violates D4).
- **CI-failure triggers in v1**: rejected as noisy and overlapping with PR-babysitter tooling.
- **GitHub label trigger**: superseded by issue-comment mention (§9); a label carries no task description and is frequently bot-applied.
- **Alert webhook ingress (Cloudflare/AWS → control plane)**: superseded by Slack-routed alert invocation (§9); direct ingress requires the filter/dedup agent as a prerequisite and reintroduces noisy automation.
- **Authenticated `wrangler`/`aws` CLIs inside the sandbox**: rejected; infra reads are brain-side proxy operations (D11). CLI tokens in an agent-controlled environment are exfiltratable for their full lifetime and Cloudflare/AWS tokens cannot be scoped as tightly as a repo-scoped 1 h GitHub installation token.
- **Every-event filter agent**: deferred; requires session/alert introspection that doesn't exist yet.
