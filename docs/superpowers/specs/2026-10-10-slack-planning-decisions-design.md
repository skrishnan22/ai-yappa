# Slack planning with reversible decisions

Date: 2026-10-10
Status: UX agreed in chat; brief spec ready for review. Not implemented.

This replaces the question/voting workflow in
`2026-10-04-skills-and-grill-me-design.md` and the remaining question-controls,
submission, and listening phases of its implementation plan. Existing skill
invocation behavior remains applicable. Reconcile the implementation source of
truth, glossary, and ADRs when planning the implementation.

## Goal

Let a team develop a plan in Slack through discussion and explicit, attributed,
reversible decisions. Yappa asks useful questions and recommends answers; people
own decisions. The experience draws on Chopin's separation of conversation,
document, and decision history: https://githubnext.com/projects/chopin/.

## Interaction

The same behavior applies to one person and a group. Ordinary replies are
discussion and never implicitly answer a card or start an agent run during a
planning session. Silence continues between questions until the session ends;
it does not depend on an open card or participant count. An @mention invites
Yappa to research, clarify, revise a question, or help with the plan, without
automatically recording a decision.

Yappa normally asks one question at a time. Each decision card has a stable ID,
question, necessary context, recommendation, and optional choices. Free-text
answers are always supported. **Decide…** opens a Slack modal where a person
selects an option or writes a custom answer, with optional reasoning. Questions
without choices use the same custom-answer flow.

Submitting records the decision and immediately invites Yappa to update the
plan and continue. There is no second Continue action, voting requirement,
quorum, or solo/group distinction. Yappa receives the exact answer, attribution,
reasoning, and thread discussion. It can ask a follow-up, identify a conflict,
or move to the next question, but cannot silently replace the submitted answer.

An answered card keeps its question and answer visible, shows who decided and
when, and offers **Reopen** and **History**. "Decided by Maya" records Maya's
choice; it does not claim team consensus. Posting another question does not
automatically close an unresolved card. Submissions always target a specific
card, even if several remain open.

## Participation and scope

Any human with access to the planning session's Slack thread may decide or
reopen a card, including someone outside the existing agent-invoker allowlist.
Such actions may trigger planning work in that existing session. They do not
grant permission to start unrelated sessions or perform implementation work.
Ordinary @mentions retain the existing invoker policy.

This experience is planning only: research, questions, decisions, and updates
to the planning artifact. A decision submission does not authorize code edits,
commits, pull requests, deployment, or implementation. Ending planning produces
a summary of the plan, decisions, and remaining unresolved questions. Explicit
session completion or cancellation restores the thread's ordinary behavior.

## Revisions and recovery

Reopening preserves the previous answer, actor, timestamp, and reasoning in
history, marks the card unresolved, and invites Yappa to explain what needs
reconsideration. A replacement submission creates another attributed decision
revision and continues planning. Dependent decisions remain recorded and are
flagged for review rather than automatically erased. The plan must visibly
identify affected conclusions as unresolved or needing review until reconciled.

The first submission for the current open card revision wins. Concurrent
submissions cannot overwrite it; other submitters see the saved decision and
may reopen it. If the question or options changed while a modal was open, its
submission is refused with a request to review the current card. Replayed Slack
events cannot create another decision or duplicate the same continuation.

Saving a decision and successfully continuing the agent are distinct outcomes.
If continuation fails, keep the decision and display **Decision saved; planning
update failed**, with a Retry action that resumes from the saved revision.
Reopening is subject to the same durable recording and continuation recovery.

Decision history is authoritative independently of generated prose. Plan
rewrites must preserve human choices and link conclusions to their decision
cards. Reversibility changes planning records; it does not undo external work.

## First delivery and acceptance

Use Slack cards and modals, a durable decision history, and one durable planning
artifact per session. Its publication surface is chosen during implementation
planning; rich multiplayer editing, interactive diagrams, preference voting,
and automatic dependency cascades are outside the first delivery.

Verify the actual Slack experience: quiet discussion with one or several people;
an invited clarification; option and custom-answer submission; a non-allowlisted
participant deciding; immediate continuation; concurrent and stale submission;
reopening and replacing an earlier decision; preserved attribution after plan
rewrites; retry after a saved decision's continuation fails; and restoring normal
thread behavior when planning ends. Local tests do not establish live acceptance.
