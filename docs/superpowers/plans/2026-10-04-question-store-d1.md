# Question Store D1 Implementation Plan (PR 2)

> **For agentic workers:** Use executing-plans task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Persist questions, participants and votes without changing Slack behavior.

**Architecture:** Implements the storage section of the Skills and `/grill-me` spec (`docs/superpowers/specs/2026-10-04-skills-and-grill-me-design.md`, PR #46). PR #34 already provisioned the `slack-agent-memory` D1 database, `migrations/`, and the D1 type subset; this PR reuses all three. Its binding is renamed from `MEMORY_DB` to `APP_DB`, so memory and questions share one binding; no production code read `MEMORY_DB`.

**Deviation from the spec:** the spec called for an in-memory fake for tests. Tests instead run the production SQL on a real local D1 (`src/testing/d1.ts`: wrangler's `getPlatformProxy`, in memory, migrations applied), so there is no fake to keep in sync. This also replaces PR #34's `node:sqlite` adapter, so the memory tests run on real D1 too.

## Constraints

- No Slack tools, interactions, ingress or agent changes.
- Append `0003_questions.sql`; never edit applied migrations.
- One open question per conversation: a partial unique index, plus close-and-insert in one D1 batch (D1 batches are transactional: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
- Submit and close are conditional updates of open rows; exactly one changed row wins.
- One vote per user per question, written only while the question is an open choice question with that choice id.
- Participant joins are idempotent and keep the first join time. Callers derive group mode from participant count.
- Callers supply IDs, timestamps and trusted thread/user bindings, and perform authorization.
- Rows and choice JSON are parsed with Valibot at the storage boundary. Database and parse failures propagate.

## Tasks

- [x] `src/questions/store.ts`: `Question` (discriminated on `kind` and `status`), `Participant`, `Vote`, `QuestionStore`.
- [x] `src/memory/d1.ts`: add `batch()` to the D1 subset. `src/testing/d1.ts` replaces the `node:sqlite` adapter with a real D1 per test.
- [x] `migrations/0003_questions.sql`: the spec's three tables, `one_open_question`, and named CHECKs tying `kind` to `choices` and `status` to the close/submit columns.
- [x] `src/questions/d1-store.ts`: `createQuestionStore(db)`.
- [x] `src/questions/store.test.ts`: round-trip, replacement and rollback, one-open index, row-shape CHECKs, choice validation on write, first-wins `finishQuestion`, participant dedup, vote change and rejection.
- [x] `wrangler.jsonc`, `src/cloudflare-workers.d.ts`, README, AGENTS.md: single `APP_DB` binding and the pre-deploy migration command `pnpm exec wrangler d1 migrations apply APP_DB --remote`.

No remote migration or Worker deployment is part of this PR.
