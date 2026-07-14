# tests/ — testing discipline

Root `CLAUDE.md` conventions apply here too — in particular, **no ambient `Date` / `Math.random`** is enforced by ESLint in `tests/` as well as `src/`.

## TDD workflow

Red → green → refactor. Write the test, run it, **watch it fail for the expected reason**, then implement. A test that has never been red is not load-bearing. Keep the red window short — one behaviour at a time.

## Test pyramid

- **Unit** (majority) — pure, fast, table-driven. Live beside the module under test at `tests/<same-path>.test.ts`.
- **Integration** — hit the real filesystem inside a temp directory (see below). CLI query tests must also assert that no `.ti/` state is created.
- **e2e** — currently thin. Expands in Plans D–E when the CLI ships.

## Isolation

- Use `tests/helpers/tmpDir.ts` (`useTmpDir`) for anything that touches disk. It creates, `cd`-scopes, and deletes a unique temp dir per test.
- **Never touch the real `.test-intelligence/` anywhere on the host.** Always write under the tmp dir.
- Do not mutate `process.cwd()` or `process.env` without restoring in the same test's teardown. Prefer helpers that accept an explicit `projectRoot` argument.

## Time and randomness

- Use `fixedClock(iso)` from `src/clock.ts` for deterministic timestamps.
- Use `seededRandom(seed)` from `src/clock.ts` for deterministic randomness.
- The ambient-globals ban applies in fixtures too — use these helpers there as well, not raw values.

## Branded types in tests

Fabricating branded values (e.g., a `SourcePath` for a fixture) goes through `tests/helpers/unsafeCoerce.ts`. This helper is a test-only escape hatch and **must not be imported from `src/`** — the boundary rule would not catch that because tests themselves disable `boundaries/element-types`, so discipline is on you.

## Fixture naming

- **Synthetic** fixtures (names created ad-hoc for a test) use the sentinel prefix `ti_deletemeelephant_` on IDs/paths/names. This makes stray fixtures grep-able and makes cleanup bugs loud.
- **Real-project** fixtures under `tests/fixtures/<framework>-project/` use natural names — they mimic real user projects and the prefix would corrupt the mimicry.

## Poison-pill smoke test

`tests/bootstrap/poison-pill.test.ts` is a permanent canary against silent vitest module-load failures (config problems that make the suite appear to pass because nothing loaded). **Do not delete it.** If it fails, fix the bootstrap — don't skip the test.

## Modify me when…

- A new cross-cutting test helper is added (or an existing one is deprecated).
- The fixture-naming convention changes.
- The isolation story changes (e.g., moving from tmp dirs to an in-memory fs).

Do **not** modify me for: new individual tests, new fixtures that follow existing conventions, or renames within a helper.
