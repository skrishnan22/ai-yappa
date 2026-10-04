# Question Store D1 Implementation Plan (PR 2)

> **For agentic workers:** Use executing-plans task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Persist questions, participants and votes without changing Slack behavior.

**Architecture:** Implement the approved Skills and `/grill-me` spec's storage section. The spec is in PR #46 (`docs/superpowers/specs/2026-10-04-skills-and-grill-me-design.md`). Since that design, PR #34 merged memory storage into main. Reuse its provisioned `slack-agent-memory` database, `migrations/`, D1 types and SQLite adapter. Add `APP_DB` as a second binding to that same database; retain `MEMORY_DB` for the memory work. PR 2 is independent of PR 1 and targets main.

**Tech Stack:** TypeScript, Valibot, Cloudflare D1, Vitest, Node SQLite, Wrangler.

## Global constraints

- No Slack tools, interactions, ingress or agent changes in this PR.
- Append `0003_questions.sql`; never edit applied memory migrations.
- One open question per conversation, enforced by a partial unique index.
- Replace a question with a close-and-insert D1 batch; insertion failure rolls back the close. D1 batches are transactional: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch.
- Submit and close are conditional updates of open rows. Exactly one changed row wins.
- Votes are one per user per question, updated atomically only while open and for a valid choice.
- Participant joins are idempotent and preserve the first join time. Group mode is derived by the caller from participant count.
- IDs, timestamps and trusted thread/user bindings are supplied by the caller. Store code has no Slack authorization policy.
- Parse SQL rows/JSON at the storage boundary with Valibot; use discriminated question kind and status types.
- Read-only store access returns independent values. No in-memory caller can mutate persistence through a returned object.
- The local smoke script always uses a fresh temporary database and removes it afterwards. It cannot execute remotely.
- Remote migration is a documented pre-deploy operation, not part of the smoke script.

## Task 1: Question store contract and behavioral tests

**Files:** `src/questions/store.ts`, `src/questions/store.test.ts`, `src/questions/testing/memory-store.ts`.

**Interfaces:**

```ts
type QuestionContent =
  | { kind: 'open' }
  | { kind: 'choice'; choices: { id: string; label: string; recommended?: boolean }[] };
type QuestionState =
  | { status: 'open' }
  | { status: 'closed'; closedAt: string }
  | { status: 'submitted'; closedAt: string; submittedBy: string; submittedByName: string };
type Question = {
  id: string; conversationId: string; channelId: string; threadTs: string;
  messageTs?: string; title: string; body?: string; recommendation: string; createdAt: string;
} & QuestionContent & QuestionState;
type OpenQuestion = Extract<Question, { status: 'open' }>;
type Participant = { conversationId: string; userId: string; joinedAt: string };
type Vote = { questionId: string; userId: string; choiceId: string; userName: string; updatedAt: string };
type QuestionStore = {
  openQuestion(question: OpenQuestion): Promise<void>;
  getQuestion(questionId: string): Promise<Question | undefined>;
  getOpenQuestion(conversationId: string): Promise<OpenQuestion | undefined>;
  setMessageTs(questionId: string, messageTs: string): Promise<boolean>;
  closeQuestion(questionId: string, closedAt: string): Promise<boolean>;
  submitQuestion(args: { questionId: string; userId: string; userName: string; closedAt: string }): Promise<boolean>;
  upsertParticipant(participant: Participant): Promise<void>;
  listParticipants(conversationId: string): Promise<Participant[]>;
  upsertVote(vote: Vote): Promise<boolean>;
  listVotes(questionId: string): Promise<Vote[]>;
};
```

- [x] Write a shared suite for `createQuestionStore(openMigratedSqlite())` and `createMemoryQuestionStore()`: round-trip both kinds, conversation isolation, open replacement and rollback on duplicate ID, timestamp recording, first-wins submission, idempotent close, immutable submitted/closed rows, participant deduplication/isolation, vote change/name preservation, invalid choices/open questions/closed questions rejection, and object isolation.
- [x] Run `pnpm vitest run src/questions/store.test.ts`; confirm missing modules fail before implementation.
- [x] Implement the types and in-memory fake with maps keyed by question ID and nested maps for participant/vote user IDs. Before replacing an open question, reject duplicate IDs; then close the old question at the new question's creation time. Use `structuredClone` on ingress and egress.
- [x] Add schema/migration tests for persisted invalid kind/status, missing submission attribution, bad choice JSON and the one-open constraint.

