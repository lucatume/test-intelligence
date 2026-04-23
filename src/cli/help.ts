export const HELP_TEXT = `ti — test intelligence (v1, Plan B: query-only)

USAGE
  ti <command> [options]

QUERY COMMANDS
  ti tests   --from-sources [<paths...>] --framework=<name> [--format=args|json]
             [--min-confidence=<n>] [--strict]
      Emit runner-native args for the tests covering the given source files,
      scoped to one framework per invocation. An empty result is the safe
      fallback meaning "run everything" — not "no tests are needed". With
      --strict, an empty or partial result caused by unknown input paths
      exits 2 instead of 0.

  ti sources --from-tests [<ids-or-paths...>] [--format=args|json]
             [--min-confidence=<n>] [--strict]
      Emit source paths exercised by the given tests. Inputs may be test
      file paths, test ids (<framework>:<path>::<filter>), or a mix.

  ti explain <id-or-path>
      Print the evidence trail for a single test id or source path. View ids
      (http:/rest:/cli:) are reserved for v1.1 and exit 1 with "unknown id".

OPERATOR COMMANDS
  ti unlock [--force]
      Release a stale lock at .test-intelligence/.lock. No-op (exit 0) if no
      lock exists. If the lock records a different hostname than this host,
      --force is required to release it (defends against cross-host shared-
      filesystem false positives).

INTROSPECTION
  ti --help, -h
  ti --version, -v

INPUT CONVENTIONS
  Paths are POSIX, project-relative. Input may be positional OR newline-
  delimited on stdin when no positional args are given and stdin is not a TTY.

OUTPUT CONVENTIONS
  --format=args (default): newline-delimited, deduplicated, alphabetically
  sorted runner-native args. --format=json: documented JSON shape.
  Diagnostics go to stderr.

EXIT CODES
  exit 0    success (output may be empty — that is the safe fallback)
  exit 1    invocation error: bad flags, unreadable map, schema out of range,
            lock held, all adapters failed
  exit 2    --strict was set and input contained unknown paths or ids

See docs/superpowers/specs/2026-04-21-test-intelligence-design.md for the
full design spec.
`;
