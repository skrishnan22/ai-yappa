# Open MCP catalog with deployment-scoped secrets

Status: accepted

Ease of adding integrations outweighs per-tool proxy gating for remote MCP servers. The Coworker mounts a deploy-time **Integration Catalog** of MCP URLs via Flue `useMcpConnection`, authenticates with **deployment Worker secrets** (one shared deployment identity), and exposes every discovered tool to the model. For MCP calls, the server's tool surface and the provider-enforced credential scopes are the action boundary; the harness adds no per-operation authorization layer. The GitHub App **Credential Proxy** remains the existing trusted native path for branch/PR/checkpoint operations; open MCP does not replace it.

## Context

Native tools today are hand-written Flue `defineTool` wrappers over `executeProxy` ([`src/agents/github-tools.ts`](../../src/agents/github-tools.ts), [`src/proxy/`](../../src/proxy/)). That path enforces D13/D14: repository and permissions come from trusted conversation context, not the model. It does not scale to “add Linear / Cloudflare / Notion this afternoon.”

Flue already provides `defineMcpConnection` / `useMcpConnection`: connect to a remote MCP, discover tools, mount them as `mcp__{name}__{tool}`. Auth is a static bearer or a resolver function; Flue does not store tokens.

We chose **open MCP** (mount all tools from each catalogued server) and **deployment-scoped secrets** (Wrangler secrets in deployment; `.env` and `.dev.vars` locally; not per-Slack-user OAuth). Rejected: reviewed adapter-per-op catalogs, allowlisted auto-import with read-only enforcement in code, and per-user consent flows.

## Decision

1. **Integration Catalog** — a small deploy-time module lists MCP servers `{ name, url, authEnv, optional? }`. `optional` defaults to `true`. Adding a server is one catalog row + one Worker secret.
2. **Open mount** — no default `tools` allowlist; every tool the server advertises is model-callable. Operators may later trim for context size, not as the security boundary.
3. **Deployment secrets** — resolve `process.env[authEnv]` at Coworker render, not at module initialization. One Slack Agent Deployment → one shared credential identity. Catalog secrets remain outside the fixed boot schema so an optional integration does not become an application-wide requirement. No in-thread OAuth and no token store.
4. **Brain-side only** — MCP traffic stays in the Worker / conversation owner. Reusable MCP tokens never enter Daytona. Authenticated `gh` / `wrangler` in the sandbox stay rejected (spec Appendix A).
5. **Hybrid GitHub** — keep the Credential Proxy for `create_working_branch`, `open_pull_request`, and `checkpoint_working_branch` (deterministic branch name, App install token, one-shot sandbox push). Optional GitHub MCP in the catalog may add extra read/search tools; it does not replace checkpoint.
6. **Optional servers** — a missing secret skips an optional catalog entry and emits a credential-free warning; a missing secret for `optional: false` fails before model execution. Once mounted, `optional` is passed to Flue so connection or discovery failure removes that server’s tools for the submission instead of failing it. The next submission tries again.
7. **Unknown outcomes** — MCP tools remain ordinary Flue tools, not `durable: true` wrappers. If Worker recovery finds one unresolved, Flue records an explicit unknown outcome and does not re-execute that call. An MCP timeout or disconnect returned normally by the client may instead arrive as an error even though the provider applied the mutation. Coworker instructions therefore treat uncertain transport errors as potentially unknown: do not intentionally issue an equivalent effectful call again; report the ambiguity to the human. This is a model reliability policy, not a hard authorization gate. V1 adds no generic mutation classifier, retry registry, or reconciliation adapter.

## Flow

```text
                    deploy-time
  ┌─────────────────────────────────────────────┐
  │ Integration Catalog                         │
  │  cloudflare → mcp.cloudflare.com            │
  │    authEnv = CLOUDFLARE_MCP_API_TOKEN       │
  │  (later) other MCP rows…                    │
  └───────────────────┬─────────────────────────┘
                      │
                      ▼
Slack mention ──► Coworker render
                      │
        ┌─────────────┼──────────────────────────┐
        ▼             ▼                          ▼
  useMcpConnection  githubTools (native)    useSandbox
  (each catalog     create_working_branch   Daytona
   row with secret) open_pull_request       no MCP tokens
                    checkpoint_working_branch
        │             │
        │             ▼
        │        Credential Proxy
        │        (GitHub App key →
        │         install tokens;
        │         OperationContext)
        ▼
  Remote MCP server
  Authorization: Bearer <deployment secret>
  tools/list → mount mcp__name__tool
        │
        ▼
  Model calls mcp__… or native tools
  (results are observations; never credentials)
```

**Add a new MCP (happy path)**

1. Create or obtain a deployment API token scoped as tightly as the operator accepts.
2. `wrangler secret put THAT_TOKEN` for deployment; add the same value to `.env` for `flue run` and `.dev.vars` for `npm run dev`.
3. Append `{ name, url, authEnv: 'THAT_TOKEN', optional: true }` to the catalog.
4. Redeploy. Next Coworker submission connects, discovers tools, mounts them.

**Runtime (one submission)**

1. Slack ingress admits the invocation; Coworker renders with catalog + native tools + sandbox.
2. Coworker resolves each catalog row against the current environment. It skips missing optional credentials, rejects missing required credentials, and passes resolved definitions to Flue with Bearer auth.
3. The model may call any mounted MCP tool or native GitHub tool. MCP calls hit the remote server with the deployment secret; the model never sees the secret.
4. Checkpoint still goes native → proxy `vendPushToken` → one sandbox `git push` → revoke.

