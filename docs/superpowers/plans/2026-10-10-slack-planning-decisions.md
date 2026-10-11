# Slack planning decisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Slack thread plan through attributed, reversible decision cards. Yappa asks; people decide in a modal. Each decision is saved to D1 and immediately continues Yappa, and the thread stays quiet between questions.

**Architecture:**
- **Decision log.** One D1 table, `card_revisions`, is the decision log. A second small table, `planning_sessions`, records whether a thread is in a planning session.
- **Agent tools.** The Coworker gets four tools (`ask_decision`, `reword_decision`, `list_decisions`, `end_planning`). They reach D1 through a module holder that `src/cloudflare.ts` registers, the same pattern as `setProvider`, so `flue run` (no D1) runs without them.
- **Slack interactivity.** A new route, `/channels/slack/interactions`, handles **Decide…** (opens a modal), modal submission (records the decision, then dispatches the Coworker) and **Reopen** (inserts a revision, then dispatches).
- **Session start and end.** A session starts when the model activates the `grill-me` skill (observed `activate_skill` `tool_start`). It ends through `end_planning`, which posts a summary built from the log. While a session is active, Slack ingress drops unmentioned replies.

**Tech Stack:** TypeScript, Flue 2.1 (`defineTool`, `observe`, `dispatch`), `@flue/slack` (`interactions` handler), `@slack/web-api` (Block Kit, `views.open`), Cloudflare D1, Valibot, Vitest with real D1 (`openTestDatabase()`).

**Spec:** `docs/superpowers/specs/2026-10-10-slack-planning-decisions-design.md`. It depends on `docs/superpowers/specs/2026-10-10-channel-member-access-design.md`, which is implemented in PR #52. This branch stacks on it.

## Global Constraints

- Follow `AGENTS.md`. Check optional values by truthiness unless `''`, `0` or `false` is meaningful. Match the surrounding code: tabs, a blank line after blocks, Valibot schemas at boundaries, named SQL constants (`src/questions/d1-store.ts` style).
- **Migrations.** Add `migrations/0004_*.sql`. Never edit `0001`–`0003` (they are deployed).
- **Tests.** Store tests use a real D1 from `openTestDatabase()` in `src/testing/d1.ts`. Slack HTTP is stubbed with `stubSlackApi()` from `src/channels/testing/slack-api-stub.ts`, which replaces only `fetch`.
- **Permissions.** Any human member of the workspace may decide or reopen. External users are refused (ADR 0022).
- **Answering.** The modal is the only way to answer. Yappa never parses replies as answers.
- **Write order.** Decisions are saved before Yappa is dispatched. There is no Retry button; a failed run shows on the existing run card (`src/channels/run-card.ts`).
- **Planning only.** A decision never by itself requests code edits, commits, pull requests or deployment.
- **Gate.** Each task ends green on `pnpm run check:types && pnpm test && pnpm run lint && pnpm run fmt:check`. Task 6 also runs `pnpm run build`.

## Rulings made while planning (spec silent or ambiguous)

- **Session state lives in D1** (`planning_sessions`), not in Coworker state. Ingress has to read it before it dispatches, and Coworker state cannot be reached from the Worker. The spec's "one table" covers the decision log; session state is not a decision.
- **Card id.** `card_id` is a UUID, keeping the spec's `(card_id, revision)` primary key globally unique. People and the model see a label `D<n>`: the card's position by creation time within its conversation. Tools take the label.
- **Rewording only applies to open cards.** Rewording a decided card would drop its decision silently, and the spec says Yappa "cannot silently replace the submitted answer". To change a decided card, Yappa asks people to Reopen it.
- **Reopen only applies to decided cards.** A Reopen click on a card that is already open just redraws it.
- **Decisions after a session ends still record and dispatch.** The spec gives no rule against it, and a card always targets itself.
- **External users in interactions** are detected by comparing `payload.user.team_id` with the conversation's workspace (the `teamId` in `channel.parseInstanceId(conversationId)`). A missing `user.team_id` is refused (fail closed).
- **Slack's 3-second deadline.** Interaction handlers do their D1 write before responding. Redraw, thread-context load and dispatch run through `c.executionCtx.waitUntil` when one exists, and are awaited otherwise (tests).

## Review Focus

1. **Stale modal.** A modal opened before a reword or reopen is refused on submit, with "review the current card". No decision is written and nothing is dispatched.
2. **Double submit or replay.** Two submissions of the same modal: the first wins and the second is told to review the card. Exactly one dispatch happens.
3. **Tampered submission.** A `choice` value that is not among the card's choices, or private metadata naming an unknown card, is refused without a write.
4. **External user** clicks Decide or Reopen or submits a modal: refused, with no write and no dispatch.
5. **Thread silence.** During a session, unmentioned replies are not dispatched but mentions are. After `end_planning`, unmentioned replies dispatch again.

