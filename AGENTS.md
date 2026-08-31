# AGENTS.md

This is a [Flue](https://flueframework.com) project: agents are TypeScript functions.

Implementation source of truth: `SLACK_AGENT_SPEC.md`. Milestone scope: `SLACK_AGENT_HANDOFF.md`. Glossary: `CONTEXT.md`. ADR status: `docs/adr/README.md`.

## Layout

- `src/agents/` — agent modules. `'use agent'` at the top; every exported capitalized function is an agent. `Coworker` is the conversation owner. Dispatch-only; do not mount `createAgentRouter` for it.
- `src/channels/slack.ts` — verified Slack ingress. A mention may create a Coworker; an unmentioned thread reply continues only if `getAgentInstance` finds one. Loaded by `app.ts` only, so `flue run` does not need a signing secret.
- `src/channels/slack-reply.ts` — thread-bound reply tool. Without `SLACK_BOT_TOKEN`, the tool returns the text and does not post.
- `src/sandboxes/daytona.ts` — Flue `SandboxFactory` over an already-created Daytona container sandbox. Application code owns create/stop/start; stop/start preserves files but not RAM or processes.
- `src/config.ts` — channel→repo map and invoker allowlist. Fail closed when empty.
- `src/app.ts` — route map. Slack channel only.
- `src/cloudflare.ts` — Worker-level exports and non-HTTP handlers.
- `wrangler.jsonc` — Worker config; every agent needs a Durable Object migration entry (`Coworker` → `FlueCoworkerAgent`).

## Commands

- `npx flue run src/agents/coworker.ts --message "Hi"` — run the agent locally, no server. Slack dispatch will not fire.
- `npm run dev` — start the dev server. Slack Events URL is `/channels/slack/events`.
- `npm run deploy` — build and deploy the Worker.
- `npm run check:types` — typecheck.
- `npx flue docs search <query>` — search the Flue docs from the terminal (then `flue docs read <path>`).
- `npx flue add` — list blueprints for adding channels, sandboxes, and databases.

## Domain docs

Issues and specs as local Markdown: `docs/agents/issue-tracker.md`. Domain context: `docs/agents/domain.md`.
