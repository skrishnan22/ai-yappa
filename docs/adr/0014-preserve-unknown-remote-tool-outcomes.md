# Preserve unknown remote tool outcomes

**Partial supersession, 2026-08-30.** Unknown Tool Outcome still stands (spec D9). Do not follow the AgentCore one-shot / no-registry mechanic. Spec §4.4 is the command protocol: client `commandId`, in-sandbox start/done markers, reconciling from git-observable evidence.

V1 uses AgentCore's native one-shot command execution through Flue's Sandbox Adapter contract without adding a second provider-side command registry. A complete response becomes a Tool Observation; a lost or aborted response whose effects cannot be proven becomes an Unknown Tool Outcome and is never misreported as failure or success. Reads and tests may be rerun under an explicit safe-retry policy, mutations require reconciliation from workspace or integration evidence, and a provider-side registry should be added only if unknown outcomes become operationally significant.
