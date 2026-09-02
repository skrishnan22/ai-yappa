# Persist invocation inputs for deterministic recovery

Before model execution begins, Slack Agent durably records the exact Thread Context used by the Agent Invocation. An interrupted run resumes from that Invocation Snapshot rather than re-reading mutable Slack history; edits and deletions are incorporated only when a later invocation captures a new snapshot.
