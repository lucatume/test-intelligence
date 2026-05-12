export type ParsedCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'init' }
  | { kind: 'config' }
  | { kind: 'not-implemented'; verb: string }
  | { kind: 'unknown-command'; input: string };

const RESERVED_VERBS = new Set([
  'build',
  'update',
  'clean',
  'migrate',
  'unlock',
  'export',
  'tests',
  'sources',
  'explain',
]);

export function parseArgv(argv: readonly string[]): ParsedCommand {
  const [first] = argv;
  if (first === undefined) return { kind: 'help' };
  if (first === '--help' || first === '-h') return { kind: 'help' };
  if (first === '--version' || first === '-V') return { kind: 'version' };
  if (first === 'init') return { kind: 'init' };
  if (first === 'config') return { kind: 'config' };
  if (RESERVED_VERBS.has(first)) return { kind: 'not-implemented', verb: first };
  return { kind: 'unknown-command', input: first };
}

// Kept for future introspection / dispatcher reuse.
export { RESERVED_VERBS };
