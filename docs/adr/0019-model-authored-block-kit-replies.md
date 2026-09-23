# Model-authored Block Kit replies

Status: accepted

Use Markdown for ordinary Coworker replies. When a reply benefits from a chart, table, composed layout, or a working control, let the model author native Slack Block Kit. Trusted owner code validates the payload before posting it to the Agent Conversation's bound thread. The model does not have to translate its reply into a smaller application-defined layout language.

## Context

`reply_in_slack_thread` currently accepts one `text` string and posts it as `markdown_text`. Slack supports native [`data_visualization`](https://docs.slack.dev/reference/block-kit/blocks/data-visualization-block/) blocks for line, bar, area, and pie charts, and [`data_table`](https://docs.slack.dev/reference/block-kit/blocks/data-table-block/) blocks with Slack-managed sorting and pagination. A sandbox browser and PNG upload are unnecessary for those charts. Block Kit cannot draw arbitrary architecture diagrams or capture a running UI; those needs can be decided separately.

The model may make mistakes in Slack's JSON shape, but that is a repairable tool-input error. The trust boundary is what a payload can cause Slack or this application to do. Image blocks and image elements can carry external URLs; ordinary links may also unfurl. Controls that send actions back to this app need implemented handlers. The posting tool must preserve the bound destination and reject capabilities the application has not granted.

## Decision

1. **One reply tool.** Extend `reply_in_slack_thread` with optional model-authored `blocks` while keeping a required text fallback. Without blocks, it posts the text with `markdown_text` as today. With blocks, it posts `blocks` and top-level `text`, never `markdown_text` in the same call. The fallback must convey the substantive takeaway, including a verbal summary of any chart, for notifications and screen readers. The visible blocks should carry the reply body. `useAgentFinish` continues to require this tool; the model cannot choose a channel or thread.

2. **Native Block Kit, bounded capabilities.** The model writes Slack's block and nested-object shapes directly. Owner code validates the complete payload against the supported Slack shapes and limits, including chart series, categories, labels, and values. Initially permit `markdown`, `header`, `divider`, text-only `section` and `context`, `data_visualization`, and `data_table` with only `raw_text` or `raw_number` cells. Slack-managed table sorting and pagination work without an app callback. Adding another block or nested element is a reviewed capability change, not a converter change. Reject invalid input with a field-specific error the model can repair. Do not silently clamp charts or tables, since dropped data can change the answer.

3. **URL and interaction boundary.** Reject image blocks, image elements, externally sourced media, and other URL-bearing fields that would cause Slack to fetch model-chosen content. Set `unfurl_links: false` and `unfurl_media: false` for both reply shapes; this also closes the existing automatic-unfurl path in Markdown replies. Ordinary links may remain clickable. An app-callback control is allowed only when its `action_id` maps to an implemented, signature-verified, authorized handler with defined state and retry behavior. No such handler exists today, so the initial validator rejects app-callback elements. Never post a control that cannot work.

4. **Posting behavior.** The tool uses the conversation's trusted `channelId` and `threadTs`, requires no scope beyond the existing `chat:write`, and returns Slack validation or posting errors to the model. Without `SLACK_BOT_TOKEN`, it returns the validated reply without posting, as the current tool does. The owner does not rewrite a rejected payload into a different layout.

5. **Use.** Markdown remains the default. The model chooses Block Kit when a native chart, table, composed layout, or registered control helps the reader. It should compute source data from the repo or tools before constructing a chart and include a textual takeaway. The run card remains owner-rendered and separate from the model's final reply.

## Consequences

- Native charts and structured replies need neither a browser snapshot nor file upload. This decision adds no Daytona resource profile, Slack `files:write` scope, or new image-posting tool.
- The model retains Slack's expressive layout language within a reviewed set of capabilities. Schema and limit errors are explicit rather than hidden by a custom conversion layer.
- App-callback controls can be added when a complete action route exists. This ADR does not authorize a nonfunctional button or create that route.
- Verify a Markdown reply and a chart reply through the actual Slack posting boundary. Inspect the rendered chart and its accessibility fallback in Slack; local schema tests alone do not establish acceptance.

## Alternatives

- **Unrestricted Block Kit:** rejected because it permits external media fetches and unhandled controls, while the model still cannot choose a destination.
- **Application-defined component vocabulary or chart DSL:** rejected because it duplicates Slack's format and constrains model composition without removing the need for boundary validation.
- **A separate structured-reply tool:** rejected because it duplicates thread binding and final-reply handling.
- **Sandbox HTML rendered to PNG for ordinary charts:** rejected because Slack has native data visualization blocks. Browser-based UI verification and diagrams remain separate future decisions.
