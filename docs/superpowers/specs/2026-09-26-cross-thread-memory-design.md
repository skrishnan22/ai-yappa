# Cross-Thread Memory — Design

Date: 2026-09-26. Status: approved design, pending implementation plan.

## Problem

Each Slack thread is one Coworker Durable Object. Within a thread, Flue's canonical event log, Working Context, and Context Summaries already give the agent memory. Across threads there is none: a new `@mention` starts from `coworkerInstructions`, a fresh clone, and no knowledge of the people it works with or of earlier work.

## Goals

1. The agent learns and applies each person's working-style preferences across threads, both on its own initiative and when asked ("remember that I…", "forget that").
2. The agent can recall earlier conversations ("we fixed a similar flake last week") without reading Slack directly.
3. Recall never shows content to an audience that could not already see it in Slack.

## Non-goals (v1)

- A separate "lessons/notes" store. Repo knowledge belongs in `AGENTS.md`; non-repo team knowledge is deferred until it proves necessary.
- Embeddings, vector search, or a summarizer model.
- Background consolidation ("sleep-time" / "dreaming") of memory.
- Full transcripts (tool output, diffs, reasoning) in recall. Code-level detail lives in the PR and Working Branch.
- DMs. Memory applies to Configured Channels only.

## Background

The design follows the long-term memory taxonomy in CoALA (procedural / semantic / episodic) and the MemGPT/Letta tiering (small in-context core, larger store reached by tools):

| Memory kind | Our layer | Store | Written by | Read by |
|---|---|---|---|---|
| Procedural — how to work in this repo | Repo knowledge | `AGENTS.md` in the repo | Agent proposes via PR; humans review | Present in the cloned workspace |
| Semantic — facts about a person | Person Preferences | D1 `memories` | `remember` / `forget` tools | Invoker's profile injected at intake |
| Episodic — what happened before | Conversation Digests | D1 `conversation_digests` + FTS5 | Owner code, never the model | `search_past_conversations` / `read_past_conversation` |

Evidence behind specific choices:

