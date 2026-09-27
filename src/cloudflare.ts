// Worker-level Cloudflare code lives here; HTTP routing stays in src/app.ts.
//
//   - Named exports become top-level Worker exports — e.g. application-owned
//     Durable Object classes (declare their bindings in wrangler.jsonc).
//   - An optional default export adds non-HTTP handlers: scheduled (cron),
//     queue consumers, inbound email, etc. (never `fetch`).
//
// https://flueframework.com/docs/guide/cloudflare-target/#extending-cloudflarets-entrypoint

import { setProvider } from '@flue/runtime';
import { env } from 'cloudflare:workers';
import { createOpenAICodexProvider } from './agents/openai-codex-route.ts';
import { codexAuth } from './integrations/codex-auth/codex-auth-binding.ts';

export { CodexAuth } from './integrations/codex-auth/codex-auth-object.ts';

// The ChatGPT Model Route gets its access token from `CodexAuth`. This module
// is part of the one Worker bundle, and each Coworker Durable Object runs in
// an isolate that loads that bundle, so every Coworker has the provider.
// `flue run` never loads this file and stays on OpenCode Go.
setProvider(createOpenAICodexProvider(() => codexAuth(env).accessToken()));
