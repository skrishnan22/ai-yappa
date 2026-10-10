# Channel members may use Yappa

Date: 2026-10-10
Status: Agreed in chat; spec ready for review. Not implemented.

## Goal

Remove the invoker allowlist. Anyone who can talk in a bound channel can talk to
Yappa there, the same way they can talk to the people in it.

## Boundary

Binding a channel in `channelRepos` is the opt-in. Any human member of the
deployment's own workspace may start or continue a Coworker in a bound channel.
That grants the Coworker's full capability, including branches, pushes, pull
requests, and spend on the shared model subscription. Pull request review
remains the gate on code.

Two limits stay:

- **External users are refused.** In a Slack Connect channel, a user from another
  organization is refused with the same polite reply the allowlist used. Compare
  the event's `user_team` with the workspace's `team_id`; no extra OAuth scope.
- **Codex admins stay.** `/aiyappa openai connect` and `disconnect` bind the
  whole deployment to one ChatGPT account and still require `codexAdminIds`.

Bots remain ignored, as today.

## Changes

- `src/config.ts`: delete `allowedInvokerIds` and `isAllowedInvoker`.
- `src/channels/admit.ts`: replace `allowed` with an external-user check;
  `refuse-invoker` becomes `refuse-external`.
- `src/channels/slack.ts`: pass the event's team identity to admission.
- `src/channels/slash-command.ts`: `status` and `models` are open to workspace
  members. Confirm during implementation which slash-command payload field
  identifies an external user's team.
- Docs: `SLACK_AGENT_SPEC.md` (invoker allowlist), `CONTEXT.md` (bound channel),
  `AGENTS.md` (config and slash-command lines), and an ADR recording the change.

## Acceptance

A workspace member who was not on the old allowlist starts a conversation in a
bound channel and continues it with a thread reply. An external Slack Connect
user is refused. A non-admin cannot connect or disconnect Codex. An unbound
channel still gets the no-repo reply.
