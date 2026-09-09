# Handoff: Workspace hydration + instruction-based Coworker

You are continuing **ai-yappa** (`slack-agent`). Implementation source of truth: `SLACK_AGENT_SPEC.md`. Glossary: `CONTEXT.md`. M1 handoff (done): `SLACK_AGENT_HANDOFF.md`. Layout and commands: `AGENTS.md`.

**Read the entire spec before writing any code**, especially D4–D6, D8, D10–D14, §4.3 snapshots, **§6 hydration**, §7, §8, §10. This file only orients you and defines **this** slice. If an invariant must break to proceed, stop and ask the human — do not decide unilaterally.

## Current state (do not re-litigate)

- **M1 is live.** Slack `@mention` in a mapped channel creates a Coworker (thread-keyed Flue agent), creates a Daytona **container**, and the model is prompted to shallow-clone + `ls` and reply in-thread. Unmentioned replies continue only if `getAgentInstance` finds that Coworker. Channel→repo and invoker allowlist: `src/config.ts`. Pilot repo: `https://github.com/skrishnan22/codevil.git` (`pnpm-lock.yaml` monorepo).
- **M2 (credential proxy) is a stacked PR** (`m2-credential-proxy` → `m1-skeleton`): in-process proxy, GitHub App installation tokens, `vendPushToken` + checkpoint push, Flue GitHub tools. **Not required to start hydration for a public clone.** Private clone and checkpoint/PR need M2 landed. Prefer branching this work **from `m2-credential-proxy`** if that branch exists locally/remotely so the later PR loop is one stack; if you only have `m1-skeleton`/`main`, public HTTPS clone is enough for this slice.
- Daytona snapshot today (`src/sandboxes/daytona.ts` `containerImage()`): `node:22-bookworm` + `git` + `/workspace`. Create path does **not** clone or install. Stop/start filesystem persistence is a unit test (`verifyContainerStopStartPersistence`), not part of every create.
- Coworker prompt (`src/agents/coworker.ts`) still says: first mention → clone + `ls`. That is why GitHub tools cannot be meaningfully tested as “do the task.”
- `.env` / `.dev.vars` are gitignored. Do not commit secrets. Do not echo secrets into logs or chat.

## Why this slice exists

M2 GitHub ops are unused while the agent’s job is clone/`ls`. A Daytona snapshot that already contains `codevil` + `node_modules` is **v2 seed images** (spec §6 / §8) — **do not build that.** v1 hydration is trusted owner code on a **new or replacement** lease: toolchain snapshot → clone → lockfile install → `workspace_ready`. Resume of the same container skips clone/install when the marker (and fingerprint, if you add one) still match.

## Non-negotiable (same as M1)

- One Slack thread → one conversation → one workspace → one working branch → one active submission (D4).
- Reasoning loop stays in the Flue agent, not in the sandbox (D5).
- Reusable GitHub credentials never enter the sandbox. Clone for **private** repos uses a short-lived installation token in **that clone process only** (same shape as push: env of one command, then done). Public `codevil` may clone without a token.
- Do not merge or deploy (D10). Do not add `cfRead` / `awsRead`, commandId/fencing, live run cards, seed images, `.agent/setup.sh`, or a second Worker/package split.
- Follow existing `src/channels`, `src/agents`, `src/sandboxes` layout. No new npm dependency if stdlib / existing Daytona exec / Flue sandbox `exec` will do.
- Lazy senior / ponytail: reuse Daytona driver `exec`; do not invent a second sandbox stack. Fewest files. Tests colocated.

## Your milestone

**Hydrate the sandbox in application code, then make Coworker instruction-based:** the Slack message is the task; the workspace is already cloned and dependencies installed.

Happy path:

