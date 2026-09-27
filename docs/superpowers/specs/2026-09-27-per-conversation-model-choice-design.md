# Per-conversation Model Choice

Status: design approved in chat, pending spec review
Date: 2026-09-27

## Goal

The person who starts a Coworker thread can choose the model and thinking level for that conversation from a small deployment allowlist. The choice is made in the first mention and holds for the whole thread. Omitting it keeps today's behavior.

This reverses ADR 0020 decision 6 ("not per-user model selection") and the `CONTEXT.md` Model Route entry ("no per-user model selection"; _Avoid_: model picker). Both are updated as part of this work (see Docs).

## User-facing behavior

### Syntax

Inline arguments anywhere in the mention text:

```
@aiyappa model:luna think:high fix the flaky test
@aiyappa why is CI red on main? think:low
```

- `model:<value>` and `think:<value>`, key and value joined by `:` with no space. `model: foo` does not match.
- Arguments inside inline code, code blocks, and `>` quotes are ignored.
- Only the mention's own text is parsed. Thread Context loaded at dispatch is never parsed.
- The same key twice with different values is an error. Repeating the same value is allowed.
- Matched arguments are removed from the text before it reaches the model; whitespace is collapsed.
- Either argument may appear without the other. A missing model uses the default model; a missing `think:` uses `medium`.
- Arguments are parsed only on the `app_mention` that creates the conversation. Replies and later mentions are plain text.

### Alias table

Deployment config in `src/config.ts`:

| alias | provider | model id |
|---|---|---|
| `sol` | ChatGPT (`openai-codex`) | `gpt-5.6-sol` |
| `luna` | ChatGPT (`openai-codex`) | `gpt-5.6-luna` |
| `deepseek` | OpenCode Go | `deepseek-v4.1-flash` (keeps the existing fallback to `deepseek-v4-flash`) |
| `kimi` | OpenCode Go | `kimi-k3` |
| `glm` | OpenCode Go | `glm-5.3` |

Thinking levels: `low`, `medium`, `high`.

### Matching (typo tolerance)

Case-insensitive. For `model:` the resolver tries, in order, and stops at the first rule that yields exactly one alias:

1. exact alias
2. exact model id (e.g. `gpt-5.6-luna`, `kimi-k3`)
3. unique alias prefix (`ki` → `kimi`)
4. closest alias by Damerau-Levenshtein distance (adjacent transposition = 1 edit), accepted only if exactly one alias is within the limit: **≤ 1** edit for aliases of 4 letters or fewer, **≤ 2** for longer aliases. `lnua` → `luna`; `gpt` → `glm` is 2 edits from a 3-letter alias and is rejected.

A rule that matches more than one alias is `ambiguous` and stops resolution. Nothing matched is `unknown`.

For `think:` the same order applies over `low | medium | high`, with shorthands checked before the distance step: `lo` → `low`; `med`, `mid` → `medium`; `hi` → `high`.

Distance comes from the `damerau-levenshtein` npm package (zero dependencies, BSD-2-Clause, types from `@types/damerau-levenshtein`). Application code owns only the limits and the "exactly one within the limit" rule.

When a value was corrected by rule 4, the run card shows the correction (shorthands and prefixes are not corrections): `luna (from "lnua") · thinking high`.

### First mention (thread start)

1. Parse and resolve arguments. On a parse error, `unknown`, or `ambiguous`, reply in the thread with the help text and do not dispatch.
2. If a ChatGPT alias was chosen and `CodexAuth` is not connected at this moment, reply in the thread with a refusal and do not dispatch:
   > ChatGPT isn't connected, so `luna` isn't available. Pick one of `deepseek` · `kimi` · `glm`, or ask an admin to run `/aiyappa openai connect`.
3. Otherwise dispatch with `initialData.modelChoice = { model?: { provider, modelId }, thinkingLevel?, correctedFrom? }`, carrying only what the user gave. No `model:` and no `think:` means `initialData.modelChoice` is absent.

Flue records `initialData` once, at instance creation. A `model:` in a later mention in an existing thread therefore does not change the conversation's model. The run card always shows the model actually in use. Only the mention that creates the conversation is parsed; later mentions are plain text, so a disconnected ChatGPT cannot refuse them and they fall back as below.

### Every event

Unchanged: Slack ingress attaches `modelRoute` to each signal. It now means "ChatGPT is usable right now" (`chatgpt`) or not (`opencode-go`).

### Render

`Coworker` combines `initialData.modelChoice` with the delivered `modelRoute`. A missing thinking level is `medium`.

| choice | ChatGPT usable | result |
|---|---|---|
| ChatGPT model | yes | the choice |
| ChatGPT model | no | OpenCode Go default (`deepseek`) at the thread's thinking level; run card shows `luna unavailable → deepseek-v4.1-flash` |
| OpenCode Go model | either | the choice |
| none | yes | `sol` |
| none | no | `deepseek` |

Renders with no route (appended reminders, `flue run`) keep the current behavior: the model latched for the submission is not re-stamped on the card.

### Discoverability

- **Help text** (shared by every error reply and `/aiyappa models`):
  > Pick a model with `model:<name>` and effort with `think:low|medium|high`.
  > ChatGPT: `sol` · `luna` — OpenCode Go: `deepseek` · `kimi` · `glm`