---

### Task 1: Decision log and planning sessions in D1

**Files:**
- Create: `migrations/0004_card_revisions.sql`
- Create: `src/planning/decision-log.ts` (types, `DecisionLog` and `PlanningSessions` port types)
- Create: `src/planning/d1-decision-log.ts` (D1 implementation)
- Test: `src/planning/decision-log.test.ts`
- Delete: `src/questions/store.ts`, `src/questions/d1-store.ts`, `src/questions/store.test.ts`. Nothing outside `src/questions` imports them; check with `grep -rn "questions/" src`.
- Modify: `wrangler.jsonc` D1 comment ("memory and planning decisions" instead of "/grill-me questions").

**Interfaces — Produces** (exact; later tasks import these from `src/planning/decision-log.ts`):

```ts
export type CardChoice = { id: string; label: string };

export type CardWording = {
	question: string;
	context?: string;
	recommendation: string;
	choices?: CardChoice[]; // 2–5, unique ids
};

export type Decision = {
	// Exactly one of choiceId / customAnswer.
	choiceId?: string;
	customAnswer?: string;
	reasoning?: string;
	decidedBy: string; // Slack user id
	decidedByName: string;
	decidedAt: string; // ISO
};

export type CardRevision = CardWording & {
	cardId: string;
	revision: number;
	conversationId: string;
	channelId: string;
	threadTs: string;
	messageTs?: string;
	createdAt: string;
	decision?: Decision;
};

// One card: its latest revision is its state; earlier revisions are history.
export type Card = { label: string; latest: CardRevision; history: CardRevision[] };

export type NewCard = CardWording & {
	cardId: string;
	conversationId: string;
	channelId: string;
	threadTs: string;
	createdAt: string;
};

export type DecisionLog = {
	ask(card: NewCard): Promise<CardRevision>; // inserts revision 1
	setMessageTs(cardId: string, messageTs: string): Promise<void>; // every revision of the card
	latest(cardId: string): Promise<CardRevision | undefined>;
	// First wins: true only if `revision` is the card's latest and is undecided.
	decide(args: { cardId: string; revision: number; decision: Decision }): Promise<boolean>;
	// Inserts latest+1 with the same wording and no decision, only when latest is decided.
	// Undefined when it is not decided, or a concurrent reopen won.
	reopen(args: { cardId: string; createdAt: string }): Promise<CardRevision | undefined>;
	// Inserts latest+1 with new wording, only when latest is undecided.
	reword(
		args: { cardId: string; createdAt: string } & CardWording,
	): Promise<CardRevision | undefined>;
	// Every card in the conversation, ordered by creation; label `D1`, `D2`, ...
	listCards(conversationId: string): Promise<Card[]>;
};

export type PlanningSessions = {
	start(conversationId: string, at: string): Promise<void>; // upsert; clears ended_at
	end(conversationId: string, at: string): Promise<boolean>; // true if a session was active
	isActive(conversationId: string): Promise<boolean>;
};

export type PlanningStore = { log: DecisionLog; sessions: PlanningSessions };
```

`src/planning/d1-decision-log.ts` exports `createD1PlanningStore(db: D1Database): PlanningStore`, with `D1Database` from `src/memory/d1.ts`.

- [ ] **Step 1: Migration.**

```sql
-- Planning decisions (docs/superpowers/specs/2026-10-10-slack-planning-decisions-design.md).
-- Replaces the /grill-me voting tables from 0003, which were never wired to Slack.
DROP TABLE votes;
DROP TABLE questions;
DROP TABLE thread_participants;

-- One row per card revision. A card's state is its latest revision: decided when
-- that row has a decision, open otherwise. Earlier revisions are history.
CREATE TABLE card_revisions (
  card_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  conversation_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  message_ts TEXT,
  question TEXT NOT NULL,
  context TEXT,
  recommendation TEXT NOT NULL,
  choices TEXT, -- JSON array of { id, label }
  choice_id TEXT,
  custom_answer TEXT,
  reasoning TEXT,
  decided_by TEXT,
  decided_by_name TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (card_id, revision),
  CONSTRAINT card_choices CHECK (
    choices IS NULL OR
    (json_valid(choices) AND json_type(choices) = 'array' AND json_array_length(choices) >= 2)
  ),
  -- Undecided: every decision column empty. Decided: actor and time, and exactly
  -- one of a listed choice or a custom answer.
  CONSTRAINT card_decision CHECK (
    (decided_at IS NULL AND decided_by IS NULL AND decided_by_name IS NULL
      AND choice_id IS NULL AND custom_answer IS NULL AND reasoning IS NULL) OR
    (decided_at IS NOT NULL AND decided_by IS NOT NULL AND decided_by_name IS NOT NULL
      AND (choice_id IS NULL) <> (custom_answer IS NULL)
      AND (choice_id IS NULL OR choices IS NOT NULL))
  )
);

CREATE INDEX card_revisions_by_conversation ON card_revisions (conversation_id, created_at);

-- A thread in a planning session stays quiet: unmentioned replies are not dispatched.
CREATE TABLE planning_sessions (
  conversation_id TEXT PRIMARY KEY NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
```

