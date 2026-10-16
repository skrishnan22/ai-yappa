# GitHub-triggered PR babysitting — implementation plan

Date: 2026-10-16. Status: planned, not implemented.

Repository baseline inspected: `cb953c09082914e63d8063df870498e791519a9a`.
Decision source: the completed Slack planning session in channel `C0C4QH6RVNJ`, thread `1792137970.425199` (cards D1–D23). Card numbers here refer to that session, not the unrelated decision table in `SLACK_AGENT_SPEC.md`.

## Goal and scope

GitHub PR feedback and CI failures should wake the Coworker that created the PR, let it investigate and fix actionable problems, and have it reply to the feedback on GitHub while reporting in its original Slack thread. This is a PR-babysitting workflow, not merely a notification relay.

This document saves the agreed product policy and proposes a testable implementation sequence. It does not authorize implementing, merging, deploying, or changing live GitHub App settings. Proposed technical mechanisms below are implementation recommendations, not additional decisions attributed to the user. Complete the runtime integration spike before treating the plan as executable end-to-end.

### Final simplification: D23 supersedes D21–D22

**Fix and reply; never mark review threads Resolved.** D21 previously selected bot-thread auto-resolution, and D22 defined its verification gate. D23 explicitly removes that feature. Preserve those cards as history, but implement neither thread-resolution mutations nor a successful-CI resolution finalizer. Do not reinterpret D22 as a requirement to hold every reply until all CI is green. Report local validation and the actual current CI state honestly.

## 1. Agreed policy

| Area                 | Requirement                                                                                                                                                                                                | Cards       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Authority            | Investigate and fix automatically; retain the originating conversation's deployed tools, including its existing MCP authority. No new automatic-submission tool restriction in this release.               | D1, D14     |
| Ingress              | A directly authenticated GitHub App webhook on the existing Worker, not Actions YAML or Slack notification parsing.                                                                                        | D2          |
| PR feedback          | Consider all authorized new general PR comments, inline review comments, and submitted reviews without requiring a mention. Feedback may be non-actionable; considering it does not require a code change. | D3, D9      |
| Human authorization  | Org members for org-owned repositories; explicit allowlisted GitHub users for personally owned repositories. Public visibility is not authorization.                                                       | D6, D7      |
| Bot authorization    | Explicit per-repository review-bot identities only; always ignore our own bot's comments/reviews.                                                                                                          | D8          |
| CI triggers          | Failed completed checks tied to an open eligible PR. Standalone branch failures are not triggers.                                                                                                          | D10         |
| Eligibility          | Only Coworker-created PRs; automatically enroll newly created PRs after enablement. Historical PRs require explicit linking, not inference from PR text.                                                   | D11, D19    |
| Routing              | One persistent PR binding to its original Slack/Coworker conversation. Preserve repository, Working Branch, Model Choice, and conversation history.                                                        | D3, D4, D11 |
| Batching             | Finish the current Submission; coalesce pending events into one follow-up. If idle, start without a deliberate debounce delay.                                                                             | D4, D5      |
| Loop bound           | At most three automatic follow-up Submissions per PR between explicit human resumptions, across commit SHAs and event types.                                                                               | D12         |
| Concurrent pushes    | Never overwrite a new PR head. Refresh and reassess within the same budget; discard obsolete CI failure evidence.                                                                                          | D13         |
| Human controls       | Explicit Slack Pause/Resume buttons, usable by any admitted member of the deployment's Slack Workspace. Ordinary comments/commits do not reset the budget.                                                 | D15, D16    |
| Delivery reliability | Durable processing for accepted events; manual GitHub redelivery for deliveries missed during an outage.                                                                                                   | D17         |
| Lifecycle            | Stop on close/merge. A reopened PR requires explicit Resume; retain history and binding.                                                                                                                   | D18         |
| Replies              | Fix actionable feedback and reply to each considered comment with its outcome. Keep human oversight/status in the original Slack thread. Do not mark threads Resolved.                                     | D20, D23    |

The earlier general “create a new thread if none exists” idea in D3 is narrowed by D11/D19: normal v1 intake continues a verified, newly enrolled Coworker PR's originating conversation. It does not create agents for arbitrary PRs. Recovery of a missing original conversation is not an excuse to guess a channel or transfer branch authority; see the rollout limitations below.

