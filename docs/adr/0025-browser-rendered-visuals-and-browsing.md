# Browser-rendered visuals and browsing

Status: proposed

Coworker renders diagrams, dashboards, and Excalidraw-style explanations in Cloudflare Browser Run and posts them to the bound Slack thread as uploaded PNGs. The same Browser Run binding gives the model web browsing: read-only first, interactive sessions later. Daytona sandboxes are unchanged.

## Context

ADR 0019 gave the model native Slack `data_visualization` and `data_table` blocks and left "browser-based UI verification and diagrams" as future decisions. Native blocks cover simple line, bar, area, and pie charts and sortable tables. They cannot draw architecture diagrams, sequence diagrams, hand-drawn explanations, or composed dashboards, and the model cannot open a web page beyond `web_fetch`.

Slack does not render SVG or HTML inline, so anything richer than Block Kit reaches the thread as an uploaded image. ADR 0019 forbids image blocks and model-chosen URLs because Slack would fetch them; an upload from application storage does not have that problem.

Research, October 2026:

- **Rendering without a browser** works for some formats (D2 `--sketch`, Graphviz, `vl-convert`, ECharts SSR, resvg) and needs about 100–130 MB of sandbox tooling. It does not give mermaid.js fidelity (`look: handDrawn`) or a real Excalidraw export, and the Mermaid ports (`beautiful-mermaid`, `mmdr`) are partial.
- **Chromium in the Daytona sandbox** costs 300 MB or more of disk against the current 3 GB, and 0.3–1 GB of RAM per page next to a dev server. It also requires a sandbox, which conversations without a repository do not have.
- **Cloudflare Browser Run** (formerly Browser Rendering) runs managed browsers next to the Worker. Chromium is the default engine with full JavaScript. Kitesurf (August 2026, opt-in with `browser=kitesurf`) is a lightweight Rust engine with minimal JavaScript, about 58 MiB per screenshot against Chromium's 271 MiB in Cloudflare's benchmark. Workers Paid includes 10 browser-hours a month, then $0.09 an hour. Browser Sessions (binding, Puppeteer, Playwright) also bill concurrency: 10 browsers included, averaged over daily peaks, then $2 each. Quick Actions (`/screenshot`, `/markdown`, `/snapshot`) bill hours only. A render takes about 1–2 seconds.
- **Model reliability:** models write Mermaid most reliably; Excalidraw JSON and raw SVG need a render-and-look loop because the model places coordinates badly. Feeding parser errors back closes most of the gap.
- **Slack upload:** `files.getUploadURLExternal`, POST the bytes, then `files.completeUploadExternal` with `channel_id`, `thread_ts`, and `alt_txt` (1000 characters at most). Needs `files:write`; workspaces can disable uploads.
- **Reference:** Open-Inspect (ColeMurray/background-agents) has the owner, not the model, choose and upload files, with limits of 5 files, 10 MiB each, 25 MiB total, delivered asynchronously. Open-Inspect, Ramp Inspect, and Junior run headless Chromium (`agent-browser` or Playwright) inside the sandbox for UI checks and attach screenshots as evidence.
- **Security practice:** rendered model output that fetches URLs is a known exfiltration path (Markdown image injection); the mitigation is no model-chosen fetches. Pages an agent browses can carry prompt injection, and browsing should use a fresh profile without credentials.

## Decision

1. **One renderer: Browser Run Chromium, called from the Coworker.** Rendering runs on Cloudflare, not in the sandbox, so it works in every conversation and adds nothing to the sandbox image. The Worker gets a `browser` binding.

