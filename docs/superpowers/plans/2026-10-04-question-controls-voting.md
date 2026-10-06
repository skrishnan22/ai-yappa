# Question Controls and Voting Implementation Plan (PR 3a)

> **For agentic workers:** Use executing-plans inline, task-by-task. Use the test-audit authoring gate for each new contract test.

**Goal:** Let the Coworker post and close questions with working vote buttons. Clicks record votes without creating a Submission.

**Architecture:** Build on PR #47's QuestionStore. Owner code renders Block Kit and binds both tools to the conversation's trusted destination. The signature-verified Flue interactions route acknowledges immediately, then records/redraws votes through the Worker's execution context. PR 3b adds Submit and dispatch; PR 4 adds listening and switches grill-me to question tools.

**Spec:** Approved skills/question design in PR #46, `docs/superpowers/specs/2026-10-04-skills-and-grill-me-design.md`.

## Global constraints

- All choices are vote-only, even in solo threads. No Submit button, click-triggered dispatch, listen mode or skill rewrite in 3a.
- Post and update only the bound channel/thread/message. Validate callback team, channel, thread, message and choice against the persisted question before mutating it.
- Anyone can vote in the question's own Slack surface; the invoker allowlist is not a vote restriction.
- Use one `question_vote:<A-E>` action ID per choice to satisfy Slack's uniqueness requirement within a block. Values are versioned JSON with question and choice IDs; never trust a value as a destination.
- Choice inputs contain 2–5 labels, each at most 75 characters, with at most one recommended option. Use primary button styling for the recommendation so decoration cannot exceed the label limit.
- Plain-text Block Kit fields display participant names without mention syntax. Escape the top-level fallback to prevent user-controlled mentions. Show up to 20 voter names plus an explicit remaining count and complete choice tallies.
- Failed posting must close the new open row when D1 is available. Key question IDs deterministically by conversation and tool-call ID. A replay with no recorded timestamp is an unknown outcome and must not repost; a confirmed replay returns the existing question.
- Disable implicit Slack SDK retries so ambiguous posting outcomes are handled by the durable question record rather than automatically posting again.
- Preserve newer votes when Slack redelivers an older click. Use the click timestamp, normalized to ISO with microsecond precision, and conditional vote upserts.
- Read thread history to seed human participants, including the starter; reuse the existing bounded pagination helper. Fail before posting if required history cannot be read.
- Without a Slack token, `ask_question` returns a preview and does not access D1 or Slack.
- Count a successful `ask_question` as the turn's Slack reply; `close_question` still needs an ordinary confirmation reply.
- Reuse the glossary's Pending Question: remove the unimplemented seven-day expiry promise, amending ADR 0004. Add ADR 0022 for owner-rendered controls while keeping model-authored controls rejected.

## Task 1: Posting, closing and message rendering

**Files:** `src/questions/slack-message.ts`, `src/questions/tools.ts`, `src/questions/worker-store.ts`, `src/questions/tools.test.ts`, `src/channels/thread-context.ts`, `src/channels/slack-reply.ts`.

**Interfaces:**

```ts
type QuestionRef = { conversationId: string; channelId: string; threadTs: string; startedBy?: string };
type QuestionStoreFactory = () => QuestionStore | Promise<QuestionStore>;
// questionTools returns named askQuestion and closeQuestion definitions.
// Options: token?, store factory, clock with now(), and the production Slack client.
// renderQuestionMessage(question, votes) returns { text, blocks }.
// redrawQuestion(store, client, questionId) reads persisted status/votes and updates message_ts.
```

