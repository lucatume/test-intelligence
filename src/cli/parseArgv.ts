export interface TimingFlags {
  readonly emit: boolean;
  readonly topN: number;
}

export type ParsedCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'init' }
  | { kind: 'config' }
  | {
      kind: 'tests';
      sources: readonly string[];
      framework: string | null;
      format: 'args' | 'json';
      minConfidence: number;
      strict: boolean;
      timing: TimingFlags;
    }
  | {
      kind: 'sources';
      testIds: readonly string[];
      format: 'args' | 'json';
      minConfidence: number;
      strict: boolean;
      timing: TimingFlags;
    }
  | {
      kind: 'dependencies';
      sources: readonly string[];
      format: 'args' | 'json';
      minConfidence: number;
      strict: boolean;
      timing: TimingFlags;
    }
  | { kind: 'unknown-command'; input: string };

export function parseArgv(argv: readonly string[]): ParsedCommand {
  const [first, ...rest] = argv;
  if (first === undefined || first === '--help' || first === '-h') return { kind: 'help' };
  if (first === '--version' || first === '-V') return { kind: 'version' };
  if (first === 'init') return { kind: 'init' };
  if (first === 'config') return { kind: 'config' };
  if (first === 'tests') return parseTestsCmd(rest);
  if (first === 'sources') return parseSourcesCmd(rest);
  if (first === 'dependencies') return parseDependenciesCmd(rest);
  return { kind: 'unknown-command', input: first };
}

function parseDependenciesCmd(rest: readonly string[]): ParsedCommand {
  const fromSourcesIdx = rest.indexOf('--from-sources');
  const sources = fromSourcesIdx === -1 ? rest.filter((arg) => !arg.startsWith('-')) : [];
  if (fromSourcesIdx !== -1) {
    for (let i = fromSourcesIdx + 1; i < rest.length; i++) {
      const value = rest[i];
      if (value === undefined || value.startsWith('-')) break;
      sources.push(value);
    }
  }
  return {
    kind: 'dependencies',
    sources,
    format: pickFormat(rest),
    minConfidence: pickMinConfidence(rest),
    strict: rest.includes('--strict'),
    timing: pickTiming(rest),
  };
}

function parseTestsCmd(rest: readonly string[]): ParsedCommand {
  const fromSourcesIdx = rest.indexOf('--from-sources');
  let sources: string[] = [];
  if (fromSourcesIdx !== -1) {
    for (let i = fromSourcesIdx + 1; i < rest.length; i++) {
      const value = rest[i];
      if (value === undefined || value.startsWith('-')) break;
      sources.push(value);
    }
  } else {
    sources = rest.filter((arg) => !arg.startsWith('-'));
  }
  return {
    kind: 'tests',
    sources,
    framework: getFlag(rest, '--framework'),
    format: pickFormat(rest),
    minConfidence: pickMinConfidence(rest),
    strict: rest.includes('--strict'),
    timing: pickTiming(rest),
  };
}

function parseSourcesCmd(rest: readonly string[]): ParsedCommand {
  const fromTestsIdx = rest.indexOf('--from-tests');
  let testIds: string[] = [];
  if (fromTestsIdx !== -1) {
    for (let i = fromTestsIdx + 1; i < rest.length; i++) {
      const value = rest[i];
      if (value === undefined || value.startsWith('-')) break;
      testIds.push(value);
    }
  } else {
    testIds = rest.filter((arg) => !arg.startsWith('-'));
  }
  return {
    kind: 'sources',
    testIds,
    format: pickFormat(rest),
    minConfidence: pickMinConfidence(rest),
    strict: rest.includes('--strict'),
    timing: pickTiming(rest),
  };
}

function pickTiming(args: readonly string[]): TimingFlags {
  let emit = false;
  let topN = 0;
  for (const arg of args) {
    if (arg === '--timing') emit = true;
    else if (arg.startsWith('--timing-top=')) {
      const value = Number(arg.slice('--timing-top='.length));
      if (Number.isFinite(value) && value > 0) {
        emit = true;
        topN = Math.floor(value);
      }
    }
  }
  return { emit, topN };
}

function pickFormat(args: readonly string[]): 'args' | 'json' {
  for (const arg of args) {
    if (arg.startsWith('--format=')) {
      const value = arg.slice('--format='.length);
      if (value === 'args' || value === 'json') return value;
    }
  }
  return 'args';
}

function pickMinConfidence(args: readonly string[]): number {
  for (const arg of args) {
    if (arg.startsWith('--min-confidence=')) {
      const value = Number(arg.slice('--min-confidence='.length));
      if (Number.isFinite(value)) return Math.max(0, Math.min(1, value));
    }
  }
  return 0;
}

function getFlag(args: readonly string[], key: string): string | null {
  for (const arg of args) {
    if (arg.startsWith(`${key}=`)) return arg.slice(key.length + 1);
  }
  return null;
}
