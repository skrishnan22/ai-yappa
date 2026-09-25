# ChatGPT subscription Model Route

Status: accepted

Let Coworker run on a ChatGPT Plus/Pro subscription through pi's `openai-codex` provider. One deployment-wide Codex credential lives in a single `CodexAuth` Durable Object, which owns login, storage, and refresh. When no usable credential exists, the Model Route falls back to OpenCode Go.

## Context

The Model Route today is OpenCode Go, billed per token. The pinned pi version (`@earendil-works/pi-ai` 0.86) ships an `openai-codex` provider that sends requests to `https://chatgpt.com/backend-api`. It authenticates with the OAuth access token of a ChatGPT login and reads the account id from that JWT. No API key exists for this backend.

Flue treats subscription login as out of scope ([withastro/flue#27](https://github.com/withastro/flue/issues/27), [#35](https://github.com/withastro/flue/pull/35)). Flue's model registry is a bare `createModels()` with no credential store, so pi's own OAuth resolution finds no stored token. Flue 2 still lets application code register any pi `Provider` with `setProvider()`, and that provider's `auth.apiKey.resolve()` runs on every model request.

Three properties of the login shape the design:

- **Client.** The OAuth client is the Codex CLI's public client (`app_EMoamEEZ73f0CkXaXp7hrann`), which pi, OpenClaw, and the Codex CLI all hardcode. Its browser redirect is fixed to `http://localhost:1455/auth/callback`. A web redirect back to this Worker is impossible, and third parties cannot register their own client.
- **Device code.** OpenAI's device-code flow works without a redirect. It has no webhook, so the client polls `deviceauth/token` until the user approves. The account must enable "Device code authorization for Codex" in ChatGPT security settings; on Team or Enterprise, a workspace admin must allow it.
- **Rotation.** Refresh tokens rotate on every use and are single-use. A second copy that refreshes causes `refresh_token_reused`. Refresh tokens can also die permanently with `refresh_token_expired` or `refresh_token_invalidated`. OpenAI does not publish the refresh-token lifetime.

pi's contract for this is an application-owned `CredentialStore` passed to `createModels({ credentials })`. `Models.getAuth()` then refreshes inside `store.modify()` so concurrent requests cannot double-refresh. pi's own Slack bot, the coding-agent SDK, and OpenClaw all follow this shape.

## Decision

1. **Provider.** Register a custom `openai-codex` provider from `src/agents/openai-codex-route.ts` with `setProvider()`, built from pi's catalog and Codex Responses API. Its `auth.apiKey.resolve()` returns only an access token. The wrapper forces `transport: 'sse'`, because workerd's `WebSocket` constructor takes no request headers and pi's default WebSocket attempt would fail on every fresh isolate. The default model is `openai-codex/gpt-5.6-sol` at the existing `medium` thinking level.

2. **Credential owner.** A single `CodexAuth` Durable Object (`getByName('default')`) holds a private pi `Models` instance created with `createModels({ credentials })`, with `openaiCodexProvider()` registered and `registerBunOAuthFlows()` called so pi's refresh code bundles into the Worker. Its store implements pi's `CredentialStore` on Durable Object SQLite storage. `modify` is serialized by a per-provider promise chain; because only one instance exists, that chain is the deployment-wide refresh lock. Coworker calls `accessToken()` over RPC. The refresh token never leaves the object.

3. **Protection at rest.** The stored credential is encrypted with AES-GCM under a Worker secret, `CODEX_CREDENTIAL_KEY`. Key rotation is out of scope for v1. The access token never enters model context, a Daytona sandbox, logs, or traces. Flue's `turn_request` observations carry provider, model, and host, not request headers.

4. **Login from Slack.** An admin runs `/coworker openai` with `connect`, `status`, or `disconnect`. Connect and disconnect are limited to a separate admin list in `src/config.ts`. Slash commands are allowed here, as an exception to spec §4.1, because account administration is not thread-scoped and Slack autocompletes registered commands. The device code goes only to the admin through the command's ephemeral response. A code visible to a channel would let any member connect the bot to their own ChatGPT account. `CodexAuth` requests the device code, then polls one request per Durable Object alarm, honoring OpenAI's interval and `slow_down`. It exchanges the approved code at `/oauth/token`, stores `{ access, refresh, expires, accountId }` in pi's credential shape, and edits the admin's message. Disconnect revokes the token at `/oauth/revoke`.

5. **Expiry and failure.** pi refreshes the access token when fewer than five minutes remain, under the lock. A proactive alarm refreshes about a day before expiry. Transient refresh failures keep the credential for the next attempt. `refresh_token_expired`, `refresh_token_reused`, and `refresh_token_invalidated` move the connection to `needs_login`, stop refresh attempts, and DM the admin.

6. **Model Route.** Coworker uses the ChatGPT route when the Codex credential is usable. Otherwise it uses OpenCode Go, and the Live Run Card names the route. This is a deployment-level credential fallback, not per-user model selection. `OPENCODE_API_KEY` remains required. `flue run` stays on OpenCode Go because no Durable Object exists there.

## Consequences

- Model spend moves to one person's ChatGPT subscription and its rolling usage limits. That person's account is shared by every Coworker conversation in the deployment.
- The deployment depends on OpenAI tolerating third-party use of the Codex client and its undocumented backend. A change to the client id, device-code endpoints, or Codex API breaks login or inference until pi, or our device-code requests, catch up. OpenCode Go stays configured as the fallback.
- The ChatGPT route bypasses Cloudflare AI Gateway. The per-conversation budget in the owner still applies; the gateway's monthly cap does not cover this route.
- Only one live copy of the refresh token may exist. Use a dedicated login for the bot, and never seed it from a personal `~/.codex/auth.json` that another client keeps refreshing.
- Rollout is incremental. Before `CodexAuth` exists, the provider reads a hand-supplied `OPENAI_CODEX_ACCESS_TOKEN` for local verification, and that path is removed once Slack login lands.

## Alternatives

- **OpenAI-compatible proxy over `~/.codex/auth.json`** (for example `openai-oauth`): rejected because it needs a separate always-on Node host, and its authors warn against exposing it publicly.
- **Application-owned refresh instead of pi's `CredentialStore` contract:** rejected because pi already implements double-checked, locked refresh. `registerBunOAuthFlows()` removes the Worker bundling obstacle.
- **Workers KV, R2, or D1 for the credential:** rejected because none can hold a lock across the refresh network call. KV is eventually consistent. R2 compare-and-swap detects the race only after the loser has spent the old refresh token. D1 has no interactive transactions.
- **Worker secrets or Secrets Store for the credential:** rejected because they are read-only at runtime and cannot store the rotated refresh token. A Worker secret holds only the encryption key.
- **Browser redirect login:** rejected because the Codex client's redirect is fixed to localhost. The paste-the-redirect-URL flow remains a manual fallback only.
- **Mention command (`@Coworker connect openai`):** rejected in favor of a slash command, which Slack autocompletes and answers ephemerally.
