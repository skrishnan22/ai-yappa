# Observability Telemetry Design

**Status:** Proposed for implementation after review

**Date:** 2026-09-13

**Scope:** Rollout items 1, 3, and 4 only

## Goal

Replace the temporary diagnostic logging with a small, typed telemetry layer that emits safe, queryable terminal events across Slack ingress and delivery, Flue execution, Daytona, and the GitHub credential proxy.

This slice must make one agent run reconstructable without logging user messages, prompts, model output, tool arguments, tool results, command text, file contents, or secrets.

## Non-goals

- Selecting or deploying an observability backend.
- Adding OTLP export, dashboards, alerts, or eval pipelines.
- Replacing Flue's built-in OpenTelemetry spans.
- Persisting telemetry as recovery state. Flue's durable conversation and submission records remain the execution source of truth.
- Capturing hidden chain-of-thought.
- Implementing the durable sandbox `commandId` and unknown-outcome reconciliation planned for M4.
- Enabling Cloudflare trace-content capture.

## Design principles

1. **One terminal event per completed unit of work.** A completed turn, tool call, sandbox command, proxy operation, or Slack API call emits one wide event containing its outcome and duration. Start events are not duplicated into logs; traces represent in-flight timing.
2. **Allowlist fields rather than redact arbitrary objects.** Telemetry records are constructed from known scalar fields. Flue observations, Slack payloads, exceptions, tool arguments, tool results, and provider responses are never spread into a log record.
3. **Correlation is application-owned.** Cloudflare, Flue, Slack, Daytona, and GitHub identifiers are recorded as fields on the same schema. Cross-service analysis does not depend on a vendor propagating its trace identifier.
4. **Telemetry cannot break the product path.** Emission is synchronous, best-effort, bounded, and contained. A serialization or console failure must not change an agent outcome.
5. **Low-cardinality names, high-cardinality fields.** Event names and outcome values are controlled enums. IDs, repositories, models, and durations are fields, not interpolated into messages or metric names.

## Shape and ownership

Add one initial module, `src/observability.ts`, rather than introducing a logging framework or a directory of adapters. It owns:

- the common telemetry envelope;
- the discriminated union for all eight event families;
- safe error classification and bounded strings;
- the existing reviewed SHA-256 proxy-parameter digest as an allowlisted field;
- `emitTelemetry(event)`, the only structured console emission path;
- the mapping from terminal Flue observations to agent telemetry.

Call sites construct typed domain events. They do not call `console.info` for operational events directly. Existing human-oriented startup errors may remain plain console messages if they occur before the telemetry module has enough context.

The Cloudflare Worker console is the first sink. `emitTelemetry` writes one structured object per event. A backend exporter can later consume the same union without changing call sites.

## Common envelope

Every record contains:

```ts
type TelemetryEnvelope = {
  schema_version: 1;
  event_name: TelemetryEventName;
  timestamp: string;
  service: 'slack-agent';
  environment?: string;
  release?: string;
  deployment_id?: string;
  outcome: TelemetryOutcome;
  duration_ms?: number;
  attempt?: number;
  error_type?: string;
  error_code?: string;
};
```

Optional values are omitted, not emitted as `null`. Event-specific correlation fields are added directly to the record so queries do not require unpacking nested blobs.

`TelemetryOutcome` is a controlled union such as `ok`, `refused`, `dropped`, `completed`, `failed`, `aborted`, `timeout`, `unauthorized`, `invalid`, `upstream`, `deduplicated`, or `skipped`. Each event family narrows this union to outcomes that make sense for that boundary.

Environment and release metadata come from explicitly supported Worker bindings when present. Their absence must not prevent emission.

## Correlation model

The following identifiers form the run graph:

| Field | Source | Purpose |
|---|---|---|
| `slack_event_id` | Slack Events API payload | Idempotent ingress delivery |
| `conversation_id` | `channel.instanceId(thread)` / Flue instance context | Stable Slack-thread-to-agent identity |
| `agent_uid` | Flue `DispatchReceipt.uid` | Specific durable agent incarnation |
| `submission_id` | Flue dispatch receipt and observations | One admitted user submission, including retries |
| `operation_id` | Flue observation | Agent operation grouping |
| `turn_id` | Flue observation | One model request/response |
| `tool_call_id` | Flue observation and tool context | One model-facing tool execution |
| `sandbox_id` | Daytona sandbox | Provider workspace identity |
| `sandbox_command_id` | Generated immediately before one Daytona `executeCommand` call | Telemetry identity for one provider call |

