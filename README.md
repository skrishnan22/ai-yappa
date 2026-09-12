# slack-agent

Slack-native engineering coworker. Investigates a repo, makes changes, and opens PRs. It never merges or deploys.

Built as a Flue app on the Cloudflare target. Execution is Daytona container Sandboxes, not Cloudflare Sandbox. A stopped container retains its filesystem but loses RAM and running processes. The model is OpenCode Go (`opencode-go/deepseek-v4-flash`).

## Setup

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
CAPABILITY_PRIVATE_KEY=
CAPABILITY_PUBLIC_KEY=
CAPABILITY_KID=
```

`GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` are optional. If both are set, hydration configures that identity in the cloned repo (GitHub App bot: `{slug}[bot]` / `{id}+{slug}[bot]@users.noreply.github.com`). If neither is set, commits would otherwise be `root` — do not guess. If only one is set, boot fails.

GitHub App and capability keys are M2. Hydration still runs a public clone without them; GitHub tools return a configuration error instead of calling GitHub. Generate an Ed25519 keypair for the capability keys (`generateKeyPairSync('ed25519')`, PKCS8/SPKI PEM, `kid` = first 8 hex chars of SHA-256 of the public PEM). `GITHUB_APP_PRIVATE_KEY` is the RSA `.pem` GitHub downloads for the App — not the Ed25519 capability key. PEM values may use `\n` in `.dev.vars`. The GitHub App needs `contents` + `pull_requests` on the pilot repo.

`npm run dev` runs under the Cloudflare Vite plugin, which reads Worker secrets from `.dev.vars`, not `.env`. Copy the same values there:

```sh
cp .env .dev.vars
```

`flue run` reads `.env`. `TUNNEL_HOSTNAME` is only for local Vite; it does not need to be a Worker secret.

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

Use a Cloudflare account that is not the Codevil account. `npx wrangler secret put OPENCODE_API_KEY` (and the Slack/Daytona secrets). Do not put them in git.

## Learn more

- `SLACK_AGENT_SPEC.md` — v1 design
- `SLACK_AGENT_HANDOFF.md` — M1 acceptance
- [Flue docs](https://flueframework.com/docs/) or `npx flue docs`
