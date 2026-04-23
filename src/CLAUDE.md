# src/ — architectural overview

This subtree is the internal library. Assume root `CLAUDE.md` conventions (TDD, `Result<T, E>`, parse-don't-validate, no ambient time/randomness, no shell interpolation) apply here.

## Module DAG

Imports flow one way, left → right. Each layer may import only from layers to its left. Enforced by `eslint-plugin-boundaries` — the element types are declared in `eslint.config.js` under `settings.boundaries/elements` and the disallow rules under `rules.boundaries/element-types`.

```
result → parse → types → clock → paths → ids → errors → config → storage → query → emit → cli → cli.ts
                                                                                                   ↑
                                                       index.ts (public barrel, unchanged in Plan B)
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
- `config/` — see `config/CLAUDE.md`.
- `storage/` — see `storage/CLAUDE.md`.
- `cli.ts` — bin entrypoint; reads `process.argv`, `process.stdin`, `process.stdout`, `process.stderr`, calls `dispatch`, calls `process.exit(code)`. **The only file permitted to mutate `process`.**
- `cli/` — argv parser, help/version text, dispatch orchestrator, IO seam. Adds kinds only as commands land.
- `query/` — pure functions over synthesized `Shard[]` + `Index`. Confidence combination, staleness, deduplication and coarser-granularity collapse live here.
- `emit/` — pure formatters. Framework-specific `--format=args` output and shared `--format=json` output.
- `storage/schema.ts` — `SUPPORTED_SCHEMA` constants; `readSchemaVersion`, `writeSchemaVersion`, `checkSchemaRange`. The **only** module that knows the on-disk integer's encoding.

## Adding a new unit

1. Decide the layer. Every top-level file in `src/` (`result.ts`, `parse.ts`, `types.ts`, `clock.ts`, `paths.ts`, `ids.ts`, `errors.ts`) is its own boundary element, and each subdirectory (`config/`, `storage/`) is one too. A new top-level file **requires** a new `{ type, pattern }` in `settings.boundaries/elements` **and** its place in the `rules.boundaries/element-types` disallow list — declared in `eslint.config.js` before writing the code. Otherwise the new file is outside the boundary graph and silently escapes enforcement.
2. Write the failing test first at `tests/<same-path>.test.ts` (see `tests/CLAUDE.md`).
3. Implement to green; refactor.
4. If the new unit is part of the public API, export it through `index.ts` — otherwise keep it interior.
5. Verify: `npm run lint && npm run typecheck && npm test` all exit 0.

## Error-shape discipline

Interior errors are plain `TiError` variants (or lower-level shape-specific errors where no user-visible `TiError` is warranted yet — e.g., `PathParseError`, `IdParseError`, `ValidationError`). Do not leak raw `Error` / `unknown` across module boundaries; convert at the point of capture.

## Modify me when…

- A new `src/<file>.ts` is promoted to its own boundary layer (update DAG + file list).
- The public barrel `index.ts` gains or loses an export.
- An invariant emerges that spans more than one file in `src/` but is not universal enough for the root.

Do **not** modify me for: bug fixes, renaming an internal symbol, adding fields to an existing type, or anything a future agent could learn by reading the file in question.
