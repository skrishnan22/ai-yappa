# Serialize submissions within each agent conversation

Each Agent Conversation uses Flue's durable FIFO Submission Queue and processes at most one Submission at a time. This gives the conversation and its Execution Workspace a single writer, accepting lower same-thread concurrency to avoid conflicting model state and filesystem mutations.
