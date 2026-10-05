# Skills and `/grill-me`

Status: design approved in chat, pending spec review
Date: 2026-10-04

## Goal

The Coworker gains Agent Skills, invoked in Slack with `/<name>` in a mention. The first skill is `/grill-me`: the agent interviews a person or a group about a plan, one question at a time, until every decision is settled. A grill session must feel natural with several teammates in one thread, and it must not run the model on every reply.

## Background

- Flue supports skills natively. A `SKILL.md` import mounted with `useSkill(...)` adds one catalog line (name and description) to the system prompt. The model calls `activate_skill` to load the instructions. Flue also discovers `<cwd>/.agents/skills/*/SKILL.md` in the sandbox. The Coworker's cwd is the cloned repo, so repo skills already appear in its catalog.
- Today every unmentioned reply in a tracked thread dispatches a Submission, and `useAgentFinish` forces a `reply_in_slack_thread` call. With several people in a thread, the bot answers every message.
- Shipping products mostly answer only on @mention or on an explicit trigger. Devin defaults to silence. Model-based "who is this addressed to" detection is weak: one benchmark measured GPT-4o at 80.9% against an 80.1% chance level. This design uses explicit triggers and no classifier.
- Flue appends a message that arrives during a running response at the next turn boundary. No stale-reply guard is needed.
- `@flue/slack` already exposes a verified `/channels/slack/interactions` route. This project does not mount it yet.

## User-facing behavior

### Invoking a skill

```
@aiyappa /grill-me should we move session auth to the edge?
@aiyappa $model:luna /grill-me the billing migration plan
```

- **Automatic.** The Coworker mounts every deployment skill with `useSkill`, so its description sits in the system prompt's catalog and the model calls `activate_skill` when a request matches. `grill-me` describes itself for requests to be grilled, stress-tested, or interviewed about a plan, so "grill me on X" works without the slash.
- **Explicit.** `/<name>` on any `app_mention` (not unmentioned replies) invokes a registered skill. A `useAgentStart` hook appends a `skill_invoked` signal telling the model to call `activate_skill` for it before anything else. A `useAgentFinish` guard, the same pattern that forces `reply_in_slack_thread`, sends the model back if it stops without a successful `activate_skill` call per invoked skill.
- Why not inject the body directly, as Claude Code, Codex, and pi do: Flue's `SKILL.md` import is an opaque reference with no text, its build rejects `SKILL.md?raw`, and neither the hook context nor the harness exposes skill activation to app code (checked against Flue 2.2.2 and its issues; #297 asked for pluggable skill loading and was closed). The guarded instruction keeps the Agent Skills convention and Flue's own loading at the cost of one tool call.
- Only registered names count. `/usr/bin`, URLs, `/grill-me/notes`, code spans, and unknown names stay ordinary text, and the text is not rewritten. Several skills in one mention are all invoked.
- `$model:` and `$effort:` keep working alongside it (ADR 0021). The Slack ingress does not parse skills.
- Known limit: Flue fails the session when a bound repo has `.agents/skills/<name>` with a deployment skill's name. Not handled until a bound repo ships one.

### A grill session

1. Someone sends `@aiyappa /grill-me <topic>`.
2. The agent posts **one question** with `ask_question`. The question is one of two kinds:
   - **Choice:** 2–5 options. One option may be marked ⭐ recommended, with a reason.
   - **Open:** no options; people answer in the thread.

   Every question carries a ➡️ recommended answer.
3. **Participants** belong to the thread. The list starts with the conversation starter and every human who posted in the thread before the first question. Anyone who later posts a reply, mentions the bot, or clicks a question button joins. One participant means **solo**; two or more means **group**. A thread never returns from group to solo.
4. **Solo:** the question has no Submit button. A click or an unmentioned reply from the participant submits immediately.
5. **Group:** the question has a Submit button.
   - Clicks are votes, one per person. Clicking again changes the vote. A vote never runs the model; it redraws the votes line on the question message.
   - Unmentioned replies are discussion. They are not dispatched.
   - **Submit** dispatches the Coworker once. The dispatch carries the question, the tally with voter names, and the Thread Context, which includes all discussion since the question was posted.
   - Submit with no votes is valid. The agent reads the discussion.