### Non-goals

- Human-created PRs, arbitrary branches, fork-branch writes, or automatic historical backfill.
- Reacting to comment edits/deletions as new work; retain their audit significance without rerunning a fix.
- Auto-resolving review threads, dismissing reviews, automatic approval, or a CI-success finalizer.
- Adding native merge/deploy operations. D14 preserves existing MCP capabilities; this is **not** a universal no-deploy sandbox imposed on mounted MCP tools.
- Automatic recovery/redelivery of events that never reached our inbox.
- Replacing Flue's conversation persistence or Submission Queue, or making sandbox disks canonical state.
- A general automation rules UI, a new multi-installation tenancy model, or implementation of the unrelated scheduled-automations roadmap.

## 2. Repository facts and integration points

| Existing source                              | What exists / required extension                                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/app.ts`                                 | Hono mounts Slack events/commands/interactions only. Add a separate GitHub route; do not call Slack env validation just to authenticate a webhook.                                                                                         |
| `src/channels/slack.ts`                      | Verified Slack dispatch and the planning interaction handler. Route new control action IDs without breaking planning. Integrate all relevant producers with the batching/admission boundary.                                               |
| `src/conversations/start.ts`                 | Shared creation dispatch plus Model Route selection. Continuations must not reseed initialData or accidentally create an instance.                                                                                                         |
| `src/agents/coworker.ts`                     | Persistent repo attachment, tools/MCP mounts, Live Run Card observation, and finish guards. A runtime settlement event exists, but the current observer is not a durable scheduler.                                                        |
| `src/agents/github-tools.ts`                 | PR creation and checkpoint tools derive the Working Branch from conversation identity. Register the PR binding in trusted code after creation; use the real Submission ID for new correlation, not the current proxy placeholder `active`. |
| `src/proxy/github.ts`, `policy.ts`, `ops.ts` | Typed native GitHub operations and installation token profiles. No current PR feedback/check/log/reply operations. GitHub config pins a single installation ID.                                                                            |
| `src/proxy/checkpoint.ts`                    | Explicit remote and deterministic ref, local HEAD equality check, remote confirmation, fresh scoped push token and revocation. `expectedSha` is the **local commit being published**, not a remote-head compare-and-swap guard.            |
| `src/sandboxes/hydrate.ts`                   | Existing hydration plus Slack-request instructions. A verified GitHub work signal needs explicit automatic-fix instructions; webhook bodies are untrusted evidence, not developer instructions.                                            |
| `src/automations/d1-automation-store.ts`     | Examples of atomic claims, transitions, and deduplicated outcomes. Do not reuse its consecutive-failure counter: D12 counts all automatic follow-up Submissions, not just failures.                                                        |
| `src/automations/outcome.ts`                 | Settlement helper exists, but do not assume the full scheduler/heartbeat from the automation plan is wired.                                                                                                                                |
| `src/cloudflare.ts`, `wrangler.jsonc`        | APP_DB exists. At the inspected baseline there is no scheduled handler or Cron Trigger configured. Preserve Worker-level exports and provider/planning initialization.                                                                     |
| `migrations/`, `src/testing/d1.ts`           | Migrations currently end at `0005_automations.sql`; `openTestDatabase()` applies all migrations to real Miniflare D1. Choose the next unused migration number at implementation time.                                                      |

`SLACK_AGENT_SPEC.md` remains the current implementation source of truth. Its Slack-only trigger scope (§1 D7, §4.1, later trigger roadmap) must receive a dated amendment when implementing this extension; do not silently claim it already describes GitHub triggers. Native Credential Proxy invariants and Unknown Tool Outcome rules remain in force. The handoff's blanket merge/deploy language is historical; preserve the spec's deployment-defined MCP authority and D14.

## 3. Design tree and execution flow

```text
Automatic work (D1)
├── Direct webhook ingress (D2)
│   ├── Actor policy (D6–D9)
│   └── Durable accepted-event recovery, manual missed-event redelivery (D17)
├── New Coworker PR eligibility (D11, D19)
│   └── Trusted PR → original conversation/branch binding (D4)
├── Finish current Submission, then batch (D5)
│   ├── Three-Submission budget (D12)
│   ├── Pause/Resume and workspace admission (D15–D16)
│   └── Head changes and PR lifecycle (D13, D18)
└── Fix + reply (D20, D23)
    ├── PR feedback and failed checks (D3, D9–D10)
    └── No review-resolution subtree (D21–D22 superseded)