- [x] Add owner-boundary tool tests protecting preview-without-storage, bound posting plus participant seeding, question replacement/close redraw, known and ambiguous posting failure, stable-call replay without duplicate posting, and input limits. Capture the actual Slack API arguments; do not produce expected messages with the renderer under test.
- [x] Run the tests before implementation and confirm the missing tool module fails.
- [x] Implement native header, body, option buttons, recommendation, vote footer and closed state rendering. Open-ended questions show “Reply in thread”. Choice questions explain that clicking votes and replying continues the conversation. Display complete tallies and bound the voter-name detail.
- [x] Extract `loadThreadMessages` from the current pagination loop; retain the existing Thread Context formatting and bounds.
- [x] Implement tools with lazy D1 access, deterministic SHA-256 question IDs, successful timestamp recording, cleanup on posting failure and replay protection. Close/redraw an older question after atomic replacement. Surface cleanup/redraw failures honestly; D1 remains authoritative.
- [x] Run focused tool and existing thread-context/reply tests.

## Task 2: Signature-verified, surface-bound voting

**Files:** `src/questions/interactions.ts`, `src/questions/interactions.test.ts`, `src/channels/slack.ts`, `src/app.ts`, `src/questions/d1-store.ts`, `src/questions/store.test.ts`.

- [x] Extend the shared store suite with one regression: vote B at a newer timestamp survives a retried older A click. See it fail in both implementations before adding the conditional upsert.
- [x] Add signed Flue route tests with real migrated SQLite: record/change/retry a vote, reject invalid signatures and mismatched surfaces without persistence, reject malformed/closed/missing questions, permit a non-allowlisted voter, and preserve acknowledgement when D1/redraw fails. Capture background work with an ExecutionContext; assert clicks never dispatch.
- [x] Parse payload and value at the interaction boundary. Require a message container and validate its team/channel/message/thread against the persisted question and canonical conversation identity. Require a valid stored choice and matching action ID before joining the participant list.
- [x] For open questions, upsert participant and vote. For an older retry, preserve the latest vote and redraw from D1. Closed clicks receive an ephemeral refusal; failures after a recorded vote explain that the vote was saved even if redraw failed.
- [x] Register `interactions` in `createSlackChannelForEnv`; use execution-context `waitUntil` and return an immediate empty 200. Forward the parent execution context through `src/app.ts`, which currently drops it while routing.
- [x] Mount `/channels/slack/interactions` in the app route map.
- [x] Run focused signed-route/store tests and existing Slack ingress tests.

## Task 3: Agent integration and docs

**Files:** `src/agents/coworker.ts`, `src/agents/coworker.test.ts`, `src/sandboxes/hydrate.ts`, `slack-app-manifest.yaml`, `CONTEXT.md`, `AGENTS.md`, `README.md`, `docs/adr/0022-owner-rendered-question-controls.md`, `docs/adr/0004-settle-submissions-at-human-waits.md`, `docs/adr/README.md`.

- [x] Mount both tools with trusted conversation facts and lazy `APP_DB` access. Extend the finish predicate to accept a non-error ask_question; update the reminder and instructions accordingly. Extend the existing predicate table rather than adding source-grep tests.
- [x] Enable manifest interactivity with the example host and `/channels/slack/interactions`; document replacing the host in Slack settings.
- [x] Amend Pending Question and ADR 0004: one question remains open until replaced, submitted or explicitly closed, with no timer currently implemented. Record that 3a votes are discussion evidence, not Agent Invocations. ADR 0022 permits only owner-rendered controls with verified handlers; ordinary model-authored reply blocks remain unchanged.
- [x] Run lint, formatting, typecheck, all tests, build, secret and diff checks. Inspect the built route and D1 binding. Manual live Slack checks remain distinct from local evidence.
- [x] Commit, push, open a PR against `t3code/question-store-d1`, and link it to T3 Code alongside its lower PR.

## Verification evidence

- 350 tests passed; lint, formatting, typecheck, and production build passed. (Rebased onto the simplified PR #47: the fake store and D1 smoke script are gone.)
- Posting module, vote ordering, signed route, finish predicate, and malformed-action regressions were observed failing before their implementations/fixes.
- The public app route was exercised with migrated SQLite and captured Worker background work.
- D1 remains authoritative when redraws fail or race. Live Slack acceptance and remote migration/deployment were not performed.