6. Any allowlisted invoker may Submit. Anyone may vote.
7. An **@mention** always dispatches immediately, in solo or group mode. The open question stays open.
8. If a newcomer posts or clicks on a solo question, the thread becomes group and the open question is redrawn with a Submit button. **That event does not submit the question.**
9. After a Submit, the agent either:
   - asks a follow-up, which is a new question, for example a narrower question that names the people who disagreed; or
   - moves to the next frontier question.

   Each grill turn ends with a new `ask_question` call or the final summary. A grill turn should not end in plain text, because the thread falls back to its normal behavior while no question is open.
10. **Finish:** when the frontier is empty, the agent posts a decision summary in an ordinary reply. The summary lists each question, its decision, and who decided it. The agent then asks the group to confirm, and offers next steps (spec, issue) without taking them.
11. `@aiyappa stop grilling`, or any request to stop, makes the agent call `close_question` and confirm.

### Question message

```
❓ Q4 · Where should session state live?
<body>
[A: KV]  [B: Durable Object ⭐]  [C: D1]                [Submit →]   ← Submit only in group
➡️ B: one writer per session, no race on refresh.
Votes: maya → B · raj → A
```

Names are plain display names, never `<@user>` mentions, so redraws notify no one. They come from the interaction payload's `user.name` and are stored with the vote, so no `users:read` scope is needed.

After Submit, the message is redrawn closed: buttons removed, with "Submitted by maya · B (maya, sk) · A (raj)". An open question shows "Reply in thread" in place of the option buttons.

## Components

### Skill registry and the `grill-me` skill

- `src/skills/grill-me/SKILL.md`: one skill. Its header credits `mattpocock/skills` `productivity/grilling` (MIT).
- `src/skills/index.ts` imports each `SKILL.md` into a `skills` list. Adding a skill is a folder plus one import line: Flue packages only static `SKILL.md` imports, so a glob does not work.

`grill-me` keeps the core of `grilling`:
- **Design tree.** The plan is a tree in which every decision branches into the decisions that depend on it.
- **Frontier.** The frontier is the set of decisions whose prerequisites are settled. The agent never asks a question whose answer depends on an open one.
- **Recommendation.** Every question carries a recommended answer.
- **Facts vs. decisions.** Facts are the agent's job and decisions belong to the users. The agent looks up what it can find.
- **Done.** The session is done when the frontier is empty. The agent does not act until the users confirm shared understanding.

Changes for Slack:
1. **One question per round.** The agent asks the frontier question that unblocks the most other decisions. It recomputes the frontier after every answer. This replaces `grilling`'s batched rounds, because batched questions fragment discussion in a group thread.
2. Post every question with `ask_question`. Use choices only for discrete decisions.
3. **Lookups.** Look up facts with the agent's own read-only tools (repo, `web_search`). The Coworker has no subagents.
4. **Votes are evidence.**
   - Credit decisions to the people who made them.
   - Never settle a split by majority without saying so. A real split becomes a narrower follow-up question that names the people who disagreed.
5. **Unclear answers.** If a Submit has no clear answer, the question stays on the frontier and the agent says what is unclear.
6. **No changes.** A grill session is discussion only: no edits, commits, checkpoints, or PRs.
7. **Ending turns.** Every turn ends with `ask_question` or the final summary.

### `ask_question` and `close_question` tools

Both tools are bound to the conversation's trusted `channelId`, `threadTs`, and conversation id, like `reply_in_slack_thread`. They are mounted in every conversation.