- [ ] **Step 2: Write failing tests** in `src/planning/decision-log.test.ts`. Each test opens its own DB with `const store = createD1PlanningStore(await openTestDatabase());`. Cases:
  - `ask` then `latest` round-trips the wording (with and without `context`/`choices`); `revision` is 1 and `decision` is undefined.
  - `decide` on the latest open revision returns `true` and `latest` shows the decision. A second `decide` on the same revision returns `false`, and the first decision is unchanged (first wins / replay).
  - `decide` targeting revision 1 after `reword` returns `false` (stale modal), and revision 2 stays undecided.
  - `reopen` on a decided card returns revision 2 with the same wording and no decision. `listCards(...)[0].history[0].decision` keeps the earlier answer, actor and reasoning.
  - `reopen` on an open card returns `undefined` and inserts nothing.
  - Two concurrent reopens (`Promise.all`) create exactly one new revision. One result is `undefined`.
  - `reword` on a decided card returns `undefined`.
  - `setMessageTs` sets every revision's `messageTs`, and `reopen`/`reword` copy it forward.
  - `listCards` orders cards by creation and labels them `D1`, `D2`; it does not include another conversation's cards.
  - The DB refuses a decision with both a choice and a custom answer. Test this through raw SQL: `await expect(db.prepare('UPDATE card_revisions SET ...').run()).rejects.toThrow()`.
  - Sessions: `isActive` is false before `start`, true after `start`, and false after `end`. `end` returns false when nothing is active, and `start` after `end` reactivates.
- [ ] **Step 3:** Run `pnpm vitest run src/planning/decision-log.test.ts`. Expect FAIL (module missing).
- [ ] **Step 4: Implement** `d1-decision-log.ts`, following `src/questions/d1-store.ts`: a `SQL` object of named statements, a Valibot row schema validated on read, and `choices` parsed with a schema (2–5 items, unique ids) on write and on read. Key statements:

```ts
const SQL = {
	insertRevision: `INSERT INTO card_revisions
		(card_id, revision, conversation_id, channel_id, thread_ts, question, context, recommendation, choices, created_at)
		VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
	latest: `SELECT * FROM card_revisions WHERE card_id = ?1 ORDER BY revision DESC LIMIT 1`,
	setMessageTs: 'UPDATE card_revisions SET message_ts = ?2 WHERE card_id = ?1',
	decide: `UPDATE card_revisions
		SET choice_id = ?3, custom_answer = ?4, reasoning = ?5, decided_by = ?6, decided_by_name = ?7, decided_at = ?8
		WHERE card_id = ?1 AND revision = ?2 AND decided_at IS NULL
			AND revision = (SELECT MAX(revision) FROM card_revisions WHERE card_id = ?1)`,
	reopen: `INSERT INTO card_revisions
		(card_id, revision, conversation_id, channel_id, thread_ts, message_ts, question, context, recommendation, choices, created_at)
		SELECT card_id, revision + 1, conversation_id, channel_id, thread_ts, message_ts, question, context, recommendation, choices, ?2
		FROM card_revisions
		WHERE card_id = ?1 AND decided_at IS NOT NULL
			AND revision = (SELECT MAX(revision) FROM card_revisions WHERE card_id = ?1)`,
	reword: `INSERT INTO card_revisions
		(card_id, revision, conversation_id, channel_id, thread_ts, message_ts, question, context, recommendation, choices, created_at)
		SELECT card_id, revision + 1, conversation_id, channel_id, thread_ts, message_ts, ?3, ?4, ?5, ?6, ?2
		FROM card_revisions
		WHERE card_id = ?1 AND decided_at IS NULL
			AND revision = (SELECT MAX(revision) FROM card_revisions WHERE card_id = ?1)`,
	conversationRevisions: `SELECT * FROM card_revisions WHERE conversation_id = ?1 ORDER BY created_at, card_id, revision`,
	startSession: `INSERT INTO planning_sessions (conversation_id, started_at) VALUES (?1, ?2)
		ON CONFLICT (conversation_id) DO UPDATE SET started_at = ?2, ended_at = NULL`,
	endSession: 'UPDATE planning_sessions SET ended_at = ?2 WHERE conversation_id = ?1 AND ended_at IS NULL',
	activeSession: 'SELECT 1 AS active FROM planning_sessions WHERE conversation_id = ?1 AND ended_at IS NULL',
} as const;
```

  - `reopen` and `reword` return `undefined` when `meta.changes === 0`. They also return `undefined` when the run throws a primary-key collision (match `/UNIQUE|PRIMARY KEY/` in the message); rethrow anything else. On success they return `latest(cardId)`.
  - `listCards` groups rows by `card_id`. The order of first appearance in `conversationRevisions` follows revision 1's `created_at`, because later revisions are created later. `history` is every revision except the last, oldest first.
- [ ] **Step 5:** Run the tests and expect PASS. Delete `src/questions/`, run the full gate, then commit: `git commit -m "Replace question tables with a card-revision decision log"`.

### Task 2: Card, modal and summary rendering

**Files:**
- Create: `src/planning/card-blocks.ts`
- Test: `src/planning/card-blocks.test.ts`
- Modify: `src/channels/slack-reply.ts`. Widen `SlackBotClient` with `views: { open: WebClient['views']['open'] }` and `chat.postEphemeral: WebClient['chat']['postEphemeral']`. `WebClient` already has them, so `getSlackClient` is unchanged.
- Modify: `src/channels/testing/slack-api-stub.ts`. `decodeParam` also JSON-decodes `view`, so tests can assert on modal blocks.

**Interfaces:**
- Consumes: `Card`, `CardRevision`, `Decision` (Task 1).
- Produces:

```ts
export const DECIDE_ACTION = 'planning_decide';
export const REOPEN_ACTION = 'planning_reopen';
export const DECIDE_CALLBACK = 'planning_decide_modal';

