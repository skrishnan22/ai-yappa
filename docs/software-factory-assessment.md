# Software Factory Assessment

Date: 2026-09-28

## Verdict

**Not yet.** This repository is a strong **software-factory cell**: a Slack-native engineering coworker that can take a human request, hydrate a repository, use a model to inspect and edit it, run commands, checkpoint a working branch, and open a pull request.

A software factory is more than an agent that can produce a change. It is a repeatable production system with standardized inputs, predictable workspaces, quality gates, recovery, capacity management, delivery controls, and feedback loops. We have much of one production cell, but not yet the system around a fleet of cells.

If the intended boundary is explicitly **"produce reviewed pull requests, never merge or deploy"**, then the current design can become a software factory without owning release. The factory's output contract would be a tested, reviewable PR and a human or another controlled system would own merge and release. If "factory" includes production delivery, merge and deploy handoffs are still missing by design.

## What exists today

| Factory capability | Current evidence | Assessment |
| --- | --- | --- |
| Request intake and routing | Verified Slack ingress, channel-to-repository mapping, invoker allowlist, thread-keyed Flue conversations | **Implemented for the pilot** |
| Standardized workspace | Daytona container snapshot, owner-side clone and lockfile install, stable `/workspace/repo`, persistent stopped-container filesystem | **Implemented for the pilot** |
| Engineering execution | Sandbox tools, GitHub issue/repository reads, deterministic working branches, checkpoint pushes, pull-request creation | **Implemented for the main code-change path** |
| Progress visibility | One owner-rendered live run card with hydration, tool, and submission events | **Implemented** |
| Model and integration routing | Per-conversation model choice, ChatGPT/OpenCode Go fallback, deploy-time MCP catalog, native web search/fetch | **Implemented, with deployment-scoped authority** |
| Security boundary | Trusted repository and submission context, typed native GitHub proxy, short-lived bounded push token, no reusable sandbox credentials | **Implemented for native GitHub operations; pilot assumptions remain** |
| Observability | Workers traces/logs, Honeycomb export, optional Langfuse export and read-only analysis tools | **Implemented for visibility; operational controls are incomplete** |
| Cross-thread learning | Approved D1 design for preferences and conversation digests, but no `src/memory` implementation or D1 binding on this branch | **Missing** |

This is enough to call the project a **production-oriented agentic coding cell**. It is not enough to claim repeatable factory throughput or factory-level reliability.

## Missing pieces, in priority order

### 1. A reliable completion contract

The agent can reach a PR, but the system does not yet enforce a uniform definition of "done" across repositories. The factory needs an owner-side completion contract that records, at minimum:

- the requested outcome and repository revision;
- the exact checks run, their exit status, and their scope;
- the checkpoint SHA and remote branch SHA;
- the PR URL and base branch;
- known limitations, skipped checks, and required human review.

Repository-specific CI should remain the authority for mergeability. The coworker should collect and report it rather than treating a local green command as proof that the change is safe.

### 2. Recovery that can distinguish failure from uncertainty

The design already names the right invariant—**Unknown Tool Outcome**—but the command ID, fencing, reconciliation, and replacement-workspace protocol are still deferred. A factory cannot rely on a live process or an uncommitted filesystem. It needs:

- durable command records and terminal markers;
- fencing so late sandbox responses cannot mutate current state;
- evidence-based reconciliation after a timeout or sandbox loss;
- restart/rehydrate from the last Git checkpoint;
- explicit human escalation when an effect cannot be proven.

This is the highest-priority gap before increasing autonomy or concurrency.

### 3. Durable work scheduling and capacity controls

Flue serializes work within a conversation, but factory operation also needs deployment-level controls:

- bounded submission queues and explicit steering-versus-new-work behavior;
- concurrency limits for sandboxes, model calls, GitHub operations, and MCP calls;
- per-submission time, token, tool, and cost budgets;
- cancellation and expiry semantics;
- backpressure and fair scheduling across channels and repositories.

Without these, a burst of requests or a looping model is an incident, not throughput.

