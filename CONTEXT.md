# Slack Agent

Slack Agent is an internal coding coworker operated through Slack. It turns requests into code changes and pull requests without merging or deploying them.

Implementation source of truth is `SLACK_AGENT_SPEC.md` (handoff: `SLACK_AGENT_HANDOFF.md`). This file is the glossary. `docs/adr/` is historical; see `docs/adr/README.md` for what the spec kept or replaced.

## Language

**Slack Agent Deployment**:
An isolated deployment of Slack Agent bound to exactly one Slack Workspace.
_Avoid_: Tenant, customer instance

**Slack Workspace**:
The Slack organization served by one Slack Agent Deployment.
_Avoid_: Tenant

**Configured Channel**:
A Slack channel listed in the deployment's channel→repo map. It supplies the default repository for new agent work. Only allowlisted invokers may start a conversation.
_Avoid_: Allowed user group, authorized users

**Channel Adapter**:
A Flue channel integration that translates one chat provider's verified events and presentation capabilities to and from Agent Conversations. Slack is the only v1 adapter.
_Avoid_: Agent runtime, universal chat UI

**Agent Conversation**:
The durable agent state associated one-to-one with a Slack thread. It owns one Conversation Object and one Execution Workspace, advances only through explicit Agent Invocations, and may span multiple Submissions.
_Avoid_: Activated thread, session, chat

**Conversation Object**:
The Flue-generated Durable Object that exclusively owns an Agent Conversation's canonical event stream, Submission Queue, and recovery.
_Avoid_: Session object, agent process, worker

**Conversation Event**:
An immutable, versioned Flue record appended to an Agent Conversation's canonical event stream. The stream is stored transactionally and may be exported as JSONL for debugging or migration.
_Avoid_: Database row, log line, trace message

**Working Context**:
The bounded projection of current requests, recent messages, relevant observations, and older summaries assembled for a model call. Exact canonical history remains retrievable even when it is not included verbatim.
_Avoid_: Conversation Event stream, complete history

**Context Summary**:
A durable compact representation of older messages or events tied to their exact source ranges. It reduces Working Context size without replacing canonical history.
_Avoid_: Canonical history, deleted history

**Agent Invocation**:
An explicit `@mention` of the bot, or an agent-provided interactive control. Ordinary unmentioned Slack replies in a thread the bot has never joined are ignored. Unmentioned replies in an already-tracked thread continue that conversation.
_Avoid_: Thread reply, channel message

**Submission**:
The Flue-owned durable unit of work admitted from one Agent Invocation. It settles exactly once as completed, failed, or aborted.
_Avoid_: Agent Run, session, task

**Pending Question**:
A durable question left on an Agent Conversation after the asking Submission completes. A later Submission may answer it for up to seven days, after which it expires.
_Avoid_: Awaiting process, suspended Submission, open request

**Submission Queue**:
The Flue-owned durable first-in-first-out sequence of Submissions for one Agent Conversation. At most one Submission is processed at a time.
_Avoid_: Invocation Queue, message backlog, task queue

**Live Run Card**:
A persistent, thread-visible Slack Block Kit message owned one-to-one by a Submission. It is updated in place from admission through terminal outcome and presents only public progress and safe activity details.
_Avoid_: Ephemeral card, trace, console output

**Thread Context**:
The complete Slack thread supplied as context for an Agent Invocation, including messages that did not mention Slack Agent. Only the Agent Invocation is treated as the request to act.
_Avoid_: Prompt, conversation history

**Invocation Snapshot**:
The durable capture of Thread Context used by one Agent Invocation. Recovery reuses this capture; Slack edits are observed only by a later invocation.
_Avoid_: Live thread, latest messages

**Tool Observation**:
The durable result of one sandbox tool execution, including its outcome, output reference, and the workspace state against which it ran.
_Avoid_: Tool memory, console log

**Unknown Tool Outcome**:
A durable record that a remote tool operation may have run but its completion and effects cannot be proven. It is neither a failed operation nor permission to retry a mutation.
_Avoid_: Tool failure, timeout, retryable error

**Model Route**:
The deployment-configured provider and model used by Flue for an Agent Conversation. V1 supports OpenCode Zen and OpenRouter routes but exposes no per-user model selection.
_Avoid_: Model picker, automatic model routing

**Workspace Fingerprint**:
An identifier for the source state in an Execution Workspace. A Tool Observation such as a test result remains current only while this fingerprint is unchanged.
_Avoid_: Latest commit, sandbox ID

**Execution Workspace**:
The isolated filesystem owned by one Agent Conversation and available to its Submissions, containing one or more checked-out repositories.
_Avoid_: Workspace, Slack workspace, repo folder

**Working Branch**:
The Git branch owned by an Agent Conversation, used for durable code recovery and ultimately as the source of its pull request.
_Avoid_: Session branch, sandbox branch

**Code Checkpoint**:
A durable Git commit pushed to the Working Branch at a safe recovery boundary. It contains source changes but excludes secrets, dependencies, ignored files, and build artifacts.
_Avoid_: Workspace snapshot, autosave

**Sandbox**:
The remote compute environment that operates on an Execution Workspace.
_Avoid_: VM, worker, agent

**Sandbox Adapter**:
The provider-neutral control-plane boundary that translates durable tool calls into operations against a remote Sandbox. Daytona container Sandboxes are the v1 provider (spec D2), behind Flue's `SandboxFactory` contract.
_Avoid_: Agent loop, sandbox provider, AWS client

**Sandbox Handle**:
The opaque provider session identity stored on an Agent Conversation and reused across healthy Sandbox Leases. It may be replaced without changing the Agent Conversation or Execution Workspace identity.
_Avoid_: Slack thread ID, conversation ID, permanent sandbox

**Capability Grant**:
A short-lived authorization allowing one Sandbox Lease to perform specified operations against one integration resource. It conveys permission without containing the integration's reusable credential.
_Avoid_: API key, sandbox credential, access token

**Credential Proxy**:
A trusted integration boundary that validates Capability Grants and acts with reusable credentials without revealing them to a Sandbox. It exposes integration-specific operations rather than arbitrary authenticated HTTP forwarding.
_Avoid_: Open proxy, credential vending service, universal API gateway

**Sandbox Lease**:
A temporary attachment of Sandbox compute to one Agent Conversation. It is reused during active work, kept running for at most fifteen idle minutes by default, then stopped while its filesystem is retained. Starting or replacing it does not change conversation identity; no process is expected to survive a stop.
_Avoid_: Sandbox ownership, permanent VM, session