export function answerText(revision: CardRevision): string | undefined; // choice label or custom answer
export function renderCard(card: Card): { text: string; blocks: KnownBlock[] };
export function decideModal(card: Card): View; // `View` from @slack/web-api
export type DecideSubmission = {
	cardId: string;
	revision: number;
	choiceId?: string;
	customAnswer?: string;
	reasoning?: string;
};
export function parseDecideSubmission(
	view: Record<string, unknown>,
): { ok: true; submission: DecideSubmission } | { ok: false; errors: Record<string, string> };
export function renderSummary(cards: Card[]): string; // Slack mrkdwn
```

- [ ] **Step 1: Write failing tests**, asserting on rendered text rather than block-by-block structure:
  - **Open card.** `text` contains `D2` and the question. Blocks contain the context and each choice as `A) Postgres`, plus `Recommended:` with the recommendation. There is one `actions` block whose button has `action_id: 'planning_decide'`, `value: cardId` and text `Decide…`.
  - **Decided card.** Shows `✅` with the choice label (or the custom answer), the reasoning, and `Decided by <@U1>` with a `<!date^…>` token. The only button is `planning_reopen`, and there is no Decide button.
  - **Reopened card** (`history` has a decided revision). An open card that is shown with `Previously: <answer> — <@U1>`.
  - **Escaping.** User text with `<`, `>` and `&` becomes `&lt;`, `&gt;` and `&amp;` in every mrkdwn field.
  - **`decideModal`.** `callback_id === 'planning_decide_modal'` and `JSON.parse(private_metadata)` equals `{ cardId, revision }`. With choices there is an optional `radio_buttons` input (block `choice`) plus an optional custom input (block `custom`). Without choices the `custom` input is required and there is no `choice` block. The `reasoning` multiline input is always optional. The title is at most 24 characters.
  - **`parseDecideSubmission`.**
    - A choice alone is ok.
    - A custom answer alone (trimmed) is ok.
    - Both → `errors.custom`.
    - Neither → `errors.choice` when the modal has a choice block, otherwise `errors.custom`.
    - Malformed `private_metadata` → `errors.reasoning`.
    - Blank reasoning becomes `undefined`.
  - **`renderSummary`.** Lists each card's label, question, current answer and decider. Reopened cards also list earlier answers with their deciders. Undecided cards appear under `Unresolved`. The text for no cards is `No decisions were recorded.`
- [ ] **Step 2:** Run `pnpm vitest run src/planning/card-blocks.test.ts` and expect FAIL.
- [ ] **Step 3: Implement.** Slack view state shape:
  - `view.state.values[blockId][actionId]`
  - radio: `.selected_option?.value`
  - text input: `.value`
  - Parse the view with Valibot (`v.object` with loose `state.values`).
  - Use `<!date^${seconds}^{date_short_pretty} at {time}|${iso}>` as in `slash-command.ts`.
  - Escape helper: `text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')`.
