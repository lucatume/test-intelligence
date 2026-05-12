# src/ — architectural overview

This subtree is the internal library. Assume root `CLAUDE.md` conventions (TDD, `Result<T, E>`, parse-don't-validate, no ambient time/randomness, no shell interpolation) apply here.

## Module DAG

The architecture is a DAG of zones, not a linear chain. Each zone has an explicit positive allow-list of zones it may import from; anything not enumerated is rejected. Enforced by `eslint-plugin-boundaries` — element types declared in `eslint.config.js` under `settings.boundaries/elements` and rules under `rules.boundaries/element-types`. Authoritative definition lives in `eslint.config.js`.

Zones:

```
foundation = src/{result,parse,types,clock,paths,ids,errors}.ts
barrel     = src/index.ts
anchors    = src/anchors/**
store      = src/store/**
config     = src/config/**
facts      = src/facts/**          (Plan B; pre-registered, no files yet)
extract    = src/extract/**        (Plan B; pre-registered)
derive     = src/derive/**         (Plan D; pre-registered)
query      = src/query/**          (Plan F; pre-registered)
emit       = src/emit/**           (Plan F; pre-registered)
cli        = src/cli/**
cli-entry  = src/cli.ts
```

Allow-lists (each zone → what it may import from):

```
foundation → foundation
anchors    → anchors, foundation
store      → store, foundation
config     → config, foundation
barrel     → barrel, config, foundation
facts      → facts, anchors, foundation
extract    → extract, anchors, facts, foundation, store
derive     → derive, anchors, facts, foundation, store
query      → query, store, anchors, foundation
emit       → emit, foundation
cli        → cli, config, store, anchors, query, emit, foundation
cli-entry  → cli, cli-entry, foundation
```

Cycles are additionally forbidden by `import/no-cycle`.

## File purposes (only where knowing the purpose saves a read)

- `result.ts` — `Result<T, E>` sum type and combinators (`ok`, `err`, `map`, `mapErr`, `andThen`, `combineAll`, …). No dependencies.
- `parse.ts` — schema combinators returning `ParseResult<T> = Result<T, ValidationError[]>`. The **single boundary** between `unknown` and typed interior values. Path-qualified errors.
- `types.ts` — branded primitives (`ProjectRelativePath`, `SourcePath`, `TestFilePath`, `Confidence`, `ISODate`, …) **and** shared non-branded value types, notably `RunnerInvocation = { bin, args }` (the canonical subprocess-call shape — always spawned with `shell: false`) and `FrameworkName`. Each brand has exactly one constructor — its parser. Two-level brand scheme (`__brand` + `__kind`) is intentional; do not collapse.
- `clock.ts` — injectable `Clock` / `Random` interfaces plus `systemClock`, `systemRandom`, `fixedClock`, `seededRandom`. The **only** file permitted to touch `Date` / `Math.random` (via the whitelisted alias pattern).
- `paths.ts` — `parseProjectRelativePath` (rejects absolute paths, NUL bytes, `..` escapes, disallowed symlinks). Returns `SourcePath` / `TestFilePath` after inner branding.
- `ids.ts` — `parseTestId` turning `framework:path[::filter]` strings into `TestId`.
- `errors.ts` — `TiError` discriminated union + `exitCodeFor`. Exit codes: 0 success, 1 invocation, 2 strict-unknown. When a new failure mode appears, add a variant here — not an ad-hoc error type in the calling module.
- `index.ts` — public barrel. Exports `defineConfig` and the config type aliases (`UserConfig`, `ValidatedConfig`) and **nothing else**. Interior modules are not part of the public API.
- `anchors/` — stable file-identity primitives (path + content hash) shared by `facts`, `extract`, `derive`, `query`, and `cli`.
- `config/` — see `config/CLAUDE.md`.
- `store/` — see `store/CLAUDE.md`. On-disk SQLite store, lock protocol, schema migration.
- `cli.ts` — bin entrypoint; reads `process.argv`, `process.stdin`, `process.stdout`, `process.stderr`, calls `dispatch`, calls `process.exit(code)`. **The only file permitted to mutate `process`.** Imports only `src/cli/**` and foundations — everything else funnels through the `cli` zone.
- `cli/` — argv parser, help/version text, dispatch orchestrator, IO seam. Adds kinds only as commands land.
- `query/` — pure functions over synthesized `Shard[]` + `Index`. Confidence combination, staleness, deduplication and coarser-granularity collapse live here. (Plan F; pre-registered.)
- `emit/` — pure formatters. Framework-specific `--format=args` output and shared `--format=json` output. (Plan F; pre-registered.)
- `facts/`, `extract/`, `derive/` — Plan B/D zones, pre-registered with empty implementations so future code is constrained on arrival.

## Adding a new unit

1. Decide the zone. The seven foundation files (`result.ts`, `parse.ts`, `types.ts`, `clock.ts`, `paths.ts`, `ids.ts`, `errors.ts`) all share the `foundation` zone — any of them may import from any of the others. Each subdirectory (`anchors/`, `store/`, `config/`, `facts/`, `extract/`, `derive/`, `query/`, `emit/`, `cli/`) is its own zone, plus `cli.ts` (`cli-entry`) and `index.ts` (`barrel`). A new top-level file **requires** a new `{ type, pattern }` in `settings.boundaries/elements` **and** an entry in the `rules.boundaries/element-types` allow-list — declared in `eslint.config.js` before writing the code. Otherwise the new file is outside the boundary graph and silently escapes enforcement.
2. Write the failing test first at `tests/<same-path>.test.ts` (see `tests/CLAUDE.md`).
3. Implement to green; refactor.
4. If the new unit is part of the public API, export it through `index.ts` — otherwise keep it interior.
5. Verify: `npm run lint && npm run typecheck && npm test` all exit 0.

## Error-shape discipline

Interior errors are plain `TiError` variants (or lower-level shape-specific errors where no user-visible `TiError` is warranted yet — e.g., `PathParseError`, `IdParseError`, `ValidationError`). Do not leak raw `Error` / `unknown` across module boundaries; convert at the point of capture.

## Modify me when…

- A new zone is added or an existing zone's allow-list changes in `eslint.config.js` (update DAG + allow-lists here too).
- A pre-registered zone (`facts`, `extract`, `derive`, `query`, `emit`) gains its first real file — promote it from "pre-registered" to a real file-purpose entry.
- The public barrel `index.ts` gains or loses an export.
- An invariant emerges that spans more than one file in `src/` but is not universal enough for the root.

Do **not** modify me for: bug fixes, renaming an internal symbol, adding fields to an existing type, or anything a future agent could learn by reading the file in question.