Slack ingress emits `slack_event_id`, `conversation_id`, `agent_uid`, and `submission_id` after `dispatch()` returns. Flue events carry the latter correlations into turns and tools. Proxy tools already receive `conversation_id` and `submission_id`; the tool observer supplies `tool_call_id` for the corresponding `agent.tool` event.

The Daytona driver receives `conversation_id` through `DaytonaAdapterOptions` and already owns `sandbox_id`. It generates a fresh `sandbox_command_id` for every provider command. This identifier is for logs only: it is not persisted, is not sent to Daytona, and must not be reused as the future durable M4 command reconciliation key. A sandbox command can therefore be joined reliably to its conversation and sandbox, while the enclosing model-facing shell call remains independently identifiable by `tool_call_id` in `agent.tool`.

Slack delivery from a tool records `tool_call_id`; run-card delivery records `conversation_id` and, when known, `submission_id`. Admission-refusal delivery records `slack_event_id` and `conversation_id`.

## Eight terminal event families

### `slack.invocation`

Emitted once after the admission decision is complete.

Fields: `slack_event_id`, `conversation_id`, `signal_type`, `decision`, `submission_id`, `agent_uid`, `deduplicated`, `repo`, and decision latency. It never includes Slack text, thread context, user name, or message bodies. Opaque Slack user, team, and channel IDs are omitted unless a concrete operational query later requires them.

Dispatch failure is terminal and classified without logging the exception message.

### `agent.submission`

Mapped from terminal Flue submission events: `submission_recovery` for a completed recovery action and `submission_settled` for the final submission outcome. Admission and running start events are not duplicated.

Fields: `conversation_id`, `submission_id` when Flue identifies one, `stage` (`recovery` or `settlement`), recovery operation, attempt/max-attempt counts, `outcome`, Flue event version/index, and safe error classification. Retry attempts remain visible without maintaining a fragile in-memory submission accumulator.

### `agent.turn`

Mapped only from Flue `turn`.

Fields: `conversation_id`, `submission_id`, `operation_id`, `turn_id`, `purpose`, Flue event version/index, requested provider/model/API, response model, normalized and provider finish reasons, gateway log ID, token usage when supplied by Flue, compaction flag, `duration_ms`, `outcome`, and safe error classification.

It never includes the system prompt, messages, response output, reasoning text, or raw provider error message.

### `agent.tool`

Mapped only from Flue `tool`.

Fields: `conversation_id`, `submission_id`, `operation_id`, `turn_id`, `tool_call_id`, `tool_name`, `origin`, Flue event version/index, `duration_ms`, `outcome`, and safe error classification.

The observer temporarily remembers only allowlisted metadata from `tool_start`, keyed by `tool_call_id`, so the terminal event can include origin and a bounded serialized argument size. The raw arguments and an arguments digest are never retained in telemetry state or emitted. Entries are deleted on terminal observation; loss on isolate eviction is acceptable because this map is enrichment, not execution state.

Tool result contents and error strings are not logged. Result kind and bounded serialized size may be recorded if they can be computed without retaining the value.

### `sandbox.lifecycle`

Emitted once for each completed application-owned lifecycle phase: lookup, snapshot ensure, create, start/reuse, hydration, and Flue attachment.

Fields: `conversation_id`, `sandbox_id` when known, `phase`, `sandbox_class`, prior/final state when known, `reused`, `skipped`, `duration_ms`, `outcome`, and safe error classification.

Repository content, filesystem paths, clone output, and credentials are excluded. The canonical `owner/repo` identifier may be included on hydration events.

### `sandbox.command`

Emitted once when a Daytona `executeCommand` call returns, times out, or throws.

Fields: `conversation_id`, `sandbox_id`, `sandbox_command_id`, operation (`exec` or internal adapter operation), working-directory class rather than path, timeout bucket, exit code, stdout/stderr byte counts, `duration_ms`, `outcome`, and safe error classification.

Command text, environment variables, working-directory paths, stdout, and stderr are never emitted. The command digest is omitted in this slice because it can become a durable fingerprint of sensitive user content without providing a necessary operational query.

### `proxy.operation`

Emitted from the same `finish` path that appends the existing `AuditRecord`.

Fields: `conversation_id`, `submission_id`, `repo`, `proxy_operation`, the existing `params_digest`, `duration_ms`, and the existing controlled outcome (`ok`, `unauthorized`, `invalid`, or `upstream`).

