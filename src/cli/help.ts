export const HELP_TEXT = `ti - test intelligence (static analysis)

USAGE
  ti <command> [flags]

LIFECYCLE
  ti init                         Create ti.config.ts with detected defaults.
  ti build                        Cold-start: extract every file, derive all edges.
  ti update [<paths...>]          Differential update; skips unchanged files.
                                  No paths: re-validate every file's hash (cheap).
  ti clean [--all] [--force]      Remove .ti/ contents (--all removes .ti/ itself).
  ti migrate                      Forward-only schema upgrade.
  ti unlock [--force]             Release stale .ti/.lock.
  ti export                       Materialize JSON shards under .ti/exports/.

QUERY
  ti tests   --from-sources [<paths...>] --framework=<name>
                                  [--format=args|json|ndjson] [--min-confidence=<n>] [--strict]
  ti sources --from-tests   [<ids-or-paths...>]
                                  [--format=args|json|ndjson] [--min-confidence=<n>] [--strict]
  ti explain <id-or-path>         Evidence trail.

RESOLVE (offline LLM-resolution pass — ti never calls an LLM)
  ti resolve export -o <prefix>
                                  [--kinds=hook-fire,hook-listener] [--limit=N] [--force]
                                  Emit ready-to-send LLM prompt files
                                  <prefix>-001.md, <prefix>-002.md, ... — one per
                                  batch of --limit units (default 50). Self-contained:
                                  task, citation rule, output schema, embedded code.
  ti resolve import <resolutions.json>
                                  Import an externally-produced, citation-bearing
                                  resolutions file; verify each citation, apply,
                                  re-derive. The model step that produces the file
                                  is external — ti does not run it.
  ti resolve status               Unresolved / cached / classification report.

DEBUG / INTROSPECTION
  ti config                       Print effective merged config.
  ti build|update --timing        Append a per-phase timing breakdown.
  ti build|update --timing-top=N  Same, plus the N slowest extracted files.
  ti --help, -h
  ti --version, -V
`;