- [ ] **Step 4:** Run the tests and expect PASS. Run the full gate, then commit: `"Render planning decision cards, the decide modal and the summary"`.

### Task 3: Planning interaction handler

**Files:**
- Create: `src/channels/planning-interactions.ts`
- Test: `src/channels/planning-interactions.test.ts`

**Interfaces:**
- Consumes: `PlanningStore`, `Card`, `CardRevision` (Task 1); `renderCard`, `decideModal`, `parseDecideSubmission`, `answerText`, the action constants and `SlackBotClient.views/postEphemeral` (Task 2).
- Produces:

```ts
export type PlanningContinuation = {
	conversationId: string;
	channelId: string;
	threadTs: string;
	type: 'planning.decision' | 'planning.reopen';
	eventId: string; // idempotency key
	userId: string;
	body: string;
};

export type PlanningInteractionDeps = {
	store: PlanningStore;
	slack: SlackBotClient;
	workspaceTeamOf(conversationId: string): string; // channel.parseInstanceId(id).teamId
	continueConversation(continuation: PlanningContinuation): Promise<void>;
	// Runs after the response when the platform allows it (waitUntil); tests await it.
	defer(work: Promise<void>): Promise<void>;
	now(): Date;
};

export async function handlePlanningInteraction(
	payload: SlackInteractionPayload,
	deps: PlanningInteractionDeps,
): Promise<undefined | { response_action: 'errors'; errors: Record<string, string> }>;
```

Behavior:
- **`block_actions` with `action_id === DECIDE_ACTION`** (value = cardId).
  - Unknown card: return.
  - External user (`!payload.user.team_id || payload.user.team_id !== workspaceTeamOf(card.conversationId)`): `chat.postEphemeral` "Yappa only works for members of this workspace." to `payload.user.id` in the card's channel and thread, then return.
  - Card already decided: redraw it with `chat.update` (stale button) and return.
  - Otherwise: `views.open({ trigger_id, view: decideModal(card) })`.
- **`block_actions` with `REOPEN_ACTION`.**
  - External users are refused the same way.
  - Call `store.log.reopen`.
    - `undefined`: redraw the latest revision.
    - Otherwise: redraw, then `continueConversation` with `type: 'planning.reopen'`, `eventId: \`planning-reopen:${cardId}:${revision}\`` and a body such as `<@U2> reopened D3 "<question>". Earlier answer: "<answer>", decided by <@U1>[ (reasoning: "…")]. Ask what needs reconsidering; do not pick a new answer yourself.`
- **`view_submission` with `callback_id === DECIDE_CALLBACK`.**
  1. Parse the submission; on validation errors return `{ response_action: 'errors', errors }`.
  2. External users get `errors.reasoning = 'Yappa only works for members of this workspace.'`.
  3. Load `latest(cardId)`. An unknown card, or a `choiceId` not among `latest.choices`, gets `errors.reasoning = 'This card changed since you opened it…'`. Validate the choice against the revision the modal was opened at (`revision === latest.revision`); otherwise the answer is stale.
  4. `decide(...)` with `decidedByName = payload.user.name ?? payload.user.username ?? payload.user.id`.
     - `false`: defer the redraw of the latest revision and return `errors.reasoning = 'This card changed since you opened it: it was decided, reopened, or reworded. Close this and review the current card.'`
     - `true`: defer (redraw, then `continueConversation` with `type: 'planning.decision'`, `eventId: \`planning-decide:${cardId}:${revision}\``) and return `undefined`. The body is `<@U1> decided D3 "<question>": <answer>[. Reasoning: "…"]. This is their decision; do not replace it. Check list_decisions for contradictions with earlier decisions and call any out before asking the next question.`
- **Any other payload:** return `undefined`.
- **Redraws** call `chat.update({ channel, ts: messageTs, text, blocks })` from `renderCard(card)`, where `card` comes from `store.log.listCards(conversationId)` so the label and history are right. Skip the redraw when `messageTs` is missing.

