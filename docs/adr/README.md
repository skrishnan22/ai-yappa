# Architecture decisions

`SLACK_AGENT_SPEC.md` is the implementation source of truth. These ADRs are the earlier domain-modeling trail. Keep them for history. Do not treat a superseded ADR as current.

| ADR | Status vs spec |
|-----|----------------|
| 0001 One Slack workspace per deployment | Holds |
| 0002 Persist invocation inputs for recovery | Holds |
| 0003 Serialize runs per conversation | Holds |
| 0004 Settle submissions at human waits | Holds |
| 0005 One conversation object per Slack thread | Holds |
| 0006 Git as portable workspace checkpoint | Holds (spec D8) |
| 0007 Canonical append-only event log | Holds. How much maps onto Flue persistence is still an M1 question |
| 0008 Separate working context from canonical history | Holds |
| 0009 Flue as conversation runtime | Holds |
| 0010 Flue channels, defer Chat SDK | Holds. Spec §4.1 is this, via `@flue/slack` |
| 0011 One live run card per submission | Holds |
| 0012 Cloudflare control plane vs AWS sandboxes | Superseded. Control plane stays on Cloudflare. Sandbox provider is Daytona, not AgentCore |
| 0013 Credentials stay outside sandboxes | Holds (spec D6, D11). Proxy itself is M2 |
| 0014 Unknown remote tool outcomes | Principle holds (spec D9). The AgentCore one-shot mechanic is superseded by spec §4.4 (`commandId` markers and reconciling) |
| 0015 Daytona for sandbox compute | Holds (spec D2). Direct Durable Object control; container filesystem persists across stop/start; Git remains recovery truth |