- `ask_question({ title, body?, recommendation, choices?: { label, recommended? }[] })` posts the owner-rendered Block Kit message.
  - It closes any question still open in the thread, so each thread has at most one open question.
  - On the first question in a thread, it seeds participants.
  - It inserts the question row and returns `{ questionId, posted }`.
  - Without `SLACK_BOT_TOKEN`, it returns the rendered message with `posted: false`, as the reply tool does.
  - Limits:
    - 2–5 choices;
    - button label at most 75 characters;
    - at most one `recommended`.
- `close_question()` closes the open question without dispatching and redraws it as "Closed".
- `hasSuccessfulSlackReply` also accepts a successful `ask_question` call. A posted question is the turn's reply.

### Question store (D1)

This is the first D1 binding, `APP_DB`, with migrations in `migrations/`. The binding has a general name so the planned memory tables can share it.

```sql
CREATE TABLE thread_participants (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  message_ts TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('choice', 'open')),
  title TEXT NOT NULL,
  body TEXT,
  recommendation TEXT NOT NULL,
  choices TEXT,                 -- JSON array of { id, label, recommended }
  status TEXT NOT NULL CHECK (status IN ('open', 'submitted', 'closed')),
  submitted_by TEXT,
  submitted_by_name TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE UNIQUE INDEX one_open_question ON questions (conversation_id) WHERE status = 'open';

CREATE TABLE votes (
  question_id TEXT NOT NULL REFERENCES questions(id),
  user_id TEXT NOT NULL,
  choice_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (question_id, user_id)
);
```

- **Vote:** `INSERT … ON CONFLICT (question_id, user_id) DO UPDATE SET choice_id = …`.
- **Submit, first wins:** `UPDATE questions SET status = 'submitted', submitted_by = ? WHERE id = ? AND status = 'open'`. Exactly one changed row means this caller won.
- **Mode:** derived on read as `COUNT(thread_participants) > 1`. It is not stored.
- Code accesses the store through a `QuestionStore` interface. Tests use an in-memory fake; production uses D1 from `cloudflare:workers` `env`.

D1 was chosen over the alternatives:
- **KV** is eventually consistent and has no atomic operations. Concurrent votes would be lost, first-wins Submit would be impossible, and the ingress "open question?" check could read stale data.
- **A per-thread Durable Object** would serialize redraws. D1 is queryable across threads and needs no new class or migration. Its one cost is a cosmetic redraw race (see Failure cases).

### Interactions route

`createSlackChannel({ interactions })` handles `block_actions` with these action ids:

- **`question_vote`**
  1. Upsert the participant (a newcomer may flip the thread to group).
  2. If the thread is solo and the voter is the only participant, treat the click as a submit.
  3. Otherwise upsert the vote and redraw the message.
- **`question_submit`**
  1. Check that the user is an allowlisted invoker.
  2. Run the first-wins update.
  3. Redraw the message closed.
  4. Dispatch the Coworker.

Dispatch on submit:
- signal type: `slack.question_submitted`
- idempotency key: `question-submit:<questionId>`
- body: the question, the decision or tally with voter ids, and who submitted
- attributes: `threadContext` from `loadThreadContext`, plus `userId` of the submitter

Ephemeral replies cover refusals:
- not allowlisted;
- already submitted by someone else;
- question closed;
- store unavailable.

The Slack app manifest gains `interactivity.is_enabled: true` with request URL `/channels/slack/interactions`. No new scopes are needed: `chat:write` covers `chat.update` and `chat.postEphemeral`.

### Ingress changes (`slack.ts`, `admit.ts`)

For a tracked thread, admission reads the open question and the participants for the conversation. A pure `decideQuestionAdmit(...)` then returns one of:

| Event | Open question? | Result |
|---|---|---|
| any | no | today's behavior |
| `app_mention` | yes | upsert participant; dispatch as today; question stays open |
| `message`, author is the only participant (solo) | yes | submit the question with the reply as the answer; dispatch `slack.question_submitted` |
| `message`, author is new | yes | upsert participant; the thread is now group; redraw with Submit; no dispatch |
| `message`, group | yes | no dispatch; record `slack_admission` outcome `listening` |