- [ ] **Step 1: Write failing tests** with a real D1 store (`createD1PlanningStore(await openTestDatabase())`) and `stubSlackApi()`. Fakes:
  - `continueConversation` pushes into an array.
  - `defer` is `(work) => work`.
  - `workspaceTeamOf` returns `'T_HOME'`.
  - Seed cards with `store.log.ask` and `setMessageTs`.

  Build payloads as plain objects typed `SlackInteractionPayload`. Cases:
  - Decide click opens `views.open` with the card's current revision in `private_metadata`.
  - Decide click on a decided card makes no `views.open` call and one `chat.update`.
  - Choice submission records the decision, redraws, and continues once. The body contains the answer and `<@U1>`, and the idempotency key is `planning-decide:<id>:1`.
  - Custom-answer submission on a card without choices records `customAnswer`.
  - Submitting the same view twice: the second returns `response_action: 'errors'`, and there is exactly one continuation (Review Focus 2).
  - A submission opened at revision 1 after a `reword` returns errors with no decision written (Review Focus 1).
  - A tampered `choice` value returns errors with no write (Review Focus 3).
  - External user (`team_id: 'T_OTHER'` or missing) on decide click, reopen click and submit: refused, no write, no continuation (Review Focus 4).
  - Reopen on a decided card inserts revision 2, redraws with `Previously:`, and continues with type `planning.reopen`.
  - Reopen on an open card: no new revision, no continuation.
- [ ] **Step 2:** Run `pnpm vitest run src/channels/planning-interactions.test.ts` and expect FAIL.
- [ ] **Step 3:** Implement. **Step 4:** run the tests and expect PASS.
- [ ] **Step 5:** Run the full gate, then commit: `"Handle planning card Decide, modal submission, and Reopen"`.

### Task 4: Slack wiring: interactions route, continuation dispatch, quiet threads

**Files:**
- Modify: `src/channels/slack.ts`, `src/channels/admit.ts`, `src/observability.ts`, `src/app.ts`, `slack-app-manifest.yaml`
- Test: `src/channels/slack.test.ts`, `src/channels/admit.test.ts`

**Interfaces:**
- Consumes: `handlePlanningInteraction`, `PlanningContinuation` (Task 3), `PlanningStore` (Task 1).
- Produces:
  - `createSlackChannelForEnv(env, codexAuth, runtime?, planning?: PlanningStore)`. When `planning` is undefined, there are no interactions and no silence.
  - `decideAdmit` gains `planningActive: boolean` and the decision `{ kind: 'drop-planning' }`, which is also added to the `SlackAdmissionEvent.decision` union.

Behavior:
- **`decideAdmit`.** After the `drop-untracked` check and the external check: `if (args.signalType === 'slack.message' && args.planningActive) return { kind: 'drop-planning' };`. External users in a planning thread are still refused. Mentions are never dropped.
- **`admitThread`.** Read `planningActive` only when needed: `signalType === 'slack.message' && conversationExists && planning ? await planning.sessions.isActive(id) : false`. The `drop-planning` case emits a `slack_admission` event with outcome `dropped` and returns.
- **`interactions`** handler in `createSlackChannel`, present only when `planning` is set. It calls `handlePlanningInteraction(payload, deps)`:
  - `workspaceTeamOf: (id) => channel.parseInstanceId(id).teamId`
  - `slack: getSlackClient(env.SLACK_BOT_TOKEN)`
  - `now: () => new Date()`
  - `defer`: `(work) => { try { c.executionCtx.waitUntil(work); return Promise.resolve(); } catch { return work; } }`. Hono throws when there is no execution context.
  - `continueConversation`. Extract the dispatch part of `admitThread` into a helper both use: model route via `modelRouteForDispatch`, best-effort `loadThreadContext`, `buildSignalAttributes(eventId, userId, threadContext)` plus `modelRoute`. Dispatch with `runtime.dispatch(Coworker, { id, idempotencyKey: eventId, message: { kind: 'signal', type, body, attributes } })`, with **no** `initialData`: a continuation must not create a conversation, and Flue rejects a creating send whose initial data is absent.
- **`src/app.ts`.**
  - The route regex becomes `{events|commands|interactions}`.
  - Bindings gain `APP_DB?: D1Database`.
  - Pass `c.env?.APP_DB ? createD1PlanningStore(c.env.APP_DB) : undefined` as `planning`.
- **`slack-app-manifest.yaml`.** Under `settings`: `interactivity: { is_enabled: true, request_url: https://example.invalid/channels/slack/interactions }`.

