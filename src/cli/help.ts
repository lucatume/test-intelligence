export const HELP_TEXT = `ti - test intelligence (static analysis)

USAGE
  ti <command> [flags]

LIFECYCLE
  ti init                         Create ti.config.ts with detected defaults.
  ti build                        Cold-start: extract every file, derive all edges.
  ti update [<paths...>]          Differential update.
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

DEBUG / INTROSPECTION
  ti config                       Print effective merged config.
  ti --help, -h
  ti --version, -V
`;
