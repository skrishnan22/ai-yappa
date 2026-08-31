# Separate the Cloudflare control plane from AWS sandboxes

**Superseded, 2026-08-30.** The Cloudflare vs remote-sandbox split still holds. The sandbox provider is Daytona (`SLACK_AGENT_SPEC.md` D2), not AWS AgentCore. Keep this ADR for the rejected Node-on-AWS control-plane argument.

V1 runs Flue's control plane on Cloudflare, where each Agent Conversation retains structural single ownership, SQLite persistence, wakeups, and recovery in its generated Durable Object, while the Sandbox Adapter executes filesystem and shell work in AWS AgentCore Runtime. The Durable Object reaches AgentCore through authenticated HTTPS and persists every remote call before relying on its response. Deploying Flue's Node runtime in AWS was rejected because it would require operating a durable database, conversation-affinity routing, ownership fencing, wakeups, and reconciliation that the Cloudflare target already supplies.
