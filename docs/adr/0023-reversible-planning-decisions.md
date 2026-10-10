# Reversible planning decisions

Status: accepted. Replaces the voting, quorum, and Submit design in `docs/superpowers/specs/2026-10-04-skills-and-grill-me-design.md`.

A planning session records attributed decisions on cards in a D1 log. Anyone in the channel can decide a card, and a decision can be reopened.

## Context

The earlier `/grill-me` design had participants, votes, a quorum, solo and group modes, and a Submit step. Nothing past the tables was wired to Slack. The team judged the model too heavy: planning in a thread needs one clear answer per question and a record of who gave it, not a ballot. Access is already settled by ADR 0022, so deciding needs no rule of its own.

## Decision

1. **The D1 card-revision log is authoritative.** The `card_revisions` table, primary key `(card_id, revision)`, holds each card's wording and decision per revision. A card's state is its latest revision. Deciding is a conditional update: it sets the decision on the revision the modal was opened at, only if that row is still undecided. The first submission wins; zero changed rows means the card moved on, and the submitter is told to review it.
2. **The modal is the only way to answer.** **Decide** opens a Slack modal with the choices or a custom answer, and optional reasoning. Yappa never parses a thread reply as an answer.
3. **Planning sessions are quiet.** While a session is active, unmentioned replies in the thread are not dispatched. Mentions and card interactions still reach Yappa. `end_planning` restores normal replies.
4. **Reopen and reword insert revisions.** Reopen adds revision n+1 with the same question and no decision, so the earlier answer stays as history. Reword also adds a revision, so a modal opened on the old wording is refused. Reword applies only to open cards and Reopen only to decided ones.
5. **Session state lives in its own table.** `planning_sessions` is a D1 table, started when the model activates `grill-me` or asks a card outside a session, and ended by `end_planning`. Ingress reads it before it dispatches, and Coworker state is out of its reach.
6. **No Retry button.** Decisions are saved before Yappa is dispatched. A failed run shows on the run card, and a mention resumes from the saved log.

A decision made after a session ends is still recorded and dispatched, because a card always targets itself. Interactions from users outside the conversation's workspace are refused by comparing `payload.user.team_id` with the conversation's team; a missing team fails closed.

## Consequences

- The check for contradiction with earlier decisions is a model instruction in the skill, not a guarantee.
- The Slack app must have interactivity enabled, with the request URL `/channels/slack/interactions`. Without it, Decide and Reopen do nothing.
- Interactions write to D1 before they respond. The redraw and the dispatch run after the response, and a failed redraw is logged without stopping the dispatch.
- Cards are shown as D1, D2, and so on; the stored card id is a UUID.
- The `questions`, `votes`, and `thread_participants` tables are dropped by migration 0004. They were never used.

## Alternatives

- **Voting and quorum:** more state and more steps for a consensus the team did not ask for. "Decided by Maya" records a choice, not agreement.
- **Parsing replies as answers:** guesses at intent in a noisy thread, and cannot attribute a decision to a specific card.
- **Decisions in Coworker state:** ingress needs session state before it dispatches, and the log must outlive the Durable Object.