### 4. Standard repository onboarding

The pilot assumes a compatible lockfile and a common image. A factory needs a versioned repository contract, such as a reviewed setup manifest or `.agent/setup.sh`, that defines:

- runtime and package-manager versions;
- install, test, lint, format, and build commands;
- required services and safe test fixtures;
- network and secret requirements;
- supported repository layouts and monorepo selection;
- expected CI checks and artifact locations.

This should be opt-in and reviewed. It should not become an unbounded script that silently expands the agent's authority.

### 5. Quality gates and review policy

A model-generated PR is an artifact, not a quality gate. The factory needs deterministic gates around it:

- mandatory formatting, type checking, tests, and repository CI;
- changed-file and dependency-risk checks;
- secret and supply-chain scanning;
- branch protection and required reviewers;
- a policy for generated migrations, infrastructure changes, and dependency updates;
- a clear rule for when the agent must stop and ask a human instead of opening a PR.

The first version can remain PR-only: the gate reports evidence and a human reviews. Automatic merge is not required to achieve a useful factory boundary.

### 6. Multi-repository and multi-workspace operations

The current one-thread/one-workspace/one-branch model is the right isolation primitive, but factory scale requires enrollment and lifecycle management:

- repository registration with owner, default branch, CI contract, and risk tier;
- safe repo and channel mapping management outside source edits;
- cleanup and retention for stopped/archived sandboxes and branches;
- workspace readiness and hydration latency metrics;
- explicit handling of private repositories and Daytona egress/isolation requirements;
- a path from one pilot repository to several repositories without copying policy by hand.

### 7. Operational feedback and learning

Observability tells us what happened; a factory also needs to improve from outcomes. Add:

- completion rate, time-to-ready, time-to-PR, rework rate, test-failure rate, unknown-outcome rate, and cost per accepted PR;
- human review outcomes and reasons for rejection or rework;
- model/repository/task eval sets run before changing prompts or routes;
- per-integration error budgets and alerts;
- bounded cross-thread memory, with the already-designed visibility and retention controls, once the pilot proves it is useful.

Do not optimize for raw PR count. The useful unit is an accepted change with evidence and low human rework.

### 8. Governance for higher-risk work

The native GitHub path is narrowly controlled, but the MCP catalog intentionally exposes the authority selected at deployment. Before factory-wide use, enrollment needs a risk policy for:

- which MCP servers and scopes are allowed for each repository or channel;
- code, dependency, infrastructure, and production-data classifications;
- human approval points for high-risk operations;
- audit retention and incident response;
- sandbox isolation validation beyond the internal Daytona container pilot.

The factory should fail closed when a repository's policy or required capability is missing.

## Suggested path from cell to factory

1. **Make one lane boring.** Finish the code-change path for the pilot: hydrate, inspect, edit, run the repository contract, checkpoint, open a PR, and report evidence. Measure every stage.
2. **Make interruption safe.** Implement command IDs, fencing, unknown-outcome reconciliation, workspace replacement, budgets, and explicit cancellation before adding automatic triggers.
3. **Standardize enrollment.** Add a reviewed repository contract, CI/status-check adapter, risk tier, cleanup policy, and configuration-driven repository enrollment.
4. **Add factory operations.** Add deployment-wide scheduling, capacity/backpressure, retention, dashboards, alerts, and human review feedback.
5. **Expand the trigger surface carefully.** GitHub issue mentions and alert investigations should feed the same submission pipeline only after the interactive lane has measured reliability and cost.
6. **Decide the delivery boundary.** Keep merge/deploy human-owned for a PR factory, or add separately reviewed release adapters with approvals, progressive rollout, and rollback evidence.

## The reclassification test

I would change the label from **"software-factory cell"** to **"software factory"** when a new repository can be enrolled through a documented contract and a normal request can be processed repeatedly—across restarts and ordinary provider failures—to a PR with reproducible quality evidence, bounded cost, auditable authority, and measured human rework. At that point, adding more models or triggers is scaling a system rather than demonstrating another clever demo.