2. **Rendering tool.** `render_visual({ kind, source, title })` with `kind` one of `mermaid`, `vega-lite`, `echarts`, `excalidraw`, or `html`. The model writes source text; the PNG is the output. Owner code launches a Browser Run Chromium browser from the Durable Object through the `browser` binding (`@cloudflare/puppeteer`; Chromium runs on Cloudflare, driven over the binding), opens an application-owned template for that kind, injects the source, and waits for the template's done-or-error signal. Each call launches its own browser and closes it in `finally`, so a render bills a few seconds of browser time and counts toward concurrency only while it runs; nothing stays open between renders or across a conversation. A render error (for example a Mermaid parse error) returns to the model as a repairable tool error. On success, owner code screenshots the rendered element, checks size and dimensions, stores the PNG, and returns an `artifactId`.

   **The model sees the render before it posts.** The tool result carries the `artifactId` as text and a preview of the PNG as an image block, so the conversation's model can find overlaps, clipped labels, and unreadable text and call `render_visual` again with corrected source. Posting to Slack is a separate step (decision 7), so nothing reaches the thread until the model chooses an artifact.

   Flue cannot do this through `defineTool` or `useTool`: through 2.3.0 the custom-tool wrapper sends every output to the model as `JSON.stringify(output)` text, and MCP tool images become a text placeholder. Tools supplied by a `SandboxFactory`'s `tools` list are pi `AgentTool`s and are wrapped differently: their `content` blocks, images included, reach the model unchanged. The runtime stores those images as conversation attachments, and pi-ai sends them as `input_image` to models whose `input` includes `image`. So the visual tools (`render_visual` here, and the screenshot tools in decisions 9 and 10) are pi `AgentTool`s mounted through the sandbox factory's `tools` list:

   - With a repository, the Daytona factory's list is Flue's standard tools plus the visual tools.
   - Without one, the Coworker mounts a virtual sandbox (`bash()` over an in-memory just-bash) whose list holds only the visual tools, so a chat-only conversation still gets no file or shell tools and no container.

   Every sandbox factory the Coworker mounts goes through one wrapper that appends the visual tools, so they stay available whichever sandbox is mounted and whenever it switches; a later move to mount Daytona only on demand keeps the virtual sandbox as the default and changes nothing here.

   The visual tools use the sandbox list only to return images. Their `execute` runs in the Coworker Durable Object like every other tool; the standard tools reach Daytona only because their `execute` calls the sandbox API. The visual tools ignore the sandbox argument and reach Browser Run and R2 through closures created at render. When `defineTool` can return image content, they move to `useTool` and the virtual sandbox goes away; ask Flue upstream for it.

   **Image budget.** Flue does not yet bound image bytes: tool-result images have no size check (flue#529), and every image still visible in the conversation is loaded into memory whenever the context is rebuilt (flue#531). The preview the model sees is therefore downscaled (longest side 1568 px, JPEG, about 300 KB at most), separate from the full PNG stored for Slack. There is no count limit on previews; compaction drops old ones, and Flue's byte budget (flue#531) replaces this per-image cap when it lands. If the conversation's model does not accept images, the tool says so in its text instead of relying on pi-ai's `(see attached image)` placeholder.

3. **Templates and their libraries are application assets.** `/render/<kind>.html` pages and pinned library bundles (mermaid.js, Vega/Vega-Lite, ECharts, Excalidraw's `exportToSvg`) are served as Worker static assets. Upgrading a library is a reviewed change. Static assets allow 25 MiB per file. mermaid.js (5.2 MiB minified), ECharts (3.7 MiB) and Vega fit easily. Excalidraw's `@excalidraw/utils` production bundle is 19 MiB, and its Excalifont is 22 MiB, so it fits but each render loads about 40 MiB; Excalidraw ships after Mermaid, Vega-Lite and ECharts, with a tree-shaken bundle and a subset font.

4. **Diagram source by default, freeform HTML when layout is the point.** The model writes Mermaid, Vega-Lite, ECharts options, or Excalidraw elements, and a layout engine places them. `html` is for dashboards, report layouts, and explainer cards, where the model's CSS layout is reliable. Preference order: native Block Kit chart or table (ADR 0019), then diagram source, then freeform HTML.

5. **Rendering has no network and no model-written script.** A rendered page cannot fetch a model-chosen URL, send data out, or call the application's other routes:

   - Request interception allows only `GET` requests to the application's `/render/` path, plus `data:` and `blob:` URLs, and aborts everything else. Model-written HTML runs on the Worker's origin, so allowing the whole origin would expose routes such as `/channels/slack/interactions`.
   - Every template sends a content security policy of `default-src 'none'` with `script-src`, `style-src`, `font-src`, and `img-src` limited to `/render/` (plus inline styles and `data:` images) and `connect-src 'none'`. This also covers WebSocket and EventSource connections, which request interception does not see.
   - Owner code injects the source after the template loads, as a `page.evaluate` argument. Templates never read source from the URL, query, or hash, so the public `/render/*` pages cannot be used to run arbitrary content on the origin.
   - The `html` kind renders with JavaScript disabled: it exists for CSS layout, and charts inside a dashboard come from the chart kinds. Mermaid runs with `securityLevel: 'strict'`; ECharts options, Vega-Lite specs, and Excalidraw scenes are parsed as JSON, so they cannot carry functions.

6. **Artifacts live in R2.** PNGs are stored at `artifacts/<conversationId>/<artifactId>.png` with a 15-day lifecycle TTL. The model refers to them only by `artifactId`, and only to its own conversation's artifacts. Posting an expired artifact returns a repairable tool error telling the model to render again; images already uploaded to Slack are unaffected.

7. **Delivery through the reply tool.** `reply_in_slack_thread` gains optional `images: [{ artifactId, altText }]`. Owner code posts the message and then uploads each image to the conversation's bound `channelId` and `threadTs` with `files.getUploadURLExternal` (filename, length, `alt_txt`) and `files.completeUploadExternal` (`channel_id`, `thread_ts`). `completeUploadExternal` can be called only once per upload, so a failed completion starts a new upload rather than retrying. Limits: 5 images per reply, 10 MiB each, alt text of 1000 characters at most. The text fallback still carries the takeaway (ADR 0019). An upload error, including disabled uploads, returns to the model; the message already posted stands. Slack gains the `files:write` scope, which needs an app reinstall; `files:read` is not required. The bot must be in the channel (`not_in_channel`), and external guests cannot receive shared files from this flow (`user_is_external_guest`).

8. **Fallback.** If Browser Run fails or is over its limits, the model replies with native Block Kit or with text plus the diagram source in a code block. No sandbox renderer is kept as a second path.

9. **Read-only browsing (phase 1).** `browse_page({ url, mode })` with `mode` one of `markdown`, `snapshot`, or `screenshot`, backed by Browser Run Quick Actions on Chromium. Kitesurf is not used in v1: Cloudflare documents that its failures degrade to a blank frame or missing elements rather than an error, and does not confirm `/markdown` or `/snapshot` support, so detecting when to fall back would be a heuristic. At current volume Chromium's cost is negligible. Kitesurf can be added later as a cost optimization with a measured fallback rule. Results are marked as untrusted web content, like `web_fetch` results. A screenshot becomes an artifact that the model sees as in decision 2 and that reaches Slack only through decision 7.

10. **Interactive browsing (phase 2).** A Browser Run Chromium session held by the Coworker, with tools to open a URL, take an accessibility snapshot with element refs, click, type, scroll, screenshot, and close. The session uses a fresh profile and no credentials, is closed when the run settles or after an idle timeout, and is billed for concurrency. The model acts from text accessibility snapshots with element refs and uses screenshots, under the image budget in decision 2, for visual-only content such as canvas, charts, and layout. Logging in to sites, cookie reuse, and acting on the user's behalf on authenticated sites are out of scope until a later decision.

## Consequences

- Conversations without a repository can draw diagrams and browse, and the sandbox stays at its current size.
- The deployment gains a `browser` binding, an R2 bucket, and static assets in `wrangler.jsonc`, plus `files:write` in `slack-app-manifest.yaml`.
- Browser Run cost is near zero at current volume: renders use Browser Sessions, which bill both hours and concurrency, but each browser lives only for one render. The 10 included hours cover roughly 18,000–36,000 renders a month, and concurrency stays far below the 10 included browsers. A fix-and-rerender loop pays about a second of browser launch per retry instead of idle time. Interactive sessions (decision 10) held open for minutes use hours faster and add concurrency charges.
- The model reviews its own renders with no extra model call, at roughly 1,000–1,500 input tokens per preview. A conversation without a repository now mounts a virtual sandbox to carry the visual tools; it has no file or shell tools.
- The visual tools depend on an off-label Flue path (image content from sandbox-factory tools) until `defineTool` supports image output. A Flue upgrade that changes how sandbox tools are wrapped breaks the review loop; a test should assert that a tool-result image reaches the model request.
- Rendering depends on Browser Run availability; when it is down, replies degrade to Block Kit or text.
- Browsed pages can carry prompt injection. Phase 1 has the same exposure as `web_fetch`; phase 2 widens it, because the model can act on pages. Guards stay thin in v1 and can be added if usage shows they are needed.
- Checking a repository's own UI (a dev server on sandbox `localhost`) is not covered. It needs either Chromium in the sandbox or Browser Run against a signed Daytona preview URL, and is a separate decision.

## Resolved questions

Checked October 2026 against Flue's installed runtime, Slack's method reference, Cloudflare's Kitesurf post and Workers limits, and npm.

- **Images in tool results:** rechecked against `@flue/runtime` 2.3.0 (latest, October 12). `defineTool`/`useTool` output still becomes JSON text, and MCP tool images still become text placeholders. Sandbox-factory tools keep their image blocks, which are persisted as attachments, and pi-ai 1.1.0 sends them to image-capable models as `input_image`. No upstream issue asks for image output from `defineTool`; flue#529 and flue#531 track image byte limits. See decision 2.
- **Slack scopes:** `files.completeUploadExternal` lists only `files:write`; see decision 7.
- **Excalidraw bundle size:** fits the 25 MiB static asset limit but is heavy; see decision 3.
- **Kitesurf fallback:** no documented failure signal; Chromium only in v1, see decision 9.

## Alternatives

- **Browserless rendering in the sandbox** (D2, Graphviz, `vl-convert`, ECharts SSR, resvg, Mermaid ports): no Cloudflare dependency, but weaker Mermaid and no real Excalidraw, a larger image, and a sandbox is required.
- **Chromium in the sandbox for all rendering:** full fidelity, but disk and RAM pressure in every sandbox and no rendering in conversations without one.
- **Model writes raw SVG or HTML for every diagram:** one path, but the model places coordinates badly; layout engines do it better.
- **Hosted interactive dashboards** (R2 HTML behind signed URLs or Cloudflare Access): interactive, but needs a separate cookie-isolated domain, auth, and a strict content security policy. Deferred.
- **Hosted browser vendors** (Browserbase, Steel): add a vendor for what Browser Run already provides; worth revisiting only if stealth or captcha handling is needed.
- **Vision review through `harness.prompt`:** a `defineTool` harness tool sends the PNG with `harness.prompt(text, { images, model })` to a vision model and returns its critique as text. Uses only supported APIs, but it costs a second model call per render, and the conversation's model acts on someone else's description instead of the image.
- **Lightpanda:** light, but cannot take real screenshots.
