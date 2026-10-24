# Lantern Walkthroughs Implementation Plan

**Goal:** Let Coworker author and publish an interactive PR explanation using its existing implementation context.

**Architecture:** A bounded structured format supplies components, edges and up to six steps. Trusted browser code builds a Lantern scene with a fixed layout and renders all step endpoints into one contact sheet. The existing Browser Run renderer captures it in one session. R2 stores the scene and PNG/JPEG under a persistent `walkthroughs/` prefix, indexed by a conversation-scoped content hash. Hono serves unlisted immutable scene links using a trusted static player. Cache hits skip Browser Run. Browser session duration is logged as an estimate, never billed usage.

**Tech stack:** TypeScript, Valibot, pi AgentTool, Lantern pinned to upstream commit 2c7bad533be25fbd56d26a9a2b6c5651743f011e, Browser Run, R2, Hono, Vite, Vitest, local Chromium.

## Constraints

- Execute sequentially in the existing `t3/add-lantern-to-prs` worktree.
- No additional model call, deployment skill, GitHub Action, PR update API or infrastructure provisioning.
- No model-authored JavaScript/HTML; layout and timing belong to trusted code.
- Links are unlisted public bearer links; publish only material suitable for the PR's audience.
- Persistent storage uses a separate prefix from `artifacts/`, whose existing lifecycle expires after 15 days.
- Maximum four nodes and six steps; code and captions are bounded, and references must address the supplied repository and head SHA.
- Preserve existing visual tools and their image-content transport through SandboxFactory.tools.

## 1. Format, publishing and public routes

- [x] Add `src/walkthroughs/format.ts`: validate source provenance, bounded content, unique node/step IDs, edge/focus references and code highlights. Infer the domain type from the Valibot schema.
- [x] Add `src/walkthroughs/publish.test.ts` before implementation: exercise publish/cache behavior, conversation isolation, rendering failure retry, and public retrieval. Invalid input must fail before rendering or writes.
- [x] Add `src/walkthroughs/publish.ts`: canonicalize validated input, hash with conversation and renderer version, render once, persist immutable random-id scene and PNG/JPEG plus cache index, return stable public URLs and preview bytes.
- [x] Add `src/walkthroughs/routes.ts`: serve HTML and PNG by validated random ID with strict CSP, no indexing/referrer leakage, escaped JSON data and fixed trusted assets. Add route tests for missing IDs, escaping and content types.

## 2. Lantern rendering and preview

- [x] Pin the upstream dependency; adapt only package export metadata if the unpublished source archive lacks dist/.
- [x] Add `render/walkthrough-scene.ts`: translate typed input to a deterministic animated scene with centered node labels, code highlights and named steps.
- [x] Add `render/walkthrough.ts`, `public/render/walkthrough.html`: render the endpoint of each named step into one two-column contact sheet without waiting for real-time playback.
- [x] Add a trusted player and stylesheet under render/public, supporting step selection, play/pause, keyboard navigation, captions and source links.
- [x] Extend `renderVisual` internally for the walkthrough template, keeping the public render_visual kinds unchanged. Emit one structured session-duration log in finally including failed sessions.
- [x] Extend the existing real-Chromium renderer test to prove the generated sheet contains every step and one navigation/session, with screenshot budgets preserved.

## 3. Coworker integration and acceptance

- [x] Add `src/walkthroughs/tool.ts`: render_walkthrough accepts structured fields with an example in its description, publishes and returns public links plus the contact-sheet image when the model accepts images.
- [x] Wire the publisher from cloudflare.ts through the visual runtime to the existing sandbox tools. Keep runtime optional outside Cloudflare.
- [x] Add PR guidance to coworkerInstructions: generate after checkpoint, inspect preview, link in open_pull_request body; report generation failures and retain normal PR creation.
- [x] Add docs explaining the public-link boundary, retention prefix, cache behavior and approximate duration logging.
- [x] Run focused tests, then types, lint, formatting, build and the full test suite. Verify a real local player and tool-to-route result using the PR #67 example. Inspect the final diff.

## Evidence

Baseline: pnpm install --frozen-lockfile; 55 test files / 534 tests passed.

Final verification: 58 test files / 548 tests passed; types, lint, formatting and diff whitespace checks passed. Real Chrome verifies the contact sheet, public player links and play/pause; a local PR #67 player was visually inspected. Cloudflare Browser Run transport and production R2 publication have not been exercised or deployed.
