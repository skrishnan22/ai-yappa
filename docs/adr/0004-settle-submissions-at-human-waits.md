# Settle submissions when waiting for a human

When Slack Agent needs human input, the current Flue Submission completes with the question and records a durable Pending Question on the Agent Conversation. A later Agent Invocation becomes a new Submission that may answer it, preserving conversation continuity without inventing a suspended-run layer outside Flue's terminal submission contract.

Amended by ADR 0022: a Pending Question remains open until replaced, submitted, or explicitly closed. The proposed seven-day expiry is deferred; no expiry timer is implemented. Vote clicks do not create Submissions.