## Task 2: D1 implementation and migration

**Files:** `migrations/0003_questions.sql`, `src/questions/d1-store.ts`, `src/memory/d1.ts`, `src/memory/testing/sqlite-d1.ts`.

- [x] Add `batch(statements: D1Statement[]): Promise<{ meta: { changes: number } }[]>` to the existing D1 subset. Extend the SQLite adapter with synchronous SQLite execution inside `BEGIN`/`COMMIT` and rollback on failure; expose `close()` for new tests. Do not simulate batch using asynchronous individual commits.
- [x] Add the three tables from the approved spec, preserving their columns and the `one_open_question` partial unique index. Add checks tying kind to valid choices JSON and status to attribution/close fields so malformed states cannot be persisted.
- [x] Implement prepared SQL queries. The key writes are:

```sql
UPDATE questions SET status = 'closed', closed_at = ?2
WHERE conversation_id = ?1 AND status = 'open';
-- Batch that update with the new INSERT; never run them as separate commits.

UPDATE questions SET status = 'submitted', submitted_by = ?2,
submitted_by_name = ?3, closed_at = ?4 WHERE id = ?1 AND status = 'open';

INSERT INTO thread_participants (conversation_id, user_id, joined_at)
VALUES (?1, ?2, ?3) ON CONFLICT (conversation_id, user_id) DO NOTHING;

INSERT INTO votes (question_id, user_id, choice_id, user_name, updated_at)
SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (
  SELECT 1 FROM questions q, json_each(q.choices) choice
  WHERE q.id = ?1 AND q.status = 'open' AND q.kind = 'choice'
    AND json_extract(choice.value, '$.id') = ?3
) ON CONFLICT (question_id, user_id) DO UPDATE SET
choice_id = excluded.choice_id, user_name = excluded.user_name, updated_at = excluded.updated_at;
```

- [x] Parse storage rows, choice JSON and reconstructed questions. Sort participants by joined time then user ID and votes by user ID. Throw database/parse failures to callers; do not convert an outage into empty data.
- [x] Run `pnpm vitest run src/questions/store.test.ts src/memory/preferences.test.ts`; both implementations and the existing memory behavior must pass.

## Task 3: Binding, smoke verification and operational docs

**Files:** `wrangler.jsonc`, `src/cloudflare-workers.d.ts`, `scripts/question-store-smoke.mjs`, `scripts/question-store-smoke.sql`, `package.json`, `README.md`, `AGENTS.md`.

- [x] Add `APP_DB` alongside `MEMORY_DB`, both pointing to database ID `d89b5f6b-5b02-41b2-aca0-85ff1923b6a5`, name `slack-agent-memory`, and `migrations_dir: migrations`. Extend the local `cloudflare:workers` env declaration with this D1 binding; leave process-env secret validation unchanged.
- [x] Add `db:smoke:questions`: Node creates a temporary directory, invokes `pnpm exec wrangler d1 migrations apply APP_DB --local --persist-to <dir>`, then `d1 execute APP_DB --local --persist-to <dir> --file scripts/question-store-smoke.sql`. Always remove the directory in `finally`.
- [x] SQL smoke inserts a choice question, repeats a participant join, upserts then changes a vote, attempts two conditional submissions, checks the first attribution survives, and checks a second open question can follow. Every assertion inserts a boolean into a table with `CHECK (ok = 1)` so Wrangler exits unsuccessfully on a failed assertion.
- [x] Document local smoke, binding alias, remote migration command `pnpm exec wrangler d1 migrations apply APP_DB --remote`, and that migrations must precede later question-tool deployment.
- [x] Run `pnpm run db:smoke:questions` and the full gate: lint, format, typecheck, test, build, secret scan and diff checks. Confirm the build retains both D1 bindings.
- [x] Commit, push, create a PR against main, and register it with T3 Code. Record local D1 evidence and explicitly identify remote migration/deployment as not performed.

## Verification record

Local checks: all 319 tests in 35 files pass; lint, formatting, typecheck, build and the disposable Wrangler D1 SQL smoke pass. The SQL smoke executes seven assertions. The generated Worker config retains both bindings pointing at the same database ID. Read-only remote migration listing shows only `0003_questions.sql` pending. No remote migration or Worker deployment was performed. The build emits its existing `use agent` module-directive warning.