1. Coworker `useSandbox` create (or a helper it calls) creates the container as today.
2. **Owner code** (not the model) hydrates `/workspace`:
   - Widen the **toolchain** snapshot (new snapshot name; do not silently mutate `slack-agent-container-v1` in a way that breaks running M1 sandboxes). Image must support the pilot lockfile: git, Node 22, **corepack + pnpm**, and enough OS packages to install `codevil` (build-essential / common native-module deps as needed). Measure; do not boil the ocean.
   - Shallow-clone `initialData.repo` into a stable directory (recommend `/workspace/repo` or `/workspace/<name>` — pick one, document it, use it in the prompt). Checkout default branch for a fresh workspace (working-branch tip only when a working branch already exists — if you have no lease/branch state yet, default branch is correct).
   - Detect lockfile at repo root only (v1): `pnpm-lock.yaml` → frozen pnpm; `package-lock.json` → `npm ci`; `yarn.lock` → immutable; `bun.lock` → frozen bun. Pilot is pnpm.
   - `git config` in that repo so later commits show the GitHub App bot (not `root`):
     - `user.name` = `{app-slug}[bot]` (e.g. `ai-yappa[bot]` if that is the App slug)
     - `user.email` = `{bot-user-id}+{app-slug}[bot]@users.noreply.github.com`
     - `bot-user-id` is `GET /users/{slug}[bot]` (`.id`), **not** the GitHub App ID. If env `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` (or `GITHUB_APP_SLUG` + looked-up id) is missing, fail closed in tests with injected config; in prod, skip bot identity only if the human has not provided it — do not guess `root`.
   - Optional but in-scope if cheap: create the working branch `agent/<sanitized-conversationId>` from the clone SHA (D4). Do not let the model choose the branch name.
   - Write a `workspace_ready` marker (path + contents you define; include repo canonical name + lockfile hash if you fingerprint). Timing metrics: log or return duration; a custom D1 audit store is **not** this slice.
3. Hand the sandbox to Flue with `cwd` at the **cloned repo root** (not empty `/workspace`), so `read`/`edit`/`bash` land in the project.
4. **Replace** the clone/`ls` first-turn prompt. Instruct the agent to: treat the Slack text as the request; the repo is already present and installed; inspect/edit/test with sandbox tools; do not merge or deploy; do not pick another Slack channel/thread; reply with `reply_in_slack_thread`. If M2 tools are on the branch, say: GitHub reads/PRs/checkpoint go through those tools; never `git push` with a token. If M2 is absent, do not invent GitHub tools.
5. Resume: if you persist Daytona sandbox id per conversation in this slice, start the same container and skip clone/install when `workspace_ready` is valid. If you do **not** persist lease id yet, every new Coworker create hydrates from scratch — that is acceptable; do not build full §7 recovery. Note the choice in a dated spec §11 / §6 note.

Private clone (only if M2 is on the branch): mint a clone token the same way as push (repo-scoped, not returned to the model), inject into **one** `git clone` env, do not leave it in ambient sandbox env.

## Acceptance

1. Unit tests (fake Daytona / fake `exec`): hydration runs clone + the matching frozen install; `cwd` is the repo root; marker written. A second hydrate on a filesystem that already has a valid marker does **not** clone/install again.
2. Lockfile detection is tested for at least pnpm (pilot) and one other (e.g. npm) so the table is real.
3. Snapshot/image includes pnpm/corepack (assert the dockerfile/image commands or the snapshot name + image spec you pass to Daytona).
4. Coworker instructions no longer tell the model to clone or `ls` as the first-turn job. They name the workspace path and say the Slack body is the task.
5. `README.md` says: create hydrates; stop/start keeps the filesystem (deps survive); the model does not bootstrap the repo.
6. Dated note under spec §6 or §11: hydration is owner-side; seed images still v2; snapshot name if you bumped it.

Live (if `DAYTONA_API_KEY` is available; do not claim it passed if you did not run it): mention with a **real task** (not “clone and ls”). Thread reply should reflect work in the already-cloned `codevil` tree (e.g. reading `package.json` / proposing an edit). Public clone without GitHub App is enough for this check.

## Explicitly not in this slice

- Live run card, submission queue, steering classifier (keep stub: mid-work messages are steering).
- Making checkpoint/PR work end-to-end (M2 + this hydrate; finishing the PR loop is a follow-on unless it falls out of existing M2 tools with no extra design).
- `commandId` / fencing / Unknown Tool Outcome (M4).
- Seed images, dep-cache volumes, `.agent/setup.sh`.
- `cfRead` / `awsRead`, HTTP proxy split, D1 audit table.

## Tests and style

- TDD for hydration helpers: failing test first, then code. Colocate `*.test.ts`. Inject `exec` / fs; do not hit live Daytona in unit tests.
- One small runnable check for lockfile → install command mapping.
- `npm test` and `npm run check:types` green.
- Do not commit `.env`, `.dev.vars`, `*.pem`, or `node_modules`.
- Do not commit unless the human asks.

## Working rules

- Keep the spec updated with a dated note when you choose snapshot name, clone path, marker path, or skip-on-resume behavior.
- Prefer Flue `harness.sandbox.exec` / Daytona `process.executeCommand` already wrapped in `src/sandboxes/daytona.ts`.
- If Flue or Daytona docs contradict spec **mechanics**, flag it with a proposed spec amendment. Invariants stay fixed.
