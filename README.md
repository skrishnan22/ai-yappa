# slack-agent

Slack-native engineering coworker. Investigates a repo, makes changes, and opens PRs via native GitHub tools. Mounted MCP tools may exercise the authority of the deployment-scoped secrets you configure.

Built as a Flue app on the Cloudflare target. Execution is Daytona container Sandboxes, not Cloudflare Sandbox. A stopped container retains its filesystem but loses RAM and running processes. The model is OpenCode Go: `deepseek-v4.1-flash` if [models.dev](https://models.dev/providers/opencode-go/) lists it, otherwise bundled `deepseek-v4-flash`.

## Setup

Requires Node.js 22.22.1 or later (`lint-staged` 17) and [gitleaks](https://github.com/gitleaks/gitleaks#installing) 8 on PATH (`brew install gitleaks`).

```sh
npm install
```

Fill `.env` (never commit it):

```
OPENCODE_API_KEY=
SLACK_SIGNING_SECRET=
SLACK_BOT_TOKEN=
DAYTONA_API_KEY=
TUNNEL_HOSTNAME=
GIT_AUTHOR_NAME=
GIT_AUTHOR_EMAIL=
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_INSTALLATION_ID=
CLOUDFLARE_MCP_API_TOKEN=
HONEYCOMB_MCP_API_TOKEN=
LANGFUSE_MCP_BASIC_AUTH=
EXA_API_KEY=
PARALLEL_API_KEY=
```

`GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` are optional. If both are set, hydration configures that identity in the cloned repo (GitHub App bot: `{slug}[bot]` / `{id}+{slug}[bot]@users.noreply.github.com`). If neither is set, commits would otherwise be `root` — do not guess. If only one is set, boot fails.

`CLOUDFLARE_MCP_API_TOKEN` and `HONEYCOMB_MCP_API_TOKEN` are optional catalog auth for the Cloudflare and Honeycomb MCP rows (see [MCP Integration Catalog](#mcp-integration-catalog)). They are not part of the fixed boot schema; leave a value empty to skip that server. Do not name the Cloudflare MCP secret `CLOUDFLARE_API_TOKEN` — Wrangler uses that variable to authenticate CLI calls.

`LANGFUSE_MCP_BASIC_AUTH` is the base64 encoding of the US project's
`public-key:secret-key`. It is optional; leave it empty to skip Langfuse trace analysis.

`EXA_API_KEY` and `PARALLEL_API_KEY` are optional. When at least one is set, Coworker mounts native `web_search` / `web_fetch` tools that call those providers' REST APIs (Exa first, then Parallel on HTTP 402/429/503). Tool output is `{ provider, searchResults|fetchResults }` with the provider's own JSON body. Missing both keys skips the tools. Keys stay Worker-side; they never enter Daytona.

GitHub tools require `GITHUB_APP_ID`, the RSA `.pem` GitHub downloads for `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_INSTALLATION_ID`. PEM values may use `\n` in `.dev.vars`. Install the App only on the enrolled pilot repository. Its minimum application permissions are **Contents: Read and write**, **Pull requests: Read and write**, and **Issues: Read-only** (GitHub grants metadata read access automatically); do not grant administration, workflows/actions, deployments, secrets, or merge bypass.

Ordinary GitHub operations use repository-scoped installation tokens that remain inside trusted Worker code. Checkpoint push creates a fresh token with exactly `contents:write`, injects it into one sandbox `git push` process, confirms the remote branch SHA, and immediately revokes it. The model never receives this token, but code in the same sandbox may observe or exercise it during that bounded window; this is not strict sandbox credential isolation.

`npm run dev` runs under the Cloudflare Vite plugin, which reads Worker secrets from `.dev.vars`, not `.env`. Copy the same values there:

```sh
cp .env .dev.vars
```

`flue run` reads `.env`. `TUNNEL_HOSTNAME` is only for local Vite; it does not need to be a Worker secret.

## MCP Integration Catalog

Remote MCP servers are listed in `src/integrations/mcp-catalog.ts` and mounted on Coworker via Flue `useMcpConnection`. Auth is a deployment Worker secret (Bearer by default, or Basic for a reviewed catalog row). Neither the model nor Slack input may choose a server URL, secret name, tool allowlist, or optional policy.

To add a server:

1. Mint an API token scoped as tightly as you accept (prefer read-only for pilots).
2. Put the value in `.env` (for `flue run`) and `.dev.vars` (for `npm run dev`). For production: `npx wrangler secret put THAT_TOKEN`.
3. Append `{ name, url, authEnv: 'THAT_TOKEN', optional: true }` to `INTEGRATION_CATALOG`.
4. Redeploy (or restart local). The next Coworker submission resolves the secret at render, connects, discovers tools, and mounts them as `mcp__<name>__<tool>`.

The shipped catalog includes optional Cloudflare MCP (`https://mcp.cloudflare.com/mcp`, `CLOUDFLARE_MCP_API_TOKEN`), optional Honeycomb MCP (`https://mcp.honeycomb.io/mcp`, `HONEYCOMB_MCP_API_TOKEN`), and Langfuse US MCP (`https://us.cloud.langfuse.com/api/public/mcp`, `LANGFUSE_MCP_BASIC_AUTH`). Honeycomb needs a Management API key in `KEY_ID:SECRET_KEY` form with Model Context Protocol and Environments read scopes; prefer read-only for pilots, and do not reuse the ingest key used for Workers Observability destinations. Langfuse mounts only read tools for observations, metrics, scores, and health. Coworker uses them only when the Slack request explicitly asks to analyze or improve a completed run. A missing optional secret skips only that connection and logs a credential-free warning; Slack, native GitHub tools, and the sandbox still work. Required rows (`optional: false`) fail before the model runs and name the missing env key, never its value. Reusable MCP tokens never enter Daytona; authenticated `wrangler` / `gh` in the sandbox stay rejected. Native `create_working_branch` / `open_pull_request` / `checkpoint_working_branch` remain the GitHub App Credential Proxy path.

Do not paste real secret values into git, chat, or logs.

## Slack app

Do not pick Slack’s Bolt, AI assistant, or workflow templates. Those enable Socket Mode and Assistant threads, which this app does not use.

1. Open [api.slack.com/apps](https://api.slack.com/apps) → **Create New App**.
2. Choose **From a manifest**. Pick your workspace.
3. Paste `slack-app-manifest.yaml`. Create.
4. **Install to Workspace**. Copy **Signing Secret** (Basic Information) and **Bot User OAuth Token** (`xoxb-…`, OAuth & Permissions) into `.env` and `.dev.vars`.

Event Subscriptions come after `npm run dev` plus a tunnel, because Slack must verify `https://<host>/channels/slack/events`. Then subscribe the bot to `app_mention`, `message.channels`, and `message.groups`. Reinstall if Slack asks.

## What "local" covers

The control plane (`vite dev` or `flue run`) runs on your machine. OpenCode Go and Daytona do not. Slack Events API needs a public URL, so a tunnel sits in front of localhost.

There is no fully offline loop.

## Agent only (no Slack)

Needs OpenCode Go and Daytona credentials. Pass the same `initialData` Slack would:

```sh
npx flue run src/agents/coworker.ts \
  --id local-1 \
  --data '{"channelId":"C_LOCAL","threadTs":"1.0","startedAt":"2026-08-30T00:00:00.000Z","repo":"https://github.com/org/pilot"}' \
  --message "What does package.json name this workspace?"
```

This exercises the model and the sandbox. Create hydrates `/workspace/repo` in owner code (shallow clone + lockfile install) before the model runs. A later create that reuses the same Daytona container skips clone/install when `/workspace/.workspace_ready` still matches that repo. Stop/start keeps the filesystem (`node_modules` survive); processes do not. The model does not bootstrap the repo. Without `SLACK_BOT_TOKEN`, the reply tool prints the text and does not call Slack.

## Slack end to end (local control plane)

Cloudflare quick tunnels mint a new `*.trycloudflare.com` host every process. A Cloudflare named tunnel needs a hostname on a zone you already own.

A free ngrok account includes one assigned `*.ngrok-free.app` host that stays the same. You cannot pick the name. That is enough for Slack Events without paying or using your own domain.

One-time:

1. Install ngrok (`brew install ngrok/ngrok/ngrok`).
2. Create a free account, copy the authtoken from [the ngrok dashboard](https://dashboard.ngrok.com/get-started/your-authtoken), and run `ngrok config add-authtoken <token>` locally. Do not put the token in git or in chat.

```sh
npm run tunnel:setup
```

Setup writes the assigned host into `TUNNEL_HOSTNAME`. Then:

1. `npm run dev` (default `http://localhost:5173`).
2. `npm run tunnel`.
3. Slack Events URL, once: `https://<assigned-host>/channels/slack/events`. Subscribe to `app_mention` and thread `message` events. Scopes: `app_mentions:read`, `chat:write`, channel history.
4. Mention the bot in a mapped channel.

Stop with `npm run tunnel:stop`. Free ngrok also shows a browser warning page. Slack's event POSTs skip that. If you open the URL in a browser, click through once.

A threaded reply that reflects work in the already-cloned repo (not clone/`ls` as the job) is the hydration slice. M3 adds a live run card in the thread (one Slack message per submission, edited in place, plus a short ping when the submission settles) and attaches thread history on wake. Seed images with repo+deps baked in wait for M4.

## Deploy

```sh
npm run deploy
```

Use a Cloudflare account that is not the Codevil account. `npx wrangler secret put OPENCODE_API_KEY` (and the Slack/Daytona/GitHub secrets). Optional catalog secrets such as `CLOUDFLARE_MCP_API_TOKEN`, `HONEYCOMB_MCP_API_TOKEN`, and `LANGFUSE_MCP_BASIC_AUTH` use the same command, as do optional web-search keys `EXA_API_KEY` and `PARALLEL_API_KEY`. If `CLOUDFLARE_API_TOKEN` is set in the shell (or `.env`) to an MCP-scoped token, unset it for Wrangler commands so the CLI can use `wrangler login` or a token with **Workers Scripts Write**. Do not put secrets in git.

## Observability

The Worker uses Cloudflare's native Workers Logs and Workers Traces. Flue provides the
`invoke_agent`, `chat`, and `execute_tool` spans automatically; `src/app.ts` installs
`createCloudflareTracing()` with full content for this single-user pilot. Prompts,
responses, tool arguments, and tool results are therefore exported to both Honeycomb
and Langfuse. The small `slack_admission` log remains the only application-owned
semantic event.

Destination credentials belong to the Cloudflare account, not source control. The
checked-in Wrangler config expects the existing `honeycomb-logs` and
`honeycomb-traces` destinations plus `langfuse-us-traces`.

To add Langfuse without replacing Honeycomb:

1. Create a project at `https://us.cloud.langfuse.com` and copy its public and secret
   project keys.
2. Base64-encode the literal `public-key:secret-key` pair. Store that encoded value as
   the Worker secret `LANGFUSE_MCP_BASIC_AUTH` and in local `.env` / `.dev.vars`.
3. In Cloudflare Dashboard → Workers Observability → Destinations, create a **Traces**
   destination named `langfuse-us-traces` with endpoint
   `https://us.cloud.langfuse.com/api/public/otel/v1/traces`.
4. Add destination headers `Authorization: Basic <encoded-value>` and
   `x-langfuse-ingestion-version: 4`, then redeploy.

The existing Honeycomb destinations remain configured as follows:

1. In Honeycomb, create an ingest API key for the target environment with permission
   to create services/datasets. Store it only in the Cloudflare destination settings.
2. In Cloudflare Dashboard → Workers Observability → Destinations, add a **Traces**
   destination named `honeycomb-traces`, endpoint
   `https://api.honeycomb.io/v1/traces`, with custom header `x-honeycomb-team` set to
   the Honeycomb key.
3. Add a **Logs** destination named `honeycomb-logs`, endpoint
   `https://api.honeycomb.io/v1/logs`, with the same custom header.
4. After saving both destinations, keep their exact names in `wrangler.jsonc`. The
   resulting export block is:

```jsonc
"observability": {
  "enabled": true,
  "logs": {
    "enabled": true,
    "destinations": ["honeycomb-logs"],
    "head_sampling_rate": 1,
    "persist": true
  },
  "traces": {
    "enabled": true,
    "destinations": ["honeycomb-traces", "langfuse-us-traces"],
    "head_sampling_rate": 1,
    "persist": true
  }
}
```

Start at 100% sampling while traffic is low. Confirm that Honeycomb receives logs and
traces and Langfuse receives traces, then set `persist: false` for each section if
Cloudflare dashboard retention is not needed. Cloudflare OTLP export is
currently beta, requires Workers Paid or higher, and its pricing/availability can
change; check the account's current Workers Observability terms before enabling it.
As of the current beta terms, Workers Paid includes 10 million trace events and 10
million log events per month separately, then charges $0.05 per additional million.
Cloudflare dashboard persistence is a
separate meter (20 million events per month included, then $0.60 per additional
million); `persist: false` avoids that dashboard-storage meter but does not remove
OTLP export charges. Recheck both figures after October 1, 2026.

## Learn more

- `SLACK_AGENT_SPEC.md` — v1 design
- `SLACK_AGENT_HANDOFF.md` — M1 acceptance
- [Flue docs](https://flueframework.com/docs/) or `npx flue docs`
