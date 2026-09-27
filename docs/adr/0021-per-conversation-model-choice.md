# Per-conversation Model Choice

Status: accepted. Supersedes ADR 0020 decision 6.

The person who starts a Coworker thread may choose the model and thinking level for that conversation from a small deployment allowlist, with inline `model:` and `think:` arguments in the first mention.

## Context

ADR 0020 made the Model Route a deployment-level fallback: the ChatGPT subscription when the Codex Credential is usable, otherwise OpenCode Go, with no per-user selection. Both providers offer several models with different cost, speed, and quality, and the right one depends on the task. Invokers need a way to pick without knowing full model ids.

Slack gives apps no composer autocomplete for message text, and a Block Kit picker needs a signature-verified interaction handler (ADR 0019). Flue records `initialData` exactly once, when the dispatch creates the instance.

## Decision

1. **Syntax.** `model:<name>` and `think:low|medium|high` anywhere in an `app_mention`, outside code spans, code blocks, and quotes. Key and value are joined with no space. Conflicting duplicates are refused. Matched arguments are removed before the text reaches the model. Only the mention that creates the conversation is parsed; replies and later mentions are plain text.
2. **Allowlist.** Aliases live in `modelAliases` in `src/config.ts` (`sol`, `luna`, `deepseek`, `kimi`, `glm`). A test keeps every alias in pi's bundled catalog.
3. **Matching.** Case-insensitive: exact alias, exact model id, unique prefix, then Damerau-Levenshtein distance (the `damerau-levenshtein` package) within one edit for names up to four letters and two beyond, accepted only when exactly one alias is that close. Corrections show on the run card. `mid` is a thinking shorthand.
4. **Latched per conversation.** The resolved choice is written to `initialData.modelChoice` with only what the user gave. Later mentions cannot change it, so they are not parsed and cannot be refused for it.
5. **Availability.** A ChatGPT model at thread start while ChatGPT is not usable is refused in the thread, so a user never silently gets a different provider. Mid-thread, a submission falls back to the default route, and the run card says so. The same fallback applies when the provider catalog no longer has a recorded model.
6. **Default.** No `model:` keeps ADR 0020's route; no `think:` means `medium`.
7. **Discoverability.** Invalid arguments get an in-thread help reply listing the aliases; a Slack `http_timeout` retry does not post it again. `/aiyappa models` lists aliases and their availability, gated like `status`. Cards on default-model threads hint at `model:` for new threads.

## Consequences

- Invokers can spend on stronger models. The per-conversation budget still bounds each thread.
- Removing an alias from a deploy does not break existing threads: their recorded model id still runs while pi ships it, and falls back to the default route once it does not.
- A bare `model:x` in prose now draws a help reply instead of running. Code and quotes are exempt.

## Alternatives

- **Leading-only arguments:** fewer false matches, but users had to remember where to put them.
- **Block Kit picker before the run, or a run-card dropdown:** discoverable, but needs an interaction handler and adds a click to every thread. Can be added later over the same alias table.
- **Modal from a slash command:** moves thread creation out of mentions.