- **`/aiyappa models`**: ephemeral list of aliases and model ids, marking ChatGPT aliases available or unavailable from `CodexAuth` status (an unreachable `CodexAuth` counts as disconnected). Allowed for invokers and Codex admins (same gate as `status`).
- **Run card**: shows `model · thinking <level>` (already rendered today), plus the correction or fallback note above. Threads that used the default model get a hint `model:<name> think:<level>` in the context line.

## Components

### New: `src/channels/invocation-args.ts`

Pure. `parseInvocationArgs(text): { ok: true; model?: string; think?: string; body: string } | { ok: false; error }`.

- Masks inline code, code blocks, and `>` quote lines before scanning.
- Matches `(?<![\w:/])(model|think):([^\s`*_~]+)` outside masked regions.
- Returns raw values; resolution happens elsewhere. Written so a future `repo:` argument (spec §3) reuses it.

### New: `src/agents/model-choice.ts`

- `modelChoiceSchema` (valibot): `{ model?: { provider: 'chatgpt' | 'opencode-go'; modelId: string }; thinkingLevel?: 'low' | 'medium' | 'high'; correctedFrom?: { model?: string; think?: string } }`.
- `resolveModelAlias(input)` and `resolveThinkingLevel(input)` return a resolved value, `{ corrected: true, from }` when rules 4/shorthand applied, or `unknown` / `ambiguous`.
- `coworkerModel(choice | undefined, route | undefined): { specifier; thinkingLevel; fallbackFrom?: string; correctedFrom? }` implements the render table.
- `modelHelpText(codexConnected?)` builds the help text.

### Changed

- `src/config.ts`: `modelAliases` table.
- `src/agents/model-route.ts`: `coworkerModelSpecifier` and the fixed `coworkerThinkingLevel` are replaced by `coworkerModel`. `modelRouteFor` and `deliveredModelRoute` stay.
- `src/channels/admit.ts`: a second pure step, `decideInvocation`, runs after `decideAdmit` returns `dispatch` (so dropped replies never ask `CodexAuth`). It returns `bad-args` (parse/resolve failure), `model-unavailable` (ChatGPT alias while disconnected), or `proceed`. Both refusals reply in the thread and emit `slack_admission` with the decision kind, like `no-repo`.
- `src/channels/slack.ts`: `app_mention` parses arguments, resolves them, passes the result to `decideAdmit`, and dispatches the stripped body with `initialData.modelChoice`. `CodexAuth` status is fetched once per event and used for both the admit decision and the `modelRoute` attribute.
- `src/agents/coworker.ts`: `initialData` schema gains optional `modelChoice`; render calls `coworkerModel` and passes specifier, thinking level, and notes to `useModel` and `bindRunCard`.
- `src/channels/run-card.ts`: optional `fallbackFrom` / `correctedFrom` rendering and the default-model hint.
- `src/channels/slash-command.ts`: `models` subcommand; `USAGE` updated.
- `slack-app-manifest.yaml`: `/aiyappa` description and `usage_hint` mention `models`.
- `package.json`: add `damerau-levenshtein` and `@types/damerau-levenshtein`.

## Error handling

- `CodexAuth` status failure at dispatch: `modelRouteForDispatch` already treats it as disconnected. A ChatGPT choice gets `model-unavailable`; an OpenCode Go choice dispatches normally.
- `initialData.modelChoice` failing validation at render (e.g. schema drift across deploys): ignore it and use the "none" row of the render table.
- An alias whose model id disappears from pi's catalog is caught in CI by the alias-table test. A thread that recorded such a model falls back to the default route at render, with `<id> unavailable → <default>` on the run card.
- Slack `http_timeout` retries skip posting refusals (the first delivery posts them); dispatch already dedupes on event id.

## Testing

Vitest, colocated:

- `invocation-args.test.ts`: arguments at start, middle, end; ignored inside inline code, code blocks, and quotes; `model: foo` does not match; `url:model:x`-style and path-embedded text does not match; conflicting duplicates error; identical duplicates allowed; stripped body.
- `model-choice.test.ts`: each resolution rule for model and thinking (exact, id, prefix, distance, shorthand); `gpt` rejected; ambiguous prefix; unknown; `coworkerModel` for every render-table row; alias-table invariants: every alias's model id exists in pi's `openai-codex` or `opencode-go` catalog, and no two aliases are within the distance limit of each other.
- `admit.test.ts`: `bad-args` and `model-unavailable`.
- `slash-command.test.ts`: `models` for connected and disconnected `CodexAuth`, and the permission gate.
- `run-card.test.ts`: fallback note, correction note, default-model hint.

## Docs

- `docs/adr/0021-per-conversation-model-choice.md`: records this decision and supersedes ADR 0020 decision 6.
- `docs/adr/README.md`: 0020 becomes "Holds, except decision 6 (superseded by 0021)"; add a 0021 row.
- `CONTEXT.md`: Model Route allows a per-conversation choice from allowlisted aliases at thread start; remove "Model picker" from _Avoid_ (keep "automatic model routing").
- `AGENTS.md`: slash-command line mentions `models`.

## Out of scope

- Block Kit pickers or `external_select` typeahead (would need a signature-verified interaction handler per ADR 0019).
- Changing the model mid-thread.
- Per-channel or per-user default models.
- The `repo:` argument (the parser is shaped to accept it later).
- Thinking levels beyond `low | medium | high`.
