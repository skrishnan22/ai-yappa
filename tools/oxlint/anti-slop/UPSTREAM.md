# Vendored anti-slop plugin

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (2026-09-10).

Copied via the local `install-anti-slop` skill (`~/.agents/skills/install-anti-slop/assets/anti-slop`). That skill bundle is byte-identical to `src/` in the commit above, excluding upstream `*.test.ts` files which the installer does not copy. Nested `vendor/eslint-stylistic/` provenance is recorded in that directory's `UPSTREAM.md`.

Installed plugin paths:

- Generic entry: `tools/oxlint/anti-slop/index.ts` (registered as `anti-slop`)
- Effect entry: `tools/oxlint/anti-slop/effect/index.ts` (copied, not registered)

## Intentional deviations

- No edits to the copied plugin source.
- Effect rules are not enabled: this repository has no direct `effect` dependency.
- Oxlint ignores keep existing `**/node_modules` and `**/dist`, plus agent-tooling directories from the install skill, plus project-local `.pr-lens/**` and `.superpowers/**`.
- Existing `eslint-js` plugin, categories, and rule overrides in `.oxlintrc.json` are unchanged.

## Dependencies

- `oxlint` remains `^1.82.0` (lockfile 1.82.0)
- `@oxlint/plugins` added as an exact `1.82.0` development dependency
