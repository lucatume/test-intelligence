export const HELP_TEXT = `ti - test intelligence (static analysis)

USAGE
  ti <command> [flags]

SETUP
  ti init                         Create ti.config.ts with detected defaults.
  ti config                       Print effective merged config.

QUERY
  ti tests   --from-sources [<paths...>] --framework=<name>
                                  [--format=args|json] [--min-confidence=<n>] [--strict]
  ti sources --from-tests   [<ids-or-paths...>]
                                  [--format=args|json] [--min-confidence=<n>] [--strict]
  ti dependencies --from-sources [<paths...>]
                                  [--format=args|json] [--min-confidence=<n>] [--strict]

TIMING
  ti tests|sources|dependencies --timing
                                  Append a per-phase timing breakdown.
  ti tests|sources|dependencies --timing-top=N
                                  Same, plus the N slowest extracted files.

  ti --help, -h
  ti --version, -V

FRAMEWORKS
  phpunit, jest, playwright, qunit
`;
