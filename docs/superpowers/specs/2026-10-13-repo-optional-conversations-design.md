# Repo-optional conversations and DMs

Date: 2026-10-13
Status: Agreed in chat; spec ready for review. Not implemented.

## Goal

Yappa works anywhere a workspace member can reach it: any channel the bot is
in, and direct messages. A conversation does not need a repo. When the work
needs one, the agent infers it from the message and attaches it.

This is the groundwork for scheduled automations
(`2026-10-13-scheduled-automations-design.md`): personal automations post to
DMs, and many (news digest, reminders) have no repo.

## Boundary (new ADR 0024, supersedes ADR 0022 decision 1)

The GitHub App installation is the access decision. Any human member of the
deployment's workspace may use Yappa in any channel the bot is in, or in a DM
with it, against any repository the GitHub App installation can access, with
the Coworker's full capability. Choosing which repositories the App is
installed on replaces channel binding as the opt-in. Pull request review
remains the gate on code.

Unchanged:

- External Slack Connect users are refused (`isExternalSender`). This also
  applies to DMs from external users.
- Bots are ignored.
- Codex admins still gate `/aiyappa openai connect|disconnect`.

`channelRepos` stays, demoted to a per-channel **default repo**.

## Admission

`src/channels/admit.ts`:

- Delete the `no-repo` decision. `dispatch` carries `repo?: string` (the
  channel default, if any).
- Introduce an **addressed** signal: an `app_mention`, or any message in a DM.
  Today's "mention" rules key on addressed instead of `slack.app_mention`:
  creating a conversation, `$model:` / `$effort:` parsing (creating message
  only, as today), `/skill` invocation, and the planning-silence exemption.
- New signal type `slack.direct_message` for DM messages. `slack.message`
  stays the unaddressed thread reply in a channel.

`src/channels/slack.ts`:

- Handle `message` events with `channel_type: 'im'`. A top-level DM (no
  `thread_ts`) creates a conversation keyed on its own `ts`; a reply in that
  DM thread continues it. Each top-level DM is a new conversation.
- In DMs, do not drop a message for mentioning the bot (`app_mention` does not
  fire in DMs). Subtypes and `bot_id` messages are still dropped.
- The no-repo refusal text goes away.

## Coworker

`src/agents/coworker.ts`:

- `initialData.repo` becomes optional. The conversation's repo is
  `usePersistentState<string | null>('repo')`, falling back to
  `initialData.repo`. Existing conversations keep working with no migration.
- **No repo yet:** no `useSandbox`, no GitHub tools, so a chat-only thread
  never creates a Daytona container. Mount `attach_repo`.
- **`attach_repo({ repo })`:** accepts `owner/name` or a GitHub URL. Code,
  not the model, checks it against the GitHub App installation's repositories
  (`GET /installation/repositories` through the existing App token path in
  `src/proxy/github.ts`, cached for a few minutes per isolate). On success it
  writes `repo` (normalized to the HTTPS clone URL) and returns it. On a miss
  it returns an error with up to five closest accessible names so the model
  can ask "did you mean…".
- **Repo attached:** mount `useSandbox` and `githubTools` for that repo, and
  stop mounting `attach_repo`. Flue attaches the sandbox at the next turn
  boundary and announces it with an `environment` signal; hydration runs in
  `createSandbox` as today.
- **One repo per conversation, permanent.** A different repo means a new
  thread. This keeps one sandbox, one checkpoint branch, and one GitHub token
  scope per conversation, and confines each session to a single repo.
- `coworkerInstructions(repo?)`: without a repo, tell the model to infer the
  repo from the request, call `attach_repo` before any code or GitHub work,
  ask when the repo is ambiguous, and answer non-code requests without one.
- The run card shows the repo only once one is attached.

## Slack app manifest

`slack-app-manifest.yaml`:

- Add bot scope `im:history`.
- Add `features.app_home` with `messages_tab_enabled: true` and
  `messages_tab_read_only_enabled: false`.
- Add `settings.event_subscriptions` (request URL placeholder like the others)
  with bot events `app_mention`, `message.channels`, `message.groups`,
  `message.im`, so the manifest describes the whole app.
- Update the description: no longer "a mention in a mapped channel".

## Docs

ADR 0024 and its row in `docs/adr/README.md` (0022 marked partially
superseded). `SLACK_AGENT_SPEC.md` admission and repo sections, `CONTEXT.md`
(bound channel → default repo; attached repo), `AGENTS.md` (`config.ts` and
Slack ingress lines), README Slack app setup.

## Testing

- `decideAdmit`: unbound channel mention dispatches with no repo; bound
  channel dispatches with its default; DM top-level creates; DM thread reply
  continues; external DM refused; channel thread reply without a mention still
  needs an existing conversation.
- `attach_repo`: accepted (URL and `owner/name`), rejected with suggestions,
  installation lookup failure surfaces as a tool error.
- Coworker render: no sandbox and no GitHub tools without a repo; both present
  and `attach_repo` absent after `repo` is set; an old conversation with
  `initialData.repo` and no state renders as attached.

## Acceptance

A DM "what's new in AI agents this week?" gets an answer with no sandbox
created. A mention in an unbound channel "in acme/api, why does the login test
fail?" attaches `acme/api`, hydrates, and investigates. A repo the App cannot
access is refused with suggestions. A bound channel behaves as today. An
external Slack Connect user is refused in a channel and in a DM.
