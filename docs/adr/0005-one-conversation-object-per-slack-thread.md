# Map each Slack thread to one conversation object

Each Slack thread maps to exactly one Agent Conversation, one Conversation Object, and one isolated Execution Workspace. The per-thread Durable Object is the single owner of conversation ordering and recovery, while replaceable Sandboxes operate on the conversation-owned workspace without sharing writable files across threads.
