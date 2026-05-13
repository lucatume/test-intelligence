export type ParsedCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'init' }
  | { kind: 'config' }
  | { kind: 'build'; verbosity: 'quiet' | 'normal' | 'verbose' }
  | { kind: 'update'; paths: readonly string[]; verbosity: 'quiet' | 'normal' | 'verbose' }
  | { kind: 'not-implemented'; verb: string }
  | { kind: 'unknown-command'; input: string };

const RESERVED_VERBS = new Set([
  'clean',
  'migrate',
  'unlock',
  'export',
  'tests',
  'sources',
  'explain',
]);

export function parseArgv(argv: readonly string[]): ParsedCommand {
  const [first, ...rest] = argv;
  if (first === undefined) return { kind: 'help' };
  if (first === '--help' || first === '-h') return { kind: 'help' };
  if (first === '--version' || first === '-V') return { kind: 'version' };
  if (first === 'init') return { kind: 'init' };
  if (first === 'config') return { kind: 'config' };
  if (first === 'build') return { kind: 'build', verbosity: pickVerbosity(rest) };
  if (first === 'update') {
    return {
      kind: 'update',
      paths: rest.filter((a) => !a.startsWith('-')),
      verbosity: pickVerbosity(rest),
    };
  }
  if (RESERVED_VERBS.has(first)) return { kind: 'not-implemented', verb: first };
  return { kind: 'unknown-command', input: first };
}

function pickVerbosity(args: readonly string[]): 'quiet' | 'normal' | 'verbose' {
  if (args.includes('--quiet') || args.includes('-q')) return 'quiet';
  if (args.includes('--verbose') || args.includes('-v')) return 'verbose';
  return 'normal';
}

export { RESERVED_VERBS };