```

```text
GitHub → POST /channels/github/events
  → size/header checks → HMAC verification over original bytes → schema validation
  → durable inbox insert/deduplication → acknowledge promptly
  → normalize and authorize → find trusted PR binding → pending feedback
  → trusted conversation admission gate: idle + enabled + open + budget available
  → atomically claim one immutable batch and reserve one budget unit
  → dispatch GitHub work signal to the same Coworker instance
  → fetch current PR/check/feedback evidence → edit/test/checkpoint as appropriate
  → typed GitHub replies + Slack outcome
  → reconcile durable settlement → finish batch → drain next pending batch
```

Use event-driven wakeups for responsiveness, backed by a bounded periodic sweep of **our accepted inbox/outbox** for crash recovery. A proposed once-per-minute Cron Trigger is an implementation mechanism, not the rejected automatic polling/redelivery of failed GitHub deliveries. Merge with any heartbeat that lands from the automations work rather than installing a conflicting scheduled handler. No process timers or long-lived agent run should wait for the next webhook.

### Critical runtime constraint: prove D5, do not assume dispatch queues only

Flue can join deliveries to a busy conversation at a turn boundary. `getAgentInstance()` reports existence/identity, not idleness. Its `observe()` callbacks are live-only, their promises are not awaited, and observer errors do not veto runtime work. Therefore neither “just dispatch every webhook” nor an in-memory busy flag implements D5.

The first task must prove an awaited, owner-coordinated admission/lifecycle mechanism that serializes the idle test and batch reservation against **all** existing producers (Slack, planning continuations, and future automation dispatch). An external D1 read of a busy flag followed by dispatch has a race. Reconcile durable runtime settlements after restarts; use observations only as a fast notification path.

If the installed public Flue APIs cannot provide this boundary, record the minimal runtime extension needed and stop that implementation slice for review. Do not reach into generated DO internals or weaken D5 to prompt-based steering. In particular, a GitHub batch must not leak into the model context of the earlier Submission merely because a Slack message raced its dispatch. No extra public agent router is needed.

## 4. Proposed durable data model

Keep application intake/control state in APP_DB, and canonical agent history/settlement in Flue. Names below are proposed, not pre-existing APIs.

- **`github_pr_bindings`**: unique `(installation_id, repository_id, pr_number)`; canonical repo, PR URL, original instance ID/incarnation if supported, Slack team/channel/thread, deterministic Working Branch, activation time, control revision, pause reason, budget epoch/used count, PR lifecycle, and active batch reference. PR author/branch prefix/PR-body text is not sufficient to create this record.
- **`github_deliveries`**: delivery GUID, event/action, verified installation/repository identity, receipt time, payload digest, bounded payload/projection, normalization state, reason, retry time/count. Unique delivery GUID within the deployment; a reused GUID with a different digest is rejected/flagged, not substituted.
- **`github_feedback`**: normalized source key, PR binding, source ID/version, author stable ID/type, source URL, review/root-comment links, source head SHA when relevant, sanitized context, processing state, batch reference. Unique semantic keys also catch duplicates arriving under different delivery GUIDs.
- **`github_batches`**: immutable event membership, budget epoch/ordinal, stored dispatch payload and idempotency key, status, runtime receipt/Submission ID, timestamps, outcome. Partial uniqueness prevents two active batches for one binding; conversation-level coordination also prevents overlap if more than one binding refers to a conversation.
- **`github_reply_effects`**: unique binding + feedback target + reply purpose/version; intended body/digest, status (`pending`, `posting`, `posted`, `unknown`, `failed`), remote comment ID/URL and reconciliation evidence. This is a side-effect ledger, not a second conversation history.

Use conditional SQL updates and D1 `batch()` transactions for claim + event assignment + budget reservation, and for terminal outcome + active-slot release. Check affected rows; a losing concurrent claimant does nothing. Do not depend on an unsupported interactive SQL transaction across remote GitHub/Flue calls.

Persist actor/control audit records and rejection reasons. Bound payload/log sizes and avoid logging raw comment bodies, signed download URLs, or credentials. Proposed operational limits and retention values must be explicit constants, tested and documented before rollout; they are not user-selected numbers in this plan. If a batch must be size-limited, unclaimed feedback stays pending rather than disappearing.

## 5. Intake, authorization, and normalization

### Webhook boundary

- Add `POST /channels/github/events`, optional behind deployment enablement and `GITHUB_WEBHOOK_SECRET`. Missing configuration fails closed for this route without disabling ordinary Slack work.
- Verify `X-Hub-Signature-256` using HMAC-SHA256 and a constant-time comparison/Web Crypto verification against the exact raw bytes. Only then decode JSON. Reject malformed/missing signature, missing delivery/event identifiers, invalid UTF-8/JSON/schema, and oversized requests with explicit non-success responses.
- Check installation identity against the configured installation, repository identity against installation access and binding, and handle a valid ping without dispatching an agent. Do not introduce arbitrary multi-installation token minting through payload fields.
- Return success for a duplicate durably known delivery, or a valid deliberately ignored event. Persist accepted work before acknowledging; storage failure is not a successful acceptance. Aim to respond comfortably within GitHub's ten-second deadline without making membership checks/model work part of the request.
- Transport delivery is not a trusted instruction. Store event contents as evidence under a trusted signal envelope generated by code.

### Event mapping

| Event/action                                     | Normalized behavior                                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issue_comment.created`                          | Only when the issue is a PR with an eligible binding; consider the general comment.                                                                                 |
| `pull_request_review_comment.created`            | Retain inline location, diff context, review ID, and top-level reply target.                                                                                        |
| `pull_request_review.submitted`                  | Consider review summary/body; fetch submitted review comments and deduplicate against inline-comment deliveries. Empty approvals still do not justify code changes. |
| `check_run.completed` with `conclusion: failure` | Add failure evidence for associated eligible open PRs and the current relevant head; no standalone branch dispatch.                                                 |
| PR close/merge/reopen lifecycle                  | Update durable lifecycle gates. A reopened PR remains paused until Resume.                                                                                          |
| Comment edits/deletions or unsupported events    | No new fix trigger; retain compact audit state where applicable.                                                                                                    |
| Our own bot's comments/reviews                   | Ignore regardless of allowlist. Do **not** suppress failed CI merely because our own push caused it.                                                                |