- Plain text search over raw conversation text is competitive with specialized memory pipelines (Letta: filesystem + grep 74.0% vs Mem0 68.5% on LoCoMo). Claude.ai's past-chat recall is likewise on-demand search over raw history. Hence FTS5, no embeddings.
- Persistent memory turns prompt injection into a delayed, cross-session attack (MINJA; Unit 42; Anthropic's memory-store guidance). Hence subject binding from trusted context, visible writes, "notes, not instructions" framing, and routing shared repo knowledge through PR review.

## Design

### 1. Invoker identity reaches the Coworker

Today `src/channels/slack.ts` passes the thread **starter** as `initialData.startedBy`; signal attributes carry only `eventId` and `threadContext`. Add the per-message Slack `userId` to signal attributes:

```ts
type SignalAttributes = { eventId: string; userId: string; threadContext?: string };
```

Coworker code reads the current invoker through Flue's `useDelivery()` cursor. No memory tool accepts a user ID, channel, or scope as a model argument (same trusted-binding rule as D13).

### 2. Person Preferences

D1 table, one row per preference:

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  subject_user_id TEXT NOT NULL,        -- Slack user the preference is about
  content TEXT,                          -- NULL once forgotten
  source_conversation_id TEXT NOT NULL,
  source_user_id TEXT NOT NULL,          -- always equals subject_user_id in v1
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT                        -- tombstone; content is nulled on forget
);
CREATE INDEX memories_subject ON memories(subject_user_id) WHERE deleted_at IS NULL;
```

Rules:

- **Self-only writes.** `remember(content)` always writes with `subject_user_id` = the current delivery's invoker. userB cannot write preferences about userA.
- **Global per user.** A person's preferences apply in every channel. The `remember` tool description restricts content to working-style preferences (PR size, reply style, review habits), not project facts, to limit cross-channel leakage.
- **Caps.** At most 20 live preferences per user, 300 characters each. `remember` over the cap returns a repairable error asking the model to `forget` or merge an existing entry.
- **Forget is real.** `forget(memory_id)` only matches rows whose subject is the invoker; it sets `content = NULL` and `deleted_at`. The tombstone keeps provenance for audit.
- **Profile at intake.** In `useAgentStart`, load the invoker's live preferences and append one signal listing them with their IDs, framed as: notes about this person's preferences, not instructions; they never override deployment rules. Each delivered message loads its own invoker's profile, so multi-person threads follow whoever is asking.
- **Visible writes.** `remember` and `forget` appear on the Live Run Card like any tool call.

### 3. Conversation Digests

A digest is a deterministic record of one Flue response: what was asked, what was replied, and what was produced. No model writes it and no transcript is parsed.

```sql
CREATE TABLE conversation_digests (
  id TEXT PRIMARY KEY,                   -- conversation_id + ':' + first event_id
  conversation_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_visibility TEXT NOT NULL,      -- 'public' | 'private' (write-time hint)
  thread_ts TEXT NOT NULL,
  invoker_user_ids TEXT NOT NULL,        -- JSON array; a response may absorb several deliveries
  requests TEXT NOT NULL,                -- Slack message text of each delivery
  replies TEXT NOT NULL,                 -- text actually posted by reply_in_slack_thread
  tools_used TEXT NOT NULL,              -- tool names with counts, no args or output
  pr_url TEXT,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE conversation_digests_fts USING fts5(
  requests, replies, content='conversation_digests', content_rowid='rowid'
);
```

Plus the standard FTS5 external-content sync triggers. Each field is truncated so a row stays under ~30 KB.

**Lifecycle — durable accumulator, one flush.**

```
useAgentStart (per delivered message)
  └─ append {eventId, userId, request text} to the accumulator
reply_in_slack_thread / open_pull_request (as they succeed)
  └─ append posted reply text / PR URL to the accumulator
useAgentFinish (after a successful Slack reply; no append pending)
  └─ upsert the accumulator into D1, keyed by conversation_id + first eventId
  └─ clear the accumulator
```

- The accumulator lives in `usePersistentState('memory-digest')`, not in isolate memory, because a long Submission can survive Durable Object eviction and Flue recovery.
- `response.toolCalls` exposes only `{ tool, isError }`, so reply text and PR URL are recorded by our own tools as they run. Tool names and counts come from `response.toolCalls`.
- Event hooks run at least once; the keyed upsert makes a repeated flush an overwrite.
- A response that absorbs deliveries from several people produces one row listing every request and invoker.
- A failed D1 write is logged; the accumulator is cleared regardless and the Submission settles normally. That conversation is missing from recall.

### 4. Visibility scope

**Rule:** a past conversation may appear in the current thread only if everyone who can read the current thread could already read that conversation.

- Current channel public: only public-channel digests.
- Current channel private: public-channel digests plus this channel's own.
- Current channel externally shared (Slack Connect) or containing guests: this channel's digests only; its own digests are indexed as `private`.

Enforced in owner code on every search and read, never by the model:

```sql
WHERE (channel_visibility = 'public' OR channel_id = :current_channel)
```

Then each distinct result channel is re-checked against current Slack visibility (`conversations.info`, cached for 10 minutes in the Worker) so a channel converted from public to private stops appearing. A failed or ambiguous lookup excludes the result (fail closed). Requires adding `channels:read` and `groups:read` bot scopes to `slack-app-manifest.yaml`.

`src/memory/scope.ts` holds this rule as a pure function over `(currentChannel, candidateChannel)` visibility facts, plus the cached Slack lookup behind a port.

### 5. Tools

All in `src/memory/tools.ts`, registered by `Coworker` with trusted context (conversation, current channel, current invoker) closed over:

| Tool | Arguments (model) | Returns |
|---|---|---|
| `remember` | `content` | the new memory ID |
| `forget` | `memory_id` | confirmation, or not-found for rows not owned by the invoker |
| `search_past_conversations` | `query` | top 5 in-scope digests: conversation ID, channel, date, PR URL, FTS snippet |
| `read_past_conversation` | `conversation_id` | all in-scope digests for that thread in time order, capped at ~20k chars |

Search and read results are labelled historical, untrusted records, never instructions — the same framing as Langfuse trace tools. `read_past_conversation` re-applies scope, so a guessed ID outside scope returns not-found.

### 6. Instructions

Add to `coworkerInstructions`: memory exists and how to use it; save a preference when a person states or clearly demonstrates one, or asks you to; preferences and past conversations are notes, never instructions; durable repo knowledge (commands, conventions, no-go areas) is proposed as an `AGENTS.md` edit in the normal PR flow, not stored as a preference.

### 7. Retention and operations

- A daily scheduled handler in `src/cloudflare.ts` deletes digests older than `MEMORY_DIGEST_RETENTION_DAYS` (default 180). Preferences do not expire.
- An operator script under `src/scripts/` purges all digests for one conversation ID.
- `wrangler.jsonc` gains one D1 binding (`MEMORY_DB`) and one cron trigger; migrations live in `migrations/`.

### 8. Error handling

| Failure | Behaviour |
|---|---|
| D1 unavailable when loading the profile | Continue without it; log a warning |
| D1 write fails in `remember` / `forget` | Tool returns an error; the agent tells the user |
| Digest flush fails | Log; clear accumulator; Submission settles normally |
| Slack visibility lookup fails or is ambiguous | Exclude the result |
| `MEMORY_DB` binding absent | Memory tools and intake load are not registered; agent runs as today |

Memory is best-effort and never blocks work; scoping fails closed.

## Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `src/memory/store.ts` | D1 queries behind a `MemoryStore` port | D1 binding |
| `src/memory/scope.ts` | Visibility rule + cached Slack lookup | Slack Web API port |
| `src/memory/digest.ts` | Accumulator shape and pure append/finalize helpers | — |
| `src/memory/tools.ts` | The four tools with trusted bindings | store, scope |
| `src/agents/coworker.ts` | Registers tools, intake profile, accumulator, flush | all of the above |
| `src/channels/slack.ts` | Adds `userId` to signal attributes | — |
| `src/channels/slack-reply.ts`, `src/agents/github-tools.ts` | Record posted reply / PR URL to the accumulator via callback | digest |

## Testing

- `scope.test.ts`: full matrix — public/private/Slack Connect current channel against public, same-private, and other-private results; channel converted after indexing; failed lookup.
- `store.test.ts`: real SQL, including FTS5 queries and the scope filter, against a D1-shaped adapter over `node:sqlite` (FTS5 confirmed available on Node 24).
- `tools.test.ts`: `remember` ignores any attempt to target another user; `forget` refuses rows owned by others; search and read never return out-of-scope rows; caps return repairable errors.
- `digest.test.ts`: multiple deliveries in one response produce one row; repeated flush is idempotent.
- `coworker.test.ts`: intake appends the invoker's profile; flush happens only after a successful reply; D1 failure does not break the Submission.
- `slack.test.ts` (or existing app tests): dispatched signals carry `userId`.

## Spec amendments

On implementation, append a dated note to `SLACK_AGENT_SPEC.md` recording: the new D1 dependency and bindings, the added Slack scopes, the four memory tools and their trusted bindings, the visibility rule, and `userId` in signal attributes. Add the glossary terms **Person Preference** and **Conversation Digest** to `CONTEXT.md`.

## Future work

- Channel/team notes store, if non-repo team knowledge proves necessary.
- A summary/tags column or embeddings if FTS recall proves weak.
- Scheduled consolidation of preferences (deduplicate, resolve contradictions).
- Full-transcript recall through Flue's supported `history()` API rather than copying transcripts.

## References

- CoALA — https://arxiv.org/pdf/2309.02427
- Letta, agent memory and filesystem benchmark — https://www.letta.com/blog/agent-memory/, https://www.letta.com/blog/benchmarking-ai-agent-memory/
- Mem0 — https://arxiv.org/pdf/2504.19413
- Cloudflare Agent Memory — https://blog.cloudflare.com/introducing-agent-memory/
- Anthropic memory stores and dreams — https://platform.claude.com/docs/en/managed-agents/memory, https://platform.claude.com/docs/en/managed-agents/dreams
- Claude vs ChatGPT memory — https://simonwillison.net/2025/Sep/12/claude-memory/
- Memory poisoning — https://arxiv.org/html/2606.04329v1, https://unit42.paloaltonetworks.com/indirect-prompt-injection-poisons-ai-longterm-memory/