An unmentioned solo answer still requires an allowlisted author, the same rule as Submit.

## Failure cases

| Case | Behavior |
|---|---|
| Two Submits at once | First-wins update; the second gets an ephemeral "Already submitted by …" |
| Submit by someone not on the allowlist | Ephemeral refusal; their vote still counts |
| Click on a submitted or closed question | Ephemeral "This question is closed" (the buttons are already removed) |
| Concurrent votes redraw out of order | The votes line may briefly miss a vote. D1 is correct, and the next redraw and Submit both read D1 |
| Slack retries an interaction | Vote upsert is safe to repeat; Submit is guarded by first-wins and the dispatch idempotency key |
| D1 unavailable on a click | Ephemeral "Couldn't record that, try again"; no dispatch |
| D1 unavailable on the ingress check | Treat as no open question, which is today's behavior. Noisy beats silently dropping a message |
| `ask_question` fails to post | The tool returns the error to the model; the question row is not left open |
| The run after Submit fails | The question stays submitted; the run card shows the failure; recovery is an @mention ("retry", "reopen Q4") |
| `/grill-me` with no topic | The first question is open: "What should we grill?" |
| `/grill-me` with a question already open | The agent continues the current session |
| Abandoned session | Unmentioned replies stay silent while a question is open. An @mention brings the agent back; "stop grilling" closes the question |

## Testing

- `decideQuestionAdmit` (table-driven): no open question; mention; solo answer; newcomer joins solo; group discussion; author not allowlisted.
- Interactions handler against the in-memory `QuestionStore`:
  - vote upsert and vote change;
  - newcomer click flips a solo thread to group without submitting;
  - solo click submits;
  - first-wins Submit;
  - allowlist refusal;
  - closed question;
  - retried payload.
- `ask_question`:
  - closes a previously open question;
  - seeds participants;
  - enforces limits;
  - behaves correctly with `posted: false` and no token.
- Question block rendering:
  - choice vs. open;
  - solo vs. group;
  - votes line;
  - closed and submitted states.
- Skill invocation:
  - `/grill-me` matched with punctuation and case; paths, URLs, code spans, and unknown names ignored; several skills all invoked;
  - the finish guard needs one successful `activate_skill` per invoked skill.
- `hasSuccessfulSlackReply` accepts `ask_question`.
- D1 SQL smoke test with `wrangler d1 execute --local` against the migration: first-wins update and vote upsert.
- Manual check in real Slack:
  - solo session;
  - group session with two accounts, including a split vote and a newcomer joining partway through a solo question.

## Docs

- New ADR 0022, "Owner-rendered question controls". It amends ADR 0019 decision 3: app-callback buttons are allowed for owner-rendered `ask_question` messages, which have verified, authorized handlers. Model-authored Block Kit still rejects app-callback elements.
- `CONTEXT.md`:
  - define **Skill**, **Question**, **Participant**, and **Grill Session**;
  - amend **Agent Invocation**: Submit is an invocation, and unmentioned replies do not continue the conversation while a question is open.
- `AGENTS.md` layout gains `src/skills/`, the interactions route, `APP_DB`, and `migrations/`.
- `docs/adr/README.md` row for 0022.

## Out of scope (deferred)

- A cheap-model or Jev speak/stay-silent gate for free-text replies, or silent-by-default threads.
- Mention-only behavior for all threads, not just threads with an open question.
- A nudge when nobody presses Submit.
- A live decision log edited in place. The final summary covers this need.
- `/name` invocation for repo skills under `.agents/skills/`. They are still auto-discovered.
- Handling a repo skill with a deployment skill's name (Flue fails the session today).
- Skills beyond `grill-me`.
- Cross-thread decision queries.
- A maximum wait or timeout on an open question. Until then, an open question waits for Submit; an @mention continues the conversation.