**Cloudflare example**

| Piece | Choice |
|-------|--------|
| Catalog URL | `https://mcp.cloudflare.com/mcp` |
| Secret | `CLOUDFLARE_MCP_API_TOKEN` (operator-scoped; prefer read-only for pilots; not Wrangler's `CLOUDFLARE_API_TOKEN`) |
| Model tools | Whatever that MCP exposes (e.g. search/execute), all mounted |
| Not used | `wrangler login` in Daytona; per-user OAuth to mcp.cloudflare.com |

**GitHub example**

| Need | Path |
|------|------|
| Issue/PR search via MCP (optional later) | Catalog MCP + `GITHUB_MCP_TOKEN` or similar |
| Working branch, open PR, checkpoint push | Native `githubTools` + App private key in Worker |
| `gh auth` / `GH_TOKEN` in sandbox | Forbidden |

## Implementation contract

- Add one small catalog/resolver module. Keep catalog data static and reviewed; neither the model nor Slack input may choose a server URL, secret name, headers, or `optional` policy.
- Resolve credentials from an injected environment map so behavior is unit-testable, then call the resolver from Coworker with the current `process.env`. Return only resolved MCP definitions; never return or log credential values.
- Call `useMcpConnection` during Coworker render for every resolved definition. Do not connect at module scope, wrap discovered tools, mark them durable, add an MCP tool allowlist, or route them through `executeProxy`.
- Update Coworker instructions to say that native GitHub tools stop at branch/PR/checkpoint while mounted MCP tools may exercise the deployment-selected authority. Also instruct Coworker not to reissue an effectful MCP call after an uncertain timeout, disconnect, or unknown-outcome result; it must explain the ambiguity in the Slack thread.
- Keep optional MCP availability separate from application boot. An unavailable optional server must not prevent Slack, native GitHub tools, or the sandbox from working.
- Document the catalog row and secret setup in `README.md`, including both local secret files. Do not add actual secret values or print them during verification.

Expected implementation surface: one catalog/resolver module with colocated tests, the Coworker mount, the Coworker instruction text and test, and the MCP setup section in `README.md`. No database, OAuth route, sandbox credential, proxy operation, or new Durable Object is required.

## Acceptance criteria

1. A catalog entry with a non-empty injected secret resolves to the same static name, URL, and optional policy plus Bearer auth; invalid or empty catalog fields fail validation without exposing secret values.
2. A missing optional secret omits only that connection and emits a credential-free warning. A missing required secret fails before model execution and names the missing environment key, never its value.
3. Coworker mounts each resolved definition through `useMcpConnection`; no MCP credential is passed to `useSandbox`, a sandbox command, a model-visible tool argument, or a tool result.
4. Flue connection/discovery failure for an optional server leaves the rest of the submission usable. Its next submission attempts the connection again.
5. Coworker instructions distinguish native and MCP authority and contain the uncertain-outcome/no-reissue rule. Existing native GitHub tool behavior is unchanged.
6. Unit tests cover catalog validation, present/missing optional/missing required credentials, and secret redaction. Existing tests, typecheck, lint, and build pass.
7. With a real read-scoped `CLOUDFLARE_MCP_API_TOKEN`, a deployed smoke test discovers the Cloudflare `search`/`execute` tools and completes one harmless read. Report the live check separately; do not claim it passed when credentials or network access are unavailable.

## Consequences

- **Blast radius** for MCP is the deployment token’s scopes. Prompt injection can invoke any mounted MCP tool. Code no longer enforces “GET-only Cloudflare” for MCP-backed calls; secret minting is the control.
- **D13/D14** still bind **native** Credential Proxy ops. They do **not** constrain open MCP mounts.
- **D6/D11** still hold: reusable credentials stay out of the sandbox; checkpoint remains the only short-lived sandbox token exception.
- **D10** defines MCP authority as deployment-chosen rather than a universal harness ban. The model may exercise the union of every mounted MCP tool and its credential's provider-enforced scopes, including merge, deploy, or infrastructure writes when the operator grants them.
- Open mounting cannot provide generic mutation classification or reconciliation, particularly when one tool such as Cloudflare `execute` can perform reads or writes. Flue preserves unknown outcomes caused by runtime interruption; uncertain transport errors are surfaced through the Coworker reliability policy.
- Context window grows with every MCP tool schema; huge servers may need a later `tools` trim for cost/quality, separate from authorization.
- OAuth lifecycle support remains out of scope: no authorization redirect/callback, token store, or refresh-token rotation. OAuth-only MCP servers are unsupported for now, including a shared deployment grant. Per-user OAuth and personal MCPs also remain outside this product’s auth model.

## Alternatives

- **Rejected — catalog + typed adapters:** each MCP tool mapped through `executeProxy`. Safest, highest add friction; contradicts the chosen ease goal.
- **Rejected — allowlisted MCP import with enforced read-only:** auto-mount but only allowlisted servers and read-scoped policy in code. Middle ground; still more ceremony than open mount + careful secrets.
- **Rejected — per-Slack-user OAuth:** better least-privilege per human; large product surface (consent UX, token store, refresh, identity map). Deferred indefinitely under deployment-scoped auth.
- **Rejected — authenticated CLIs in Daytona as the integration path:** reusable tokens in the untrusted sandbox; already closed in the spec Appendix A.