For CI semantic dedupe, include check identity, head SHA, and a distinguishable attempt/completion version where provided; a redelivery is not a fresh attempt, but a genuinely failed rerun must not be lost. Missing or ambiguous PR associations are recorded without guessing. Validate GitHub's head-SHA semantics against the actual Actions/check payloads used by the pilot; forks and merge-test SHAs need explicit handling, not an assumed equality that drops every useful failure. Broader timeout/cancelled/action-required conclusions are not silently added to D10's failure scope.

For reviews, the same inline comment appearing in a submitted-review fetch and its own webhook is one work item/reply target. D5 does not imply a new idle debounce window or waiting indefinitely for a reviewer to finish typing.

### Actor policy

- For human feedback on org-owned repos, verify current membership of the owning organization with Worker-side credentials (organization Members read where required). `author_association` is context, not a write-role API: `CONTRIBUTOR`/`COLLABORATOR` do not prove organization membership or maintain/write/admin rights.
- For personally owned repos, use an operator-maintained per-repository list of stable GitHub user IDs. Resolve any configured login to an ID, not a display-name comparison. No organization/team check exists for personal ownership.
- For review bots, match explicitly configured stable bot/App identities from verified GitHub records; never trust text claiming to be Greptile. Actual pilot bot/user IDs are deployment configuration to discover and verify, not values to invent in this document.
- Membership API unavailability is a blocked/retryable authorization check, not permission. A verified denial is ignored with a reason. Recheck eligibility before delayed dispatch; never accept unknown actors because the repo is public.
- CI events are authorized through configured installation, eligible binding, and check provider/provenance, not a fictional human org membership check on a CI bot. Treat check output as untrusted evidence. Do not exempt CI from the budget and lifecycle gates.

