# Channel members may use Yappa

Status: accepted. Removes the invoker allowlist from spec §4.1.

Any human member of the deployment's own Slack workspace may start or continue a Coworker in a bound channel. Users from another organization are refused.

## Context

Admission checked every mention and thread reply against `allowedInvokerIds` in `src/config.ts`. Each new teammate needed a code change and a deploy before they could talk to Yappa in a channel they could already talk in. Binding a channel in `channelRepos` is already a deliberate opt-in, and channel membership is already the social boundary for who sees the work.

Slack Connect channels include people from other organizations. They must not drive the Coworker, which pushes branches, opens pull requests, and spends on the shared model subscription.

## Decision

1. **Binding is the opt-in.** Any human member of the workspace may start or continue a Coworker in a channel listed in `channelRepos`, with the Coworker's full capability. Pull request review remains the gate on code.
2. **External users are refused.** The sender's organization is the event's `user_team`; outside Slack Connect channels, plain messages may carry only `team`, which is accepted there. The installing workspace is the envelope's `team_id`; Slack's Slack Connect docs say it mirrors the first authorized user. A mismatch is refused with a polite in-thread reply. In a channel with `is_ext_shared_channel`, only `user_team` counts and an event without it is refused, so a missing field fails closed. No extra OAuth scope is needed.
3. **Unmentioned replies from external users** are refused in a thread that has a Coworker and dropped silently in one that does not, as before.
4. **Slash commands.** Slack does not share slash commands with other organizations in Slack Connect channels ("limited only to the team that has installed the app"), so anyone who can run `/aiyappa` is a workspace member. `status` and `models` are open to them.
5. **Codex admins stay.** `/aiyappa openai connect` and `disconnect` bind the whole deployment to one ChatGPT account and still require `codexAdminIds`.
6. Bots remain ignored.

## Consequences

- Every workspace member can push branches and open pull requests through Yappa in a bound channel, and spend on the shared subscription. The per-conversation budget still bounds each thread.
- Adding a channel to `channelRepos` is now the access decision; review it as one.
- Under Enterprise Grid, a member of a sibling workspace in the same organization has a different `user_team` and is refused. ADR 0001 binds a deployment to one workspace, so this matches.

## Alternatives

- **Keep the allowlist:** a deploy for every new teammate, for no protection that channel binding does not already give.
- **Slack user-group check:** delegates membership to Slack admins, but needs `usergroups:read` and an API call on every event.
