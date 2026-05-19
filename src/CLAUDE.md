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
facts      = src/facts/**
extract    = src/extract/**
derive     = src/derive/**
resolve    = src/resolve/**
jsresolve  = src/jsresolve/**
query      = src/query/**          (Plan F; pre-registered)
emit       = src/emit/**           (Plan F; pre-registered)
discover   = src/discover/**
build      = src/build/**
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
resolve    → resolve, store, anchors, facts, foundation, derive
jsresolve  → jsresolve, store, facts, anchors, foundation, extract, derive
query      → query, store, anchors, foundation
emit       → emit, foundation
discover   → discover, config, foundation
build      → build, discover, extract, derive, store, config, foundation, facts, anchors, jsresolve
cli        → cli, config, store, anchors, query, emit, foundation, build, discover, resolve
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
- `query/` — pure functions over the SQLite store. `testsFromSources(db, args)` returns `QueryResult { rows, unknownPaths, unknownTestIds }`; `sourcesFromTests(db, args)` mirrors it for `--from-tests`. Direct SQL (no ORM). Reads `edge` JOIN `test`, gated by `confidence >= minConfidence`. Reports unknown inputs separately so `--strict` can exit 2.
- `emit/` — pure formatters. `emitArgs(result, { mode })` produces sorted, deduped newline-delimited output (sources or test ids); `emitJson(result)` produces a single-document JSON string with edges + unknown lists.
- `discover/` — async filesystem walk with `ignore`/`vendor` globs; classifies files by `language` and `framework`. Pure: returns `AsyncIterable<DiscoveredFile>`, does not parse source. Glob matching is in-house (`discover/glob.ts`), no new deps.
- `facts/` — `Fact` discriminated union (sealed by `FactKind`) and `parseFact(raw)` — the single boundary between extractor output and the typed interior. Each fact carries `kind`, `resolved`, `location`, an array of `FactAnchorRef`, and a kind-discriminated payload.
- `extract/` — orchestration plus per-language extractors. `extract/ts/` uses the TS Compiler API in-process with synthesized `CompilerOptions` (merging `paths`/`baseUrl` from `tsconfig.json` / `jsconfig.json`). `extract/php/` runs a long-lived `php` subprocess against `vendor-php/bin/ti-php-extract.php` (nikic/php-parser) using a JSON-line protocol. `extract/declarative/` matches user-supplied + built-in (WP) call patterns against ASTs; patterns may declare an `anchor: { template, role }` to synthesize anchor keys. Built-ins: `WP_PHP_PATTERNS` (sent to the worker on startup) and `WP_JS_PATTERNS` (run through the in-process TS engine). `extract/declarative/derive-ajax-listener.ts` is a post-pass that promotes `wp_ajax_*` hook listeners to `ajax-listener` facts. `extractFile(input)` dispatches by language and returns `Result<Fact[], ExtractError>`; pass a `phpWorker` to enable PHP extraction.
- `derive/` — pure reachability engine. `loadGraph(db)` snapshots files/facts/anchors into memory; `buildAnchorIndex(graph)` precomputes `anchor → facts` by role + `factId → links`. `traverseTest(graph, index, testFactId, ...)` performs the BFS for one test producing `Edge[]` with framework-class gating, hook stop-list, depth + time bounding, confidence combination per spec §Confidence. `derive(db, params, clock)` is the top-level orchestrator: snapshot → per-test traverse → write edges via the store helpers inside a single transaction. The caller (`build/`) passes in the resolved `params` (max depth, max millis, threshold, hook stop-list) — `derive/` cannot import from `config/`.
- `build/` — orchestration glue. `runBuild(opts)` opens the store, acquires the lock, optionally spawns the PHP worker, iterates discovered (or user-listed) files through `extractFile`, writes facts/anchors/tests, then calls `derive`. Returns a `BuildSummary` (files/facts/tests/edges + elapsed millis). The only zone that imports `discover` + `extract` + `derive` together. CLI verbs `ti build` and `ti update` are thin wrappers around `runBuild`; `update` differs only by `onlyPaths`.
- `jsresolve/` — post-extraction interprocedural JS caller resolution: builds a whole-program ts.Program and resolves ajax-call-js / rest-call-js arguments the per-file extractor left as {*}. See docs/superpowers/specs/2026-05-19-js-caller-resolution-design.md.
- `resolve/` — the offline LLM-resolution pass (`ti resolve export|import|status`). `buildBundle(db, params)` exports `resolved = 0` `hook-fire` / `hook-listener` facts (keyed by the Phase-0 `payload.unresolved.exprHash`) as a `ResolveBundle`. `importResolutions(db, file, ctx)` parses an externally-produced `ResolutionsFile`, re-reads every citation to verify the claimed hook token, applies verified resolutions to the fact (`updateFactResolvedPayload` + `repointFactAnchor`, stamped `meta.resolvedBy = 'llm-pass'`), caches them in the `resolution` table, then re-runs `derive`. `resolveStatus(db)` reports unresolved/cached/stale counts. `parse.ts` is the single `unknown` boundary for both JSON contracts. `ti` never calls an LLM.

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