## 6. Dispatch, batching, and recovery contract

1. Register the binding from trusted PR-creation context and GitHub's result. Repeated successful registration is idempotent. Bind before telling the caller auto-follow-ups are enabled. If PR creation succeeds but the response or binding write is lost, reconcile the known head/base via GitHub; never blindly open a second PR.
2. Ingest/authorize feedback durably even while the Coworker is busy or paused. Do not dispatch it as steering context. Original history, repo attachment, thread, Model Choice, and configured tools stay intact.
3. At an owner-coordinated idle boundary, re-read current PR state, authorization, pause revision, and head/check relevance. Filter stale/duplicate items before reserving work. Atomically freeze pending eligible feedback into one batch, reserve one ordinal, and set the active slot.
4. Dispatch a trusted `github.pr_followup` signal to the recorded existing instance, with batch ID and immutable evidence references. Use a stable application idempotency key; retries reuse the **identical** stored payload, including Model Route attributes. A timeout is not evidence to mint a new key or spend another budget unit.
5. Persist the admission receipt and correlate by batch plus Submission ID, handling settlement-before-receipt-write races. Use conditional incarnation sends if supported. Do not use `startConversation`'s creation behavior to silently replace a missing originating conversation.
6. On completed/failed/aborted durable settlement, settle the batch once and release its active slot. Process pending feedback only after the prior Submission has actually settled. An ordinary Slack Submission finishing must also wake pending PR work, not just a previous GitHub batch.
7. A bounded periodic sweep reconciles stranded claims, receipts, and durable settlements. Before repeating an ambiguous dispatch, prove the installed runtime's keyed-admission semantics. Failure after admission counts as that one Submission; no fresh automatic retry of the same failed batch under a new key.
8. Three automatic Submissions consume the epoch even if one only triages an approval or explains why no change is warranted. Duplicate/stale/unauthorized deliveries and safe pre-admission retries consume none. Pending feedback survives the pause; new events/SHAs do not replenish the budget.

Proposed conservative recovery fallback: if a trusted binding's original conversation cannot be recovered, mark it blocked, preserve feedback, and surface the routing failure through operational logs/the known thread when possible. Do not pick a new Slack destination or take over its branch. Historical linking and any replacement-thread recovery UI can be separate reviewed work; v1 does not silently infer them.

A Planning Session or an unresolved human clarification should not be silently answered by a GitHub event. Hold pending automatic work until the relevant conversation gate clears; cover this collision in the integration spike rather than launching overlapping workflows.

## 7. Work execution and typed GitHub replies

Extend native proxy operation schemas individually; no arbitrary authenticated GitHub HTTP tool, repository selector, host, permission field, or credential in model input. Suggested capabilities:

- Read the bound PR/head/lifecycle, its review summaries, inline/general comments, checks and annotations.
- Read relevant GitHub Actions job/step logs using worker-side read credentials and capped/redacted text. Check output alone may suffice for third-party CI. A `details_url` is not permission to fetch an arbitrary authenticated host; unsupported providers get an evidence-limited report, not a guessed fix.
- Reply to a normalized feedback item belonging to the bound PR. Code verifies the target against trusted context and constructs the path. Inline replies use the top-level review-comment ID; GitHub does not support replies-to-replies. General comments/review summaries use a PR conversation response with an explicit source reference.

Add only the necessary `checks:read`, `actions:read`, and comment-write scopes to the relevant cached token profiles/App registration, plus organization membership read where applicable. General PR issue comments may need `issues:write`; inline replies need `pull_requests:write`. Verify endpoint requirements when implementing. Keep the fresh sandbox push profile exactly `contents:write`; none of these new scopes belong in a sandbox token. Log-download redirects are handled server-side, with constrained destinations, no Authorization forwarding to redirected hosts, time/size caps, and no signed URL exposed as a reusable capability.

