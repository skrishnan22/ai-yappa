# The GitHub App installation is the access boundary

Status: accepted. Supersedes ADR 0022 decision 1; its other decisions hold.

Any human member of the deployment's Slack workspace may use Yappa in any channel the bot is in, or in a DM with it, against any repository the GitHub App installation can access.

## Context

ADR 0022 made channel binding the opt-in: a mention in a channel outside `channelRepos` got "This channel has no default repo." That blocks two things the product now needs:

- **Direct messages.** A DM has no channel binding, and personal scheduled automations deliver to DMs.
- **Work without a repository.** A news digest, a reminder, or a design question needs no repository, yet every conversation required one and created a Daytona container to hydrate it.

Binding also mixed two questions: who may talk to Yappa (the workspace, per ADR 0022) and which code it may touch. The GitHub App installation already answers the second. Every native GitHub operation mints an installation token scoped to one repository (ADR 0016), and GitHub refuses a repository the App is not installed on.

## Decision

1. **The installation is the boundary.** Which repositories the GitHub App is installed on decides which code Yappa may read and change. Pull request review remains the gate on code.
2. **Addressed anywhere.** A mention in any channel the bot is in, or any DM, may start a conversation, with the Coworker's full capability. An unmentioned channel thread reply only continues an existing conversation, as before.
3. **One repository per conversation, attached in code.** A conversation starts with the channel's default repository, or none. Without one, the Coworker mounts no sandbox and no GitHub tools, only `attach_repo`. The model names the repository it infers from the request; code checks it against the installation (a metadata-only token mint scoped to that repository) and stores it. Once attached it is permanent; a different repository means a new thread.
4. **`channelRepos` is a default.** A bound channel's conversations start with its repository attached, as today. It no longer gates admission.
5. **Unchanged from ADR 0022:** external Slack Connect users are refused, in channels and DMs; bots are ignored; Codex admins gate `/aiyappa openai connect|disconnect`.

## Consequences

- Installing the GitHub App on a repository is now the access decision for it; review it as one. Any workspace member can ask Yappa to push branches and open pull requests there from any channel or DM.
- Chat-only conversations create no sandbox, so they cost only model time.
- The model, not a config map, picks the repository in unbound channels. A wrong pick is bounded: code accepts only installed repositories, and the model is told to ask when the repository is ambiguous.
- A conversation's sandbox, checkpoint branch, and GitHub token scope stay single-repository.

## Alternatives

- **Keep binding as the gate:** no DMs and no repo-less work, and every new channel needs a deploy.
- **An allowlist for attaching repositories:** duplicates the installation's repository selection in config.
- **Read-only unbound conversations:** a second capability tier to explain and test, while pull request review already gates code.
