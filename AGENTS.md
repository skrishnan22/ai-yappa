# AGENTS.md

This is a [Flue](https://flueframework.com) project: agents are TypeScript functions.

Implementation source of truth: `SLACK_AGENT_SPEC.md`. Milestone scope: `SLACK_AGENT_HANDOFF.md`. Glossary: `CONTEXT.md`. ADR status: `docs/adr/README.md`.

## Layout

- `src/agents/` — agent modules. `'use agent'` at the top; every exported capitalized function is an agent. `Coworker` is the conversation owner. Dispatch-only; do not mount `createAgentRouter` for it.
- `src/channels/slack.ts` — verified Slack ingress. A mention may create a Coworker; an unmentioned thread reply continues only if `getAgentInstance` finds one. Loaded by `app.ts` only, so `flue run` does not need a signing secret.
- `src/channels/slash-command.ts` — `/aiyappa openai connect|status|disconnect` and `/aiyappa models`. Connect/disconnect need `codexAdminIds`; status and models also allow invokers. Device codes appear only in the ephemeral reply.
- `src/channels/invocation-args.ts` + `src/agents/model-choice.ts` — `$model:` / `$effort:` in the first mention pick from `modelAliases` in `src/config.ts` (ADR 0021); the choice lives in `initialData.modelChoice`.
- `src/channels/slack-reply.ts` — thread-bound reply tool. Without `SLACK_BOT_TOKEN`, the tool returns the text and does not post.
- `src/sandboxes/daytona.ts` — Flue `SandboxFactory` over an already-created Daytona container sandbox. Application code owns create/stop/start; stop/start preserves files but not RAM or processes.
- `src/integrations/mcp-catalog.ts` — deploy-time Integration Catalog; Coworker resolves Worker secrets at render and mounts via `useMcpConnection`.
- `src/integrations/codex-auth/` — `CodexAuth` Durable Object (one instance, `getByName('default')`) owning the encrypted Codex Credential and pi's locked OAuth refresh. Only access tokens leave it. Exported from `src/cloudflare.ts`.
- `src/integrations/web-search/` — Exa/Parallel REST adapters + optimistic failover router behind native `web_search` / `web_fetch`.
- `src/config.ts` — channel→repo map, invoker allowlist, and Codex admin list. Fail closed when empty.
- `src/app.ts` — route map. Slack channel only.
- `src/cloudflare.ts` — Worker-level exports and non-HTTP handlers.
- `wrangler.jsonc` — Worker config; every agent needs a Durable Object migration entry (`Coworker` → `FlueCoworkerAgent`). Application-owned Durable Objects (`CodexAuth`) also need a hand-declared binding.

## Commands

- `pnpm flue run src/agents/coworker.ts --message "Hi"` — run the agent locally, no server. Slack dispatch will not fire.
- `pnpm run dev` — start the dev server. Slack Events URL is `/channels/slack/events`.
- `pnpm run deploy` — build and deploy the Worker.
- `pnpm run check:types` — typecheck.
- `pnpm test` — Vitest (`src/**/*.test.ts`).
- `pnpm run lint` / `pnpm run fmt:check` — Oxlint and Oxfmt (also CI).
- `pnpm run gitleaks` — local secret scan (`gitleaks` on PATH; `brew install gitleaks`). Pre-commit runs staged lint/format plus `gitleaks:staged`. CI uses `ghcr.io/gitleaks/gitleaks:v8.30.1`.
- `pnpm flue docs search <query>` — search the Flue docs from the terminal (then `flue docs read <path>`).
- `pnpm flue add` — list blueprints for adding channels, sandboxes, and databases.

## Conventions

- Check optional values by truthiness (`if (x)`, `if (!x)`, `x ? a : b`), not `x !== undefined`, when no falsy value is meaningful: objects, arrays, functions, non-empty string-literal unions, and strings or numbers where `''` or `0` would also mean "absent". Keep `=== undefined` where `''`, `0`, or `false` is a real value, and in generics whose type parameter could be falsy. Oxlint cannot enforce this (the anti-slop rules have no type information), so review does.

## Domain docs

Issues and specs as local Markdown: `docs/agents/issue-tracker.md`. Domain context: `docs/agents/domain.md`.