The trusted work signal authorizes PR follow-up, while quoted feedback/logs stay untrusted. Update the current Slack-only “only mutate on a clear human request” instructions for this explicit signal so the agent neither refuses the agreed automation nor treats arbitrary PR text as higher-priority instructions. Keep the normal conversational mutation policy unchanged for Slack questions. Keep the existing MCP catalog unchanged per D14; disclose the resulting provider-scoped blast radius rather than claiming the comment allowlist prevents prompt injection.

For each feedback item: inspect current evidence, fix if justified, or reply with a reason/clarifying question if not. Do not manufacture changes for thanks, approvals, false positives, or obsolete feedback. Test meaningful edits before publishing, reference the exact fix commit, distinguish local validation from CI, and report failures honestly. Update the existing PR branch; do not automatically open a replacement PR or mark review threads Resolved. Never copy secrets/private Slack discussion into public GitHub replies.

### Publication and stale-head guards

Add a separate trusted expected **remote** head to automatic checkpoint context, without confusing it with `checkpoint_working_branch.expectedSha`. Immediately before native publishing, re-read PR openness/head and confirm branch binding; validate patch ancestry. Use normal non-force push rejection as the last remote protection. A concurrent update means refresh/reassess within the current budget, never reset/force-push over human work. A newly admitted reassessment Submission consumes a new ordinal; do not hide unlimited self-restarts within one attempt.

A PR state read and Git push are not one GitHub transaction: document the narrow close/merge race honestly. The guarantee is to block pushes once closure is observed and never retry/publish against known stale state, not an impossible atomic GitHub close-and-push lock.

### Reply idempotency and ambiguous effects

Reserve an effect record before posting. Store remote comment IDs/URLs on success. An HTTP timeout after posting is `unknown`, not permission to POST again. Reconcile by reading the bound PR's bot-authored replies and a stable machine marker/effect key; if inconclusive, surface it and pause that effect. A marker helps reconciliation but is not a claim that GitHub supports POST idempotency. Proven pre-send rejection/rate limiting can be rescheduled with backoff; unknown mutations cannot be retried blindly. Replayed batches must not duplicate replies, commits, or budget use.

## 8. Slack control surface

Use an application-owned **PR babysitting control message**, separate from the owner-managed Live Run Card and planning Decision Cards. Show PR link, enabled/paused/closed/blocked state, remaining budget, pending work count, and last outcome, plus Pause/Resume buttons. The model does not create or edit these controls.

- Verify Slack signatures through the existing adapter; check the actor against the installing Slack Workspace on every click. External Slack Connect users and unknown membership fail closed. Any admitted workspace member may operate controls, not only the original requester.
- Bind action values to a stored PR binding, message/thread identity, and control revision. Never trust caller-supplied repo/channel/branch destinations. Audit actor and transition.
- Pause prevents new automatic Submissions but lets an already-running Submission finish under D5/D15. PR closure separately invokes D18's publish gate.
- Resume requires an open PR and the correct current control revision. It grants a fresh allowance of three, then wakes pending work. Duplicate delivery/stale clicks cannot repeatedly top up the allowance; clicks while already active do not reset it.
- Commit the transition before acknowledging; redraw/wakeup may happen after acknowledgment but must be recoverable from persisted state.
- Keep the existing Slack summary finish requirement. A GitHub reply does not substitute for the human-visible Slack outcome. Post links, work/no-change reasoning, actual validation, and pause/failure explanations, without per-webhook notification spam.

## 9. Implementation slices and acceptance tests

All boxes are intentionally unchecked. Suggested slices are review boundaries, not permission to implement now. Rebase/reinspect current source before each slice, since the parallel automation plan may land first.

### Slice 0 — prove the runtime integration and amend the spec

- [ ] Read the installed Flue dispatch/hook APIs and write a minimal contract test for keyed dispatch replay, settlement readback, conditional continuation, busy joining, and restart recovery. Online docs and installed types can differ; the inspected installed declarations include `idempotencyKey` despite an incomplete reference-page request example.
- [ ] Prove the D5 admission boundary across GitHub, Slack, and planning dispatch. A failed proof blocks activation and requires an explicit runtime integration proposal, not a pretend busy flag.
- [ ] Update `SLACK_AGENT_SPEC.md` with a dated GitHub-trigger scope amendment and relevant instruction/contracts; retain Credential Proxy and MCP authority distinctions. Add domain terms only where needed.

