# Use Flue's canonical conversation event stream

Each Conversation Object relies on Flue's immutable, versioned Conversation Events in Durable Object SQLite as canonical history, with large payloads referenced from blob storage. JSONL exports may support debugging and migration, and Postgres projections may serve analytics later, but neither is required to resume an Agent Conversation.
