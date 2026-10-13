# Scheduled automations

Date: 2026-10-13
Status: Agreed in chat; spec ready for review. Not implemented.
Depends on: `2026-10-13-repo-optional-conversations-design.md` (DMs, optional repo).

## Goal

Users create recurring or one-off work for Yappa from Slack:

- "Every weekday 9am, post yesterday's merged PRs in acme/api to #eng."
- "Every morning, DM me a digest of the latest AI news."
- "Remind me Thursday 6pm to book tickets."

The model only proposes. Every state change to an automation goes through
deterministic code that a human triggers or the scheduler runs, with
authorization checked in code.

Out of scope: event triggers (GitHub webhooks, the PR babysitter) are the next
spec and will reuse `startConversation`. Slack attention triage needs a user
token and comes after.

## Concepts

- **Automation:** a stored instruction plus a schedule and a destination.
  - `kind: 'agent'` starts a Coworker conversation on each fire.
  - `kind: 'reminder'` posts its stored text; no model, no sandbox.
- **Scope:**
  - `personal`: delivered to the owner's DM; visible only to the owner.
  - `channel`: delivered to a channel the bot is in; visible to its members.
- **Owner:** the Slack user who created it. Runs are attributed to the owner
  and use the owner's preferences. GitHub calls still go through the single
  GitHub App.
- **Run:** one fire of an automation. Each agent run is a fresh conversation
  in a new top-level message. A thread reply continues that run like any
  conversation.

## Storage

D1 migration `0005_automations.sql`:

- `automations`
  - `id`, `kind`, `owner_user_id`, `scope`, `destination_channel_id`
  - `repo` (nullable), `title`, `prompt`
  - `schedule`: a 5-field cron pattern, or null for a one-off
  - `run_at`: the one-off instant (UTC ISO), null for recurring
  - `timezone`: IANA
  - `next_run_at` (UTC ISO, indexed with `status`), `last_run_at`
  - `status`: `active | paused | blocked | completed | deleted`
  - `consecutive_failures`, `created_at`, `updated_at`
- `automation_runs`
  - `automation_id`, `fire_time` (unique together; the dedupe key)
  - `status`: `dispatched | posted | failed | succeeded`
  - `conversation_id`, `submission_id`, `reason`, `created_at`
  - Kept after the automation is deleted.
- `automation_drafts`
  - The proposed automation fields plus `drafted_by`, `channel_id`,
    `thread_ts`, `card_ts`, `consumed_at`.
  - A Slack button value cannot hold a long prompt, so cards carry the draft id.

Store module in `src/automations/store.ts`, following `src/planning/`, with a
holder set by the Worker entry the way the planning store is.

## Scheduling

Cloudflare Cron Triggers are static (declared in `wrangler.jsonc`, UTC,
changed only by deploy), so they cannot be per-user. One heartbeat cron
`* * * * *` wakes the Worker; user schedules are rows in D1.

