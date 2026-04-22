# docs/ — signposts

`docs/superpowers/` is **gitignored** (user-local artifacts). It is present on this machine but not in the repo:

- `docs/superpowers/specs/2026-04-21-test-intelligence-design.md` — authoritative design spec.
- `docs/superpowers/plans/2026-04-21-ti-plan-a-foundations.md` — shipped.
- Plans B–E — pending; land here as they are written.

Claude Code does **not** auto-load spec or plan files. Read them explicitly when the task calls for it (e.g., decisions about schema, rollback, adapter protocols, CLI surface).

## Modify me when…

- A new authoritative document lives under `docs/` (including things that are tracked, not just `superpowers/`).
- The gitignore status of `docs/superpowers/` changes.

Do **not** modify me for: individual new plans or spec revisions.