**Acceptance:** a feedback burst during an unrelated active Submission never enters that Submission's reasoning context and produces one subsequent batch, even if a Slack continuation races it. Eviction/restart does not make an active conversation appear idle. No public Coworker router is mounted.

### Slice 1 — store and trusted PR registration

- [ ] Add the next unused migration and `src/github-triggers/{types,store,d1-store}.ts` with explicit transition APIs, not generic patch/update methods.
- [ ] Integrate idempotent registration with `performOpenPullRequest` and trusted conversation/runtime context; handle create-success/binding-failure recovery.
- [ ] Add real D1 tests via `openTestDatabase()` for concurrent claims, semantic dedupe, immutable batch payload, budget epoch, settlement-before-receipt ordering, and atomic pause/resume.

**Acceptance:** only a verified new Coworker-created PR has automatic authority, a duplicate registration does not reset budget, and two claimants never assign the same feedback to two batches. Existing unlinked PRs do not auto-dispatch.

### Slice 2 — webhook intake and actor policy

- [ ] Add `src/channels/github.ts`, `src/github-triggers/{signature,payloads,normalize,access}.ts`, optional GitHub-route environment validation, and the new Hono route.
- [ ] Add operator-controlled user/bot allowlist configuration keyed by canonical repository identity; membership checking remains code-side.
- [ ] Implement the event/action matrix, raw-byte verification, durable acceptance, compact ignored reasons, and review/inline dedupe.

**Acceptance:** tests cover valid Unicode payloads, tampering, malformed/oversized body, missing headers, wrong installation/repo, ping, duplicate GUID with changed content, unauthorized/public commenters, private org membership, API denial/unavailability, bot spoofing, self-event loops, and plain issue comments versus PR comments. Accepted-event DB failure returns non-success. No test uses a real secret.

### Slice 3 — native evidence, replies, and publication gates

- [ ] Extend `src/proxy/{policy,ops,github}.ts` and `src/agents/github-tools.ts` with individually reviewed bound-PR read/reply operations, required scopes, and response projections.
- [ ] Add server-side capped CI evidence retrieval and `github_reply_effects` reconciliation. No arbitrary URL/authenticated request input.
- [ ] Add trusted head/lifecycle checks to automatic publishing and preserve deterministic destination/token revocation.

**Acceptance:** tests refuse cross-PR targets, fabricated feedback IDs, arbitrary paths/URLs, redirected credential leakage, oversized logs, wrong reply-root IDs, stale heads, and known closed PRs. Simulate a reply POST succeeding before its response is lost: recovery finds it or leaves it unknown, never posts a duplicate. Existing checkpoint security tests remain green.

### Slice 4 — batch dispatcher and recovery

- [ ] Implement `src/github-triggers/{dispatcher,recovery}.ts` using Slice 0's proven boundary, immutable dispatch payloads, stable keys and persisted receipts.
- [ ] Wire trusted `github.pr_followup` instructions and durable outcome reconciliation in the Coworker integration. Preserve Model Choice and calculate Model Route once per immutable dispatch payload.
- [ ] Add a bounded accepted-inbox recovery sweep via the Worker scheduled handler; register the proposed Cron Trigger in Wrangler, coexisting with any automation heartbeat. No GitHub delivery-list polling/redelivery job.

**Acceptance:** burst batching, idle immediate wakeup, a fourth follow-up pausing, unknown dispatch/read recovery, duplicate settlements, deployment interruption, source membership change, stale/ambiguous CI associations, unrelated Slack settlement wakeup, planning collision, and preserved original instance/toolset all pass. A replay does not allocate a second ordinal or use a fresh idempotency key.

### Slice 5 — controls, reporting, and pilot enablement

- [ ] Add `src/github-triggers/blocks.ts` and `src/channels/github-trigger-interactions.ts`; compose interactions with planning, never replace that route wholesale.
- [ ] Add revision-checked Pause/Resume, workspace-member admission, control audit, and recoverable redraw/wakeup. Do not attach buttons through model-authored reply blocks.
- [ ] Add end-to-end tests for fix/reply/Slack-summary behavior, including no-action feedback and CI whose diagnostics are unavailable.
- [ ] Document configuration, native permissions, manual missed-delivery redelivery, known limitations, observability and rollback in README/spec. Keep auto-resolution and its finalizer absent.

