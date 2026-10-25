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
import { createD1PlanningStore } from './planning/d1-decision-log.ts';
import { setPlanningStore } from './planning/planning-store.ts';
import { createArtifactStore } from './visuals/artifact-store.ts';
import { renderVisual } from './visuals/render.ts';
import { publicOrigin, setVisualRuntime } from './visuals/visual-runtime.ts';
import { createWalkthroughPublisher } from './walkthroughs/publish.ts';
import { accessConfiguration } from './auth/access.ts';

export { CodexAuth } from './integrations/codex-auth/codex-auth-object.ts';

// The ChatGPT Model Route gets its access token from `CodexAuth`. This module
// is part of the one Worker bundle, and each Coworker Durable Object runs in
// an isolate that loads that bundle, so every Coworker has the provider.
// `flue run` never loads this file and stays on OpenCode Go.
setProvider(createOpenAICodexProvider(() => codexAuth(env).accessToken()));

// Planning decisions live in APP_DB. Every Coworker isolate loads this module,
// so every Coworker mounts the planning tools. `flue run` never loads this
// file, so planning tools are absent there.
setPlanningStore(createD1PlanningStore(env.APP_DB));

// Rendered visuals and browsing (ADR 0025) need Browser Run, the artifact
// bucket, and a public origin that serves the `/render/` templates. Without
// all three the Coworker mounts no visual tools.
const origin = publicOrigin(env);

if (env.BROWSER && env.ARTIFACTS && origin) {
	const browser = env.BROWSER;

	const publishWalkthrough = accessConfiguration(env)
		? createWalkthroughPublisher({
				bucket: env.ARTIFACTS,
				origin,
				render: ({ source, conversationId, headSha }) =>
					renderVisual({
						browser,
						origin,
						kind: 'walkthrough',
						source,
						context: { conversationId, headSha },
					}),
			})
		: undefined;

	setVisualRuntime({
		render: ({ kind, source }) => renderVisual({ browser, origin, kind, source }),
		browser,
		artifacts: createArtifactStore(env.ARTIFACTS),
		publishWalkthrough,
	});
} else {
	console.warn(
		'[visuals] BROWSER, ARTIFACTS, or public origin missing or invalid; visual tools are off',
	);
}
