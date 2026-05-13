export type ParsedCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'init' }
  | { kind: 'config' }
  | { kind: 'build'; verbosity: 'quiet' | 'normal' | 'verbose' }
  | { kind: 'update'; paths: readonly string[]; verbosity: 'quiet' | 'normal' | 'verbose' }
  | {
      kind: 'tests';
      sources: readonly string[];
      framework: string | null;
      format: 'args' | 'json';
      minConfidence: number;
      strict: boolean;
    }
  | {
      kind: 'sources';
      testIds: readonly string[];
      format: 'args' | 'json';
      minConfidence: number;
      strict: boolean;
    }
  | { kind: 'not-implemented'; verb: string }
  | { kind: 'unknown-command'; input: string };

const RESERVED_VERBS = new Set([
  'clean',
  'migrate',
  'unlock',
  'export',
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
  if (first === 'tests') return parseTestsCmd(rest);
  if (first === 'sources') return parseSourcesCmd(rest);
  if (RESERVED_VERBS.has(first)) return { kind: 'not-implemented', verb: first };
  return { kind: 'unknown-command', input: first };
}

function parseTestsCmd(rest: readonly string[]): ParsedCommand {
  const fromSourcesIdx = rest.indexOf('--from-sources');
  let sources: string[] = [];
  if (fromSourcesIdx !== -1) {
    for (let i = fromSourcesIdx + 1; i < rest.length; i++) {
      const v = rest[i];
      if (v === undefined || v.startsWith('-')) break;
      sources.push(v);
    }
  } else {
    sources = rest.filter((a) => !a.startsWith('-'));
  }
  return {
    kind: 'tests',
    sources,
    framework: getFlag(rest, '--framework'),
    format: pickFormat(rest),
    minConfidence: pickMinConfidence(rest),
    strict: rest.includes('--strict'),
  };
}

function parseSourcesCmd(rest: readonly string[]): ParsedCommand {
  const fromTestsIdx = rest.indexOf('--from-tests');
  let ids: string[] = [];
  if (fromTestsIdx !== -1) {
    for (let i = fromTestsIdx + 1; i < rest.length; i++) {
      const v = rest[i];
      if (v === undefined || v.startsWith('-')) break;
      ids.push(v);
    }
  } else {
    ids = rest.filter((a) => !a.startsWith('-'));
  }
  return {
    kind: 'sources',
    testIds: ids,
    format: pickFormat(rest),
    minConfidence: pickMinConfidence(rest),
    strict: rest.includes('--strict'),
  };
}

function pickVerbosity(args: readonly string[]): 'quiet' | 'normal' | 'verbose' {
  if (args.includes('--quiet') || args.includes('-q')) return 'quiet';
  if (args.includes('--verbose') || args.includes('-v')) return 'verbose';
  return 'normal';
}

function pickFormat(args: readonly string[]): 'args' | 'json' {
  for (const a of args) {
    if (a.startsWith('--format=')) {
      const v = a.slice('--format='.length);
      if (v === 'args' || v === 'json') return v;
    }
  }
  return 'args';
}

function pickMinConfidence(args: readonly string[]): number {
  for (const a of args) {
    if (a.startsWith('--min-confidence=')) {
      const v = Number(a.slice('--min-confidence='.length));
      if (Number.isFinite(v)) return Math.max(0, Math.min(1, v));
    }
  }
  return 0;
}

function getFlag(args: readonly string[], key: string): string | null {
  for (const a of args) {
    if (a.startsWith(`${key}=`)) return a.slice(key.length + 1);
  }
  return null;
}

export { RESERVED_VERBS };