**Acceptance:** any admitted member can pause/resume; external users cannot; stale/replayed clicks do not add budget; a closed PR cannot resume; reopen keeps it paused; controls and the Live Run Card coexist. Bot feedback gets an explanatory reply, human feedback stays open, and neither gets a Resolved mutation.

## 10. Verification and rollout

For implementation batches run:

```sh
pnpm test
pnpm run check:types
pnpm run lint
pnpm run fmt:check
pnpm run build
```

Use targeted Vitest tests while developing, then the full suite. Typecheck and build catch real Flue resource packaging/runtime integration beyond test stubs. Run the repository's staged secret scan when available; do not add secrets to fixtures or commit runtime payload dumps. This documentation-only change needs documentation/link/diff validation, not claims that the future integration tests already exist.

Before enabling live processing:

1. Apply the additive APP_DB migration; deploy code disabled. Secrets and App permission/subscription changes are operator actions, not accomplished by this plan PR.
2. Configure `GITHUB_WEBHOOK_SECRET`, the existing pinned installation, required native read/comment permissions, verified human/bot ID allowlists, and the endpoint. Subscribe to PR general comments, review comments, reviews, check runs, and lifecycle events. No review-resolution subscription/mutation is required.
3. Verify delivery authentication and persisted intake using a new Coworker PR. Test a trusted human comment, allowlisted bot review burst, unrelated public commenter, and failed check; verify return to the exact original Slack conversation/Working Branch.
4. Verify three-attempt exhaustion, Pause/Resume idempotence, concurrent human push, close/reopen, and lost-response reconciliation. Use controlled fixtures or a dedicated pilot PR rather than intentionally breaking production branches.
5. Record complete delivery GUIDs, batch/Submission IDs, commit links and PR/thread identity in operational evidence. Monitor inbox age, blocked authorization/routing, unknown effects, batch outcomes, and budget pauses; do not log credentials or raw private discussion.
6. On rollback disable new automatic dispatch and revoke/disable webhook processing as appropriate; preserve inbox, bindings and effect ledgers for reconciliation. Disabling intake means missed events require manual redelivery. Do not drop durable state or assume an in-flight external mutation was cancelled.

### Explicit limitations / implementation-time checks

- The owner-side no-steering batching guarantee is a release-blocking technical spike, not already supplied by `getAgentInstance()` or `observe()`.
- “New PRs only” is the automatic rollout path. A historical-linking/replacement-conversation UI is not specified here; leave historical/unrecoverable mappings blocked rather than infer authority.
- Successful CI may be displayed or read as evidence, but must not start a resolution finalizer or count as a repair trigger after D23.
- GitHub checks can have missing/ambiguous PR associations and merge-test SHAs. Prove pilot mappings and record unsupported cases; do not broaden eligibility to forks or all branches incidentally.
- Public bot reviews can reflect attacker-controlled repository content even when the bot identity is allowlisted. Full deployed MCP authority is a consciously retained D14 trade-off, not a prompt-injection safety guarantee.
- D1 transactions do not include GitHub side effects or Flue admission. Native writes require evidence-based reconciliation; exactly-once external mutation is not promised.

## References

Repository: `SLACK_AGENT_SPEC.md`, `CONTEXT.md`, `docs/adr/README.md`, ADRs 0016/0017/0023/0024, and the source files listed above. The scheduled-automations plan is context for reusable patterns, not evidence that its planned heartbeat is implemented.

- [GitHub webhook signature verification](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [GitHub webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [GitHub failed deliveries: no automatic redelivery](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)
- [PR review comments and reply targets](https://docs.github.com/en/rest/pulls/comments)
- [Organization membership APIs](https://docs.github.com/en/rest/orgs/members)
- [GitHub Actions job logs](https://docs.github.com/en/rest/actions/workflow-jobs)
- [Cloudflare D1 transactional batches](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Cloudflare scheduled handlers](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)
- Flue documentation: `pnpm flue docs read reference/agent-api` and `pnpm flue docs read reference/events`; verify against the installed runtime declarations before implementation.