`next_run_at` is precomputed so each tick is one indexed query
(`status = 'active' AND next_run_at <= now`), a late or skipped tick still
finds due rows, and timezone and DST conversion happen once, when the next
run is computed. [croner](https://www.npmjs.com/package/croner) computes the
next run (`new Cron(pattern, { timezone }).nextRun(after)`) and validates
patterns. Only its calculator is used, never its timers.

`src/automations/scheduler.ts`, called from the `scheduled` handler in
`src/cloudflare.ts`. For each due row, in order:

1. **Claim.** Insert `automation_runs(automation_id, fire_time = next_run_at)`.
   A conflict means another tick took it; skip.
2. **Advance.** Recurring: `next_run_at = nextRun(now)`, so missed fires
   collapse to one run with no backlog replay. One-off: `status = completed`.
3. **Re-authorize.** The owner is still a non-deleted workspace member
   (`users.info`). For channel scope, the bot can still post there. Otherwise
   set `blocked`, record the run `failed` with the reason, and DM the owner.
4. **Fire.**
   - `reminder`: post the text to the destination, mentioning the owner for a
     personal reminder. Run `posted`.
   - `agent`: `startConversation` (below). Run `dispatched` with its
     conversation and submission ids.

The tick dispatches and returns. `dispatch` resolves once the message is
queued, so a batch fits the cron CPU budget.

No rate or concurrency guards in v1: no overlap check, hourly cap, per-owner
limit, or minimum interval. Add them in the scheduler if usage demands it;
the schema does not change.

## Starting a conversation

Extract the inline `runtime.dispatch(Coworker, …)` from
`src/channels/slack.ts` into `startConversation` in
`src/conversations/start.ts`. Slack mentions, DMs, and automations all call
it. Webhooks will too.

For an automation fire:

- Post a top-level header in the destination: "⏰ *Daily AI news* ·
  automation by @owner", with **Pause** and **Edit** buttons.
- The header's `ts` is the thread. The instance id comes from
  `channel.instanceId({ teamId, channelId, threadTs })`, so the run card,
  thread replies, and planning silence work unchanged.
- Dispatch the Coworker with:
  - `initialData`: `channelId`, `threadTs`, `startedBy: owner`,
    `startedAt`, `repo?`, `automationId`.
  - `message`: `{ kind: 'signal', type: 'automation.fire', body: prompt }`.
  - `attributes`: `automationId`, `scheduledAt`, `previousRunAt`.
  - `idempotencyKey`: `automation:<id>:<fire_time>`.
- The run has the same `code-change` capability as a mention.
- The automation tools are not mounted when `initialData.automationId` is
  set. A run cannot create, edit, or reschedule automations, including itself.

## Run outcome and failure

The Coworker's existing `observe` hook sees `submission_settled`. When the
settled submission matches an `automation_runs.submission_id`, record
`succeeded` or `failed`. Only the fire's own submission counts; later human
replies in the thread do not.

- Success resets `consecutive_failures`.
- A failure (dispatch error or failed settle) increments it.
- At 3, set `paused` and DM the owner with a Resume button.

## Creating automations

### Through the agent

The Coworker gets `draft_automation` (not mounted in automation runs). The
model supplies `kind`, `title`, `prompt`, `schedule` (cron) or `run_at` (ISO
with offset), `scope`, and optional `repo` (default: the conversation's repo).

Code fills and checks the rest:

- **Owner:** the Slack user of the current delivery, from trusted delivery
  state. Never from model input.
- **Timezone:** the owner's Slack `tz` (`users.info`; needs `users:read`).
- **Destination:** the owner's DM for personal scope (`conversations.open`),
  the current channel for channel scope.
- **Validation:** croner parses the pattern; `run_at` is in the future; `repo`
  is in the GitHub App installation (shared with `attach_repo`).

The result depends on `automationConfirmation` in `src/config.ts`
(default `true`):

- **On:** write an `automation_drafts` row. Post a confirmation card in the
  thread showing:
  - title, kind, scope, destination, repo
  - the schedule in words ("Weekdays at 09:00 IST")
  - the next three run times
  - the prompt, verbatim
  - **Create**, **Edit**, **Cancel**
  Nothing is stored as an automation until a human clicks Create.
- **Off:** create the automation immediately with the same validation, and
  post the same card in its created state ("✅ Created · next run Mon 09:00")
  with **Edit**, **Pause**, **Delete**.

### Without the model

`/aiyappa automations new` opens the Edit modal empty. Destination is "DM me"
or a channel picker.

### The modal

Fields:

- title
- kind
- prompt (or reminder text)
- schedule preset: Once / Daily / Weekdays / Weekly on… / Custom cron
- time picker, or date-time for Once
- timezone (defaults to the user's)
- destination
- repo (optional)

Custom cron is validated on submit with an inline error. Submitting from a
draft card updates the draft and redraws the card; submitting from a stored
automation updates it and recomputes `next_run_at`.

## Managing automations

`/aiyappa automations` replies ephemerally with the caller's personal
automations and the current channel's channel automations. Each line shows
title, schedule in words, next run, and status, with **Pause/Resume**,
**Run now**, **Edit**, **Delete**.

Handlers live in `src/channels/automation-interactions.ts`, routed from the
existing interactions route. As with planning (ADR 0023), they write D1
before responding, and redraw or dispatch under `waitUntil`.

Authorization, checked in code on every click:

| Action                | Owner | Channel member (channel scope) | Anyone else |
| --------------------- | ----- | ------------------------------ | ----------- |
| Create (draft card)   | drafter only | –                       | –           |
| Pause / Resume        | ✓     | ✓                              | ✗           |
| Run now               | ✓     | ✓                              | ✗           |
| Edit / Delete         | ✓     | ✗                              | ✗           |

- **Create:** the clicker must be the draft's `drafted_by`. The draft is
  consumed exactly once, so a double click is harmless.
- **Resume / Edit:** recompute `next_run_at` from now. Paused periods are not
  replayed. Resume clears `blocked` only after re-authorization passes.
- **Run now:** fires immediately with `fire_time = now` and leaves the
  schedule alone.
- **Delete:** soft. Run history stays.
- "Channel member" means the click came from the automation's destination
  channel (the interaction payload's `channel.id`): only members can see the
  header or run the slash command there.
- External Slack Connect users are refused, as in admission.

## Slack app manifest

- Add bot scopes `users:read` (owner timezone, owner still active) and
  `im:write` (`conversations.open` for personal destinations).
- Update the `/aiyappa` description and usage hint for
  `automations [new]`.
- Add `* * * * *` to `triggers.crons` in `wrangler.jsonc`.

## Docs

- ADR 0025: automations, deterministic control, a heartbeat cron over D1, and
  a fresh conversation per run.
- `SLACK_AGENT_SPEC.md` §9: scheduled automations join the trigger roadmap,
  and the "three adapters" ceiling is revisited.
- `CONTEXT.md`: Automation, Run, Owner.
- `AGENTS.md`: `src/automations/`, slash commands, the cron.

## Testing

- **Pure functions:** draft validation; next-run calculation including a DST
  transition and a one-off; schedule-to-words; the authorization table.
- **Scheduler against a real migrated D1** (`openTestDatabase()`):
  - a claim is deduplicated across two ticks
  - recurring rows advance; one-offs complete
  - several missed fires produce one run
  - a reminder posts without dispatch
  - re-authorization failure blocks the automation and DMs the owner
  - three failed settles pause it
- **Interactions:** Create by the drafter versus someone else; double Create;
  Edit modal submit; Pause by a channel member; Delete by a non-owner
  refused.
- **Coworker render:** `draft_automation` is absent when
  `initialData.automationId` is set.
- **`automationConfirmation: false`:** the tool creates directly and posts the
  created card.

## Acceptance

- "Every weekday at 9am, post yesterday's merged PRs in acme/api to #eng"
  produces a card reading "Weekdays at 09:00 IST". After Create, a header
  plus a run thread appears in #eng the next weekday at 09:00 IST, and a
  reply in that thread continues the conversation.
- "Remind me Thursday 6pm to book tickets" DMs the reminder once and the
  automation shows `completed`.
- Pause from the run header stops the next fire.
- `/aiyappa automations` lists the automation with its next run.