The persistent conversation audit array remains unchanged in this slice. Telemetry is a second sink for analysis, not a replacement for that execution-adjacent record.

### `slack.delivery`

Emitted once for each completed Slack Web API operation: refusal reply, missing-repo reply, agent reply, run-card post, run-card update, and terminal notification.

Fields: the correlation IDs available at the call site, `delivery_kind`, Slack method, `posted`, retry/attempt data when exposed by the Slack client, `duration_ms`, `outcome`, and safe Slack error classification.

Message text, blocks, channel names, and response bodies are excluded. The local no-token behavior of `replyInThread` emits `outcome: 'skipped'` with `posted: false`.

## Error classification and redaction

`error_type` and `error_code` are derived only from known framework/provider error types and allowlisted properties. Unknown exceptions become `error_type: 'unknown'`. Raw `Error.message`, stack traces, Slack response bodies, and Daytona output are not telemetry fields.

Bounded labels such as model, tool, operation, and finish reason are normalized to a maximum length. Invalid control characters are replaced. Digests use canonical JSON plus SHA-256 and are only allowed at explicitly reviewed call sites.

`emitTelemetry` performs a final defensive check before output:

- reject unknown keys in development/tests;
- cap scalar string length;
- replace values matching high-confidence secret patterns;
- confirm the record serializes to a bounded byte size;
- fall back to a minimal `telemetry.emit_failure` console record if construction fails.

The fallback contains only `schema_version`, `event_name: 'telemetry.emit_failure'`, `timestamp`, `service`, `outcome: 'failed'`, and a controlled failure reason. It is an internal logger-health sentinel, not a ninth domain event family. Telemetry failures never throw to business logic.

## Flue observer change

Keep the existing module-level `observe()` registration because Flue requires observers at module scope. Replace `debugFields()` and its raw `console.info` call with the typed terminal mapper.

The same observer continues forwarding run-card events. Run-card presentation may still consume tool results internally to extract already-public branch and pull-request URLs, but those values do not enter telemetry through the observer.

The mapper ignores delta, message, thinking, start, and progress observations except for the bounded `tool_start` enrichment described above. A completed `submission_recovery` action maps to the `agent.submission` family so a repeatedly stuck submission is visible even before it settles.

## Configuration

No new runtime dependency is required. The slice uses platform `console` output and the existing proxy digest implementation.

`wrangler.jsonc` remains trace-enabled. This slice does not enable trace-content recording. Logpush, Workers Logs persistence, OTLP destinations, sampling, and backend credentials belong to the next rollout decision.

## Verification

Unit tests must prove:

1. every event family accepts its intended fields and rejects arbitrary payload fields at compile time;
2. raw Slack text, thread context, prompts, model output, tool arguments/results, command text/output, paths, environment variables, exception messages, and stacks are absent from emitted records;
3. representative tokens and authorization headers are replaced by the defensive secret check;
4. each terminal Flue observation maps to exactly one telemetry event with the expected correlation fields;
5. `tool_start` enrichment is deleted after its matching terminal tool event;
6. Slack dispatch receipt fields connect `slack.invocation` to later Flue events;
7. Daytona lifecycle and command events contain conversation and sandbox correlation, including timeout and sandbox-death paths;
8. proxy telemetry exactly matches the existing audit outcome and digest;
9. Slack success, failure, and no-token delivery paths each emit once;
10. emitter failure is contained and does not change the caller's return or thrown error.

Repository verification after implementation:

```text
npm test
npm run check:types
npm run build
```

A manual local run should produce queryable records for the boundaries it exercises, with no raw content in captured output.

## Acceptance criteria

- The temporary `debugFields()` logger and raw tool-argument/error logging are removed.
- Operational call sites use `emitTelemetry`; no new ad hoc JSON log formats are introduced.
- The eight domain event names above are represented by a closed TypeScript union and have terminal emission paths; the emitter-health sentinel is separately typed.
- A Slack event can be followed through conversation and submission to Flue turns/tools, proxy operations, Daytona activity, and Slack delivery using explicit correlation fields where each boundary exposes them.
- Telemetry contains metadata, outcomes, durations, sizes, and controlled classifications only; it contains no user or model content and no credentials.
- Telemetry failure cannot fail admission, agent execution, sandbox work, proxy work, or Slack delivery.
- No backend exporter, dashboard, alert, eval store, or M4 command reconciliation behavior is added in this slice.
