# Owner-rendered question controls

The Coworker can ask and close a durable Pending Question through conversation-bound tools. Owner code renders native Block Kit controls, chooses their destination, and records the posted message timestamp. Ordinary model-authored replies continue to reject callback controls under ADR 0019.

Choice buttons record a participant's latest vote. They do not create an Agent Invocation or Submission, including in solo threads. People reply in the thread to continue. Submit/dispatch and group listening are deferred to subsequent changes.

The signature-verified Slack interactions route acknowledges immediately and schedules persistence/redraw through the Worker's execution context. Before recording a vote, the handler matches workspace, channel, thread, message, action and choice against the stored question. The invoker allowlist does not restrict voting. Closed questions refuse clicks ephemerally and remove stale buttons when redrawn.

D1 is authoritative. Older redelivered clicks cannot overwrite a newer vote. A redraw failure preserves a recorded vote and reports the failure ephemerally. Concurrent redraws can briefly show an older snapshot; a later redraw reads current persisted votes.

Question IDs derive from the conversation and stable tool-call ID. Confirmed replays reuse the existing question; unconfirmed posting outcomes never automatically repost. The question post disables Slack SDK retries because a timed-out write may already have reached Slack; reads, redraws and notices keep them. Cleanup closes a question after an unconfirmed post when storage remains available and reopens the question it replaced, whose buttons are retired only after its successor posts.

This amends ADR 0004: a question remains open until replaced, submitted or explicitly closed. Seven-day expiry remains deferred. Local protocol/storage tests do not establish live Slack acceptance.
