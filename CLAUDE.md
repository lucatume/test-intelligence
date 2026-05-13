# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`ti` (test-intelligence) is a TypeScript CLI that maintains a durable, queryable map between source files, tests, and (later) runtime views. Authoritative design lives in `docs/superpowers/specs/2026-05-11-static-analysis-test-intelligence-design.md`.

## Status

All planned scope (Plans A–G) is shipped. The CLI is feature-complete for v1: `ti init` → `ti build` → `ti tests --from-sources <paths> --framework=<name>`, plus `ti sources --from-tests`, `ti update`, `ti unlock`, `ti clean`, `ti migrate`, `ti explain`, `ti config`. Deferred to a 1.x cycle: ndjson streaming output, `ti export` JSON shards, `.ti/last-run.log`, two-hop `script-handle` bridge resolution, concurrent worker pools.

## How to run

- `npm test` — vitest run
- `npm run lint` — ESLint (`src` + `tests`)
- `npm run typecheck` — `tsc --noEmit`
- `npm run build` — `tsc -p tsconfig.build.json`
- Single test: `npx vitest run path/to/foo.test.ts` (or `-t "<name pattern>"`)

Requires Node ≥ 20.

## Universal conventions (load-bearing — every subtree assumes these)

- **Strict TDD.** No implementation file is created without a failing test for its first behaviour. Red → green → refactor.
- **Parse, don't validate.** `unknown` becomes a typed value at exactly one boundary via a parser in `src/parse.ts`. Interior code handles only the parsed, branded types from `src/types.ts`; it never re-checks shape.
- **`Result<T, E>` for every fallible operation** (from `src/result.ts`). `throw` is reserved for programmer errors (invariant violations). Do not throw for expected failure modes (I/O, user input, lock contention, corruption).
- **No ambient time or randomness.** `new Date()`, `Date.now()`, and `Math.random()` are forbidden outside `src/clock.ts` — the `no-restricted-globals` / `no-restricted-syntax` ESLint rules enforce this in both `src/` and `tests/`. Inject `Clock` / `Random` from `src/clock.ts`.
- **No shell interpolation.** Subprocess invocation uses `{ bin, args }` arrays with `shell: false`. Never string-concatenate a command.

## Dependency policy

Runtime dependencies: `jiti` (config loading), `better-sqlite3` (SQLite working store). `typescript` is runtime-relevant in Plans B+ when the TS Compiler API is used in-process for JS/TS extraction. Dev deps: TypeScript, vitest, ESLint + `eslint-plugin-boundaries` + `eslint-plugin-import`.

Do **not** add Zod, neverthrow, fast-check, Stryker, dependency-cruiser, a logger, or a CLI-framework library without spec-level discussion first. In-repo replacements already exist:

- Schema/validation → `src/parse.ts`
- Result type → `src/result.ts`

Treat new runtime dependencies as spec changes.

## Where to go next

- `src/CLAUDE.md` — module DAG, file-by-file purposes, how to add a new unit.
- `src/config/CLAUDE.md` — config resolution, loading, and parsing.
- `src/store/CLAUDE.md` — on-disk layout, durable writes, lock protocol, gitignore.
- `tests/CLAUDE.md` — TDD workflow, isolation helpers, fixture conventions.
- `docs/CLAUDE.md` — signpost to the spec and plans.

## Tree-evolution rules (this root is the source of truth for how this tree grows)

- Add a new `CLAUDE.md` to a directory only once that directory develops invariants that span more than one file in it.
- Hoist a rule up to the root only when it genuinely applies to every subtree.
- When a rule turns out to be scoped to one subtree, push it down — and delete it from the higher file.
- Delete any sentence a future agent wouldn't miss. Duplication is the worst failure mode; under-specificity is recoverable.