- [ ] **Step 1: Write failing tests.**
  - `admit.test.ts`:
    - An unmentioned reply with `planningActive: true` and an existing conversation → `drop-planning`.
    - A mention with `planningActive: true` → `dispatch`.
    - An external reply with `planningActive: true` → `refuse-external`.
  - `slack.test.ts` (fake `PlanningStore` whose `sessions.isActive` returns the test's flag):
    - Active session: an unmentioned reply is not dispatched and nothing is posted.
    - The same reply after the session ends (flag false) is dispatched (Review Focus 5).
    - A mention during a session is dispatched.
  - `slack.test.ts`, using a real D1 store: a signed **interactions** request (form body `payload=<urlencoded JSON>`, signed like `signedEventRequest` with the `x-slack-*` headers and content type `application/x-www-form-urlencoded`) carrying a decide `view_submission` returns 200. It records the decision and calls `runtime.dispatch` once, without `initialData`, with `message.type === 'planning.decision'` and `attributes.modelRoute` set.
- [ ] **Step 2:** Run the tests and expect FAIL. **Step 3:** implement. **Step 4:** run the tests and expect PASS.
- [ ] **Step 5:** Run the full gate, then commit: `"Route Slack interactions and keep planning threads quiet"`.

### Task 5: Planning tools, session start and the reply guard

**Files:**
- Create: `src/planning/planning-store.ts` (process-wide holder)
- Create: `src/agents/planning-tools.ts`
- Test: `src/agents/planning-tools.test.ts`, `src/agents/coworker.test.ts`
- Modify: `src/cloudflare.ts`, `src/agents/coworker.ts`

**Interfaces:**
- Consumes: Task 1 store, Task 2 `renderCard`/`renderSummary`.
- Produces:

```ts
// src/planning/planning-store.ts
export function setPlanningStore(store: PlanningStore | undefined): void;
export function planningStore(): PlanningStore | undefined;
export const PLANNING_SKILL = 'grill-me';

// src/agents/planning-tools.ts
export function planningTools(args: {
	conversationId: string;
	channelId: string;
	threadTs: string;
	token?: string;
	store: PlanningStore;
	now?: () => Date;
	newId?: () => string;
}): ToolDefinition[]; // ask_decision, reword_decision, list_decisions, end_planning

export const PLANNING_REPLY_TOOLS: ReadonlySet<string>; // ask_decision, end_planning
```

Tools (Valibot inputs; descriptions state the rule each one enforces):
- **`ask_decision`** `{ question, context?, recommendation, choices?: { id, label }[] (2–5, unique ids) }`.
  - Inserts revision 1 with `newId()` as the cardId, then posts `renderCard` in the thread with `chat.postMessage` and `setMessageTs`.
  - Returns `{ label, cardId, posted, ts }`.
  - Description: "Post one decision card. People answer only with its Decide button; never treat thread replies as answers. Ask one question at a time."
  - Without a token it returns `posted: false` and still records the card, like `reply_in_slack_thread`.
- **`reword_decision`** `{ card: 'D3', question, context?, recommendation, choices? }`.
  - Resolves the label through `listCards` and calls `reword`, then `chat.update`s the message.
  - On a decided card it returns an error output telling the model to ask people to Reopen it instead. Output: `{ ok: false, reason }`; don't throw.
- **`list_decisions`** `{}`. Returns every card as `{ label, question, context, recommendation, choices, state: 'decided' | 'open', answer, reasoning, decidedBy, decidedByName, decidedAt, earlier: [{ answer, decidedBy, decidedAt, reasoning }] }`.
- **`end_planning`** `{}`. Posts `renderSummary(listCards)` in the thread, calls `sessions.end`, and returns `{ summary, posted }`. Description: "End the planning session when people ask to stop or no questions remain. Posts the decision summary and returns the thread to normal replies."

In `coworker.ts`:
- After `replyInThread`, mount the planning tools when the holder has a store: `const planning = planningStore(); if (planning) for (const tool of planningTools({ conversationId: props.id, channelId: data.channelId, threadTs: data.threadTs, token: agentEnv.SLACK_BOT_TOKEN, store: planning })) useTool(tool);`
- `hasSuccessfulSlackReply` also accepts a non-error call to any tool in `PLANNING_REPLY_TOOLS`, because a posted card or summary reaches the thread.
- In the module `observe` callback, before the card mapping: `if (event.type === 'tool_start' && event.toolName === 'activate_skill' && event.args?.name === PLANNING_SKILL) await planningStore()?.sessions.start(context.id, new Date().toISOString());`. Check the args with `v.is(v.object({ name: v.string() }), event.args)`. Keep the run-card behavior identical.
- Add `STEP_BY_TOOL` entries in `run-card.ts`: `ask_decision: 'Posting a decision card'`, `reword_decision: 'Rewording a decision card'`, `list_decisions: 'Reading decisions'`, `end_planning: 'Summarizing decisions'`.

In `cloudflare.ts`: `setPlanningStore(createD1PlanningStore(env.APP_DB));`, with a comment that `flue run` never loads this file, so planning tools are absent there.

- [ ] **Step 1: Write failing tests.**
  - `planning-tools.test.ts` uses a real D1 store and `stubSlackApi()`, and calls each tool's `run({ data })`. Check how `defineTool` exposes `run` in `src/agents/github-tools.test.ts` and copy that pattern. Cases:
    - `ask_decision` stores revision 1, posts blocks with a Decide button, and saves the message ts.
    - `reword_decision` on `D1` makes revision 2 and calls `chat.update`.
    - `reword_decision` on a decided card returns `ok: false` and makes no new revision.
    - `list_decisions` reports decided/open state and `earlier` answers after a reopen.
    - `end_planning` posts the summary and makes the session inactive.
  - `coworker.test.ts`: `hasSuccessfulSlackReply([{ tool: 'ask_decision', isError: false }])` is true; `[{ tool: 'list_decisions', isError: false }]` is false.
- [ ] **Step 2:** Run the tests and expect FAIL. **Step 3:** implement. **Step 4:** run the tests and expect PASS.
- [ ] **Step 5:** Run the full gate, then commit: `"Give the Coworker planning decision tools"`.

### Task 6: Rewrite the grill-me skill for decision cards

**Files:**
- Modify: `src/skills/grill-me/SKILL.md`

Keep the frontmatter `name` and `license`/`metadata`. Update `description` so it still triggers on grill, stress-test and planning requests. The body must say:
- **Design tree and frontier.** Keep the existing frontier idea.
- **One question at a time.** Ask with `ask_decision`, never as a plain message. Give a recommendation, and choices only when the decision is genuinely discrete.
- **Facts are your job; decisions are theirs.** Keep the existing paragraph and its read-only lookups.
- **People decide only with the Decide button.** Replies are discussion. Never treat a reply as an answer, and don't respond to unmentioned replies (you won't receive them). A mention asks you to research, clarify, or revise a question (`reword_decision` for open cards); it doesn't record a decision.
- **When a `planning.decision` signal arrives:** the answer is final and you may not substitute another. Call `list_decisions` and check the new answer against earlier decisions. If it contradicts one, say which card and how, and ask whether to reopen it, before moving on. Then ask a follow-up or the next frontier question.
- **When a `planning.reopen` signal arrives:** explain what needs reconsidering, and reword the card if the question should change. Don't choose an answer.
- **Planning only.** No edits, commits, checkpoints or pull requests. You may keep notes in `plan.md` in the sandbox and cite card labels; the decision log wins over the notes.
- **Finish.** When the frontier is empty, or someone asks to stop, call `end_planning`. Offer next steps but take none until asked.
- If the invocation names no topic, the first question (a card without choices) asks what to plan.

