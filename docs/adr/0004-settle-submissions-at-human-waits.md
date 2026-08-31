# Settle submissions when waiting for a human

When Slack Agent needs human input, the current Flue Submission completes with the question and records a durable Pending Question on the Agent Conversation. A later Agent Invocation becomes a new Submission that may answer it within seven days, preserving conversation continuity without inventing a suspended-run layer outside Flue's terminal submission contract.
