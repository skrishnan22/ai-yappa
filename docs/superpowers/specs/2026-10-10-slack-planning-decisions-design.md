# Slack planning with reversible decisions

Date: 2026-10-10
Status: Implemented on `t3code/slack-planning-decisions` (plan `docs/superpowers/plans/2026-10-10-slack-planning-decisions.md`, ADR 0023). Live Slack acceptance pending.

This replaces the question/voting workflow in
`2026-10-04-skills-and-grill-me-design.md` and the remaining question-controls,
submission, and listening phases of its implementation plan. Existing skill
invocation behavior remains applicable. Reconcile the implementation source of
truth, glossary, and ADRs when planning the implementation.

Depends on `2026-10-10-channel-member-access-design.md`: any human member of a
bound channel may use Yappa, so this spec has no separate permission rule for
deciding or reopening.

## Goal

Let a team develop a plan in Slack through discussion and explicit, attributed,
reversible decisions. Yappa asks useful questions and recommends answers; people
own decisions. The experience draws on Chopin's separation of conversation,
document, and decision history: https://githubnext.com/projects/chopin/.

## Starting and ending

A planning session starts the way the existing skill spec describes: an explicit
`/grill-me` in a mention, or the model activating the skill because the request
matches its description. Ending planning, by request or because no questions
remain, posts a summary and restores the thread's ordinary behavior.

## Interaction

The same behavior applies to one person and a group. Ordinary replies are
discussion and never answer a card or start an agent run during a planning
session. Silence continues between questions until the session ends; it does not
depend on an open card or participant count. An @mention invites Yappa to
research, clarify, revise a question, or help with the plan, without recording a
decision.

Yappa normally asks one question at a time. Each decision card has a stable ID,
question, necessary context, recommendation, and optional choices. **Decide…**
opens a Slack modal where a person selects an option or writes a custom answer,
with optional reasoning. Questions without choices use the same custom-answer
field. The modal is the only way to answer; Yappa does not parse replies as
answers.

Submitting records the decision and immediately dispatches Yappa to continue.
There is no second Continue action, voting requirement, quorum, or solo/group
distinction. Yappa receives the exact answer, attribution, reasoning, and thread
discussion. It can ask a follow-up or move to the next question, but cannot
silently replace the submitted answer. Before moving on, it checks the decision
log and calls out any contradiction with earlier decisions. This is a model
instruction, not a guarantee.

An answered card keeps its question and answer visible, shows who decided and
when, and offers **Reopen**. "Decided by Maya" records Maya's choice; it does not
claim team consensus. Posting another question does not close an unresolved
card. Submissions always target a specific card, even if several remain open.

This experience is planning only: research, questions, decisions, and plan
notes. A decision does not by itself request code edits, commits, pull requests,
or deployment.

## Decision log

The decision log is authoritative. It lives in D1 (`APP_DB`) as one table of
card revisions and replaces the `questions`, `votes`, and `thread_participants`
tables from `0003_questions.sql`.

`card_revisions`, primary key `(card_id, revision)`:

- `conversation_id`, `channel_id`, `thread_ts`, `message_ts`
- the question as it read at that revision: `question`, `context`,
  `recommendation`, `choices` (optional JSON array)
- that revision's decision: `choice_id` or `custom_answer`, `reasoning`,
  `decided_by`, `decided_by_name`, `decided_at`; empty while open
- `created_at`

A card's state is its latest revision: decided if that row has a decision, open
otherwise. When a session ends, any card whose latest revision is undecided is
unresolved. Earlier revisions are the card's history. There is no status column
and no separate decisions table.

Operations:

- **Ask** inserts revision 1.
- **Decide** sets the decision on the revision the modal was opened at, only if
  that row is undecided. Zero changed rows means the card was already decided,
  reopened, or reworded since the modal opened, or the Slack event is a replay;
  the submitter is told to review the current card. The first submission wins.
- **Reopen** inserts revision n+1 with the same question and no decision. The
  previous revision keeps its answer, actor, timestamp, and reasoning. Concurrent
  reopens collide on the primary key; one wins.
- **Rewording** by Yappa also inserts a new revision, so a modal opened on the old
  wording is refused.

Reopening also dispatches Yappa to explain what needs reconsideration.

Readers:

- The card message is redrawn from the card's latest revision.
- Yappa reads the latest revision of every card in the conversation through a
  `list_decisions` tool, and receives the specific decision in the dispatch that
  a submission triggers.
- The end-of-session summary lists each card's current answer and who decided it,
  earlier answers for reopened cards, and unresolved cards.

Yappa may keep working notes in `plan.md` in its sandbox and cite card IDs there.
That file is scratch; when it disagrees with the log, the log wins.

## Failure

Decisions are saved before Yappa is dispatched. A failed run shows on the
existing run card, and mentioning Yappa resumes from the saved log. There is no
dedicated retry action.

## First delivery and acceptance

Out of scope for the first delivery: a published or shared planning document,
a History view beyond the summary, rich multiplayer editing, interactive
diagrams, preference voting, and automatic dependency tracking.

Verify the actual Slack experience: quiet discussion with one or several people;
an invited clarification; option and custom-answer submission; a decision by a
channel member who did not start the session; immediate continuation; concurrent
and stale submission; reopening and replacing an earlier decision; a flagged
contradiction with an earlier decision; a failed continuation resumed by a
mention; and restoring normal thread behavior when planning ends. Local tests do
not establish live acceptance.