- [ ] **Step 1:** Edit the file. **Step 2:** run `pnpm run build`; expect success, since Flue validates the skill frontmatter.
- [ ] **Step 3:** Run the full gate, then commit: `"Rewrite grill-me for decision cards"`.

### Task 7: Docs, ADR, superseded markers

**Files:**
- Create: `docs/adr/0023-reversible-planning-decisions.md`
- Modify:
  - `docs/adr/README.md`: add a 0023 row. Amend the 0019 row to say app-callback controls are implemented for planning cards.
  - `SLACK_AGENT_SPEC.md`:
    - §4.1: add the interactivity route.
    - Add a "Planning decisions (2026-10-10)" section after "Conversational intent": the decision log in D1, quiet planning sessions, Decide/Reopen, the tools, and the "decisions are saved before dispatch" rule.
  - `CONTEXT.md`: add **Planning Session**, **Decision Card** and **Decision Log** entries near **Skill**.
  - `AGENTS.md`:
    - Replace the `src/questions/` line with `src/planning/` (decision log, sessions, card blocks, store holder) and `src/channels/planning-interactions.ts`.
    - Say the Slack ingress line now covers interactions and planning silence.
  - `README.md`: the Slack app setup gains the interactivity request URL `/channels/slack/interactions`, plus a short `/grill-me` planning section. Read it first and match its style.
  - `docs/superpowers/specs/2026-10-04-skills-and-grill-me-design.md` and `docs/superpowers/plans/2026-10-04-skills-and-grill-me.md`: in the status line, mark the voting, solo/group, Submit, participant and question-controls phases superseded by `2026-10-10-slack-planning-decisions-design.md`.

The ADR covers:
- **Context:** voting and quorum were rejected as too heavy.
- **Decision:**
  - the D1 card-revision log is authoritative, with first-wins conditional updates;
  - the modal is the only way to answer;
  - planning sessions are quiet;
  - reopen and reword insert revisions;
  - session state lives in its own table;
  - no Retry button.
- **Consequences:**
  - a contradiction check is a model instruction, not a guarantee;
  - Slack must have interactivity enabled.
- **Alternatives:**
  - voting / quorum;
  - parsing replies as answers;
  - storing decisions in Coworker state, rejected because ingress needs session state and the log must outlive the Durable Object.

- [ ] **Step 1:** Write the ADR and doc edits. **Step 2:** run `pnpm run fmt:check` and the full gate. **Step 3:** commit: `"Document planning decisions (ADR 0023)"`.
