# Handoff: Build the Standalone Slack Agent (start at Milestone M1)

You are starting implementation of a new product: a Slack-native engineering coworker that investigates repositories, makes code changes, and opens pull requests — never merging or deploying. The complete design is in `SLACK_AGENT_SPEC.md`, which sits next to this file. **Read the entire spec before writing any code.** It is the source of truth; this handoff only orients you and defines your first milestone.

## Non-negotiable design invariants (from the spec's decision table)

- This is a **new, separate repository** — do not import code from, depend on, or modify the Codevil codebase, even if you can see it.
- One Slack thread → one Agent Conversation → one workspace → one working branch → one active submission (D4).
- The reasoning loop runs in the control plane (a Flue agent), never inside the sandbox (D5).
- No reusable credential ever enters the sandbox. The sole exception is a short-lived, repo-scoped GitHub installation token injected into one `git push` process (D6, D11, §5.3).
- Workspace correctness comes from git checkpoints, never provider disk (D8).
- A lost command response is an `Unknown Tool Outcome`, resolved by evidence — never auto-failed or auto-retried (D9).
- The agent can never merge or deploy (D10).
- Capability token contents are set by deterministic code, never by the model; no LLM-callable tool returns a credential (D13, D14).

If you believe an invariant must be broken to make progress, stop and ask the human in this conversation — do not decide unilaterally.

## Stack

- **Flue** (https://flueframework.com/docs/guide/getting-started/) on the **Cloudflare runtime target** for the control plane. The conversation owner is a dispatch-only Flue agent whose agent ID is derived from the Slack thread; it has no public `createAgentRouter()` mount. Flue provides addressable, persistent conversations and the LLM loop (built on Pi; a built-in `cloudflare/*` AI gateway is available). Read Flue's guides on agents, tools/skills/sandboxes, channels, and Cloudflare deployment before designing modules — spec §11 lists two open questions about how far Flue's built-ins replace custom pieces (event log storage, sandbox integration); investigate and decide these early, preferring framework primitives where they genuinely fit.
- **Daytona container Sandboxes** for execution (TypeScript SDK), created by application code and wrapped with Flue's `SandboxFactory`. Stop/start preserves the filesystem but clears RAM and processes; process continuity is not a requirement. The spec §4.3 `SandboxAdapter` type is not implemented in M1.
- **TypeScript** throughout. Follow the existing `src/channels`, `src/agents`, and `src/sandboxes` layout; do not introduce a package split for M1.

## Environment (provided by the human — ask if any are missing)

- New repository: `<REPO_URL>`
- Slack app: signing secret + bot token (scopes: `app_mentions:read`, `chat:write`, channel history) as Worker secrets.
- GitHub App: app ID + private key, installed on the pilot repo `<PILOT_REPO>` with `contents` + `pull_requests` read/write, `issues` + `metadata` read.
- Daytona: API key.
- LLM: provider API key(s), or use the Flue Cloudflare AI gateway.
- Cloudflare: account for this stack (separate from any existing product), wrangler access.

Store all of these as secrets (wrangler secrets / `.env` locally); never commit them, never echo them into logs.

## Your milestone: M1 — Skeleton loop (spec §10)

Slack `@mention` in a channel → ingress worker verifies the Slack signature and routes to a Flue conversation owner keyed by the thread → owner creates a Daytona container Sandbox and wraps it with the Flue factory → model clones (public repo) and `ls` via sandbox tools → replies in the Slack thread. Filesystem sentinel stop/start is a unit test (`verifyContainerStopStartPersistence`), not part of every conversation create. `commandId` / fencing / Unknown Tool Outcome wait for M4.

M1 acceptance:

1. Mentioning the agent in a mapped channel produces a threaded reply containing real output from inside the sandbox.
2. A second message in the same thread reaches the **same** conversation (same Flue agent ID). Unmentioned replies in a thread the bot never joined are dropped (`getAgentInstance` is null).
3. The Daytona sandbox class is `container`; creation sets a 15-minute auto-stop, disables auto-pause and auto-delete, and does not make the sandbox ephemeral. No test or production path calls `pause()`. Stop/start filesystem survival is asserted in `src/sandboxes/daytona.test.ts`.
4. Deferred to M4: command results carry `commandId` and fencing token; kill the sandbox mid-command and record `Unknown Tool Outcome` rather than a failure.
5. The channel→repo mapping and invoker allowlist exist as config (hardcoded config file is fine for M1).
6. `README.md` documents local dev (`vite dev` + tunnel for Slack events), deployment, and the container lifecycle.

Explicitly **not** in M1: the credential proxy (M2), real code edits and PRs (M3), steering-vs-queue classification (stub: treat every mid-work message as steering context), investigations, GitHub/alert triggers, commandId/fencing protocol (M4).

## Working rules

- Work milestone by milestone; do not start M2 without human sign-off on M1.
- Keep the spec updated as you make decisions the spec left open (§11) — append a dated note under the relevant section rather than silently diverging.
- Write tests alongside admission policy (allowlist, channel→repo, mention creates vs untracked drop). Signature verification stays in `@flue/slack`. Tests for `commandId`/fencing wait until that protocol lands (M4).
- When Flue or Daytona documentation contradicts an assumption in the spec, flag it in your summary with a proposed spec amendment; the spec's *invariants* are fixed, but its *mechanics* are amendable with evidence.
