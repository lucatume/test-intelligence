export interface TimingFlags {
  readonly emit: boolean;
  readonly topN: number;
}

export type ParsedCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'init' }
  | { kind: 'config' }
  | { kind: 'build'; verbosity: 'quiet' | 'normal' | 'verbose'; timing: TimingFlags }
  | {
      kind: 'update';
      paths: readonly string[];
      verbosity: 'quiet' | 'normal' | 'verbose';
      timing: TimingFlags;
    }
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
  | { kind: 'unlock'; force: boolean }
  | { kind: 'clean'; all: boolean; force: boolean }
  | { kind: 'migrate' }
  | { kind: 'explain'; target: string; format: 'args' | 'json' }
  | {
      kind: 'resolve';
      sub: 'export';
      kinds: readonly string[];
      limit: number;
      force: boolean;
      out: string;
    }
  | { kind: 'resolve'; sub: 'import'; input: string }
  | { kind: 'resolve'; sub: 'status' }
  | { kind: 'not-implemented'; verb: string }
  | { kind: 'unknown-command'; input: string };

const RESERVED_VERBS = new Set(['export']);

export function parseArgv(argv: readonly string[]): ParsedCommand {
  const [first, ...rest] = argv;
  if (first === undefined) return { kind: 'help' };
  if (first === '--help' || first === '-h') return { kind: 'help' };
  if (first === '--version' || first === '-V') return { kind: 'version' };
  if (first === 'init') return { kind: 'init' };
  if (first === 'config') return { kind: 'config' };
  if (first === 'build') {
    return { kind: 'build', verbosity: pickVerbosity(rest), timing: pickTiming(rest) };
  }
  if (first === 'update') {
    return {
      kind: 'update',
      paths: rest.filter((a) => !a.startsWith('-')),
      verbosity: pickVerbosity(rest),
      timing: pickTiming(rest),
    };
  }
  if (first === 'tests') return parseTestsCmd(rest);
  if (first === 'sources') return parseSourcesCmd(rest);
  if (first === 'unlock') return { kind: 'unlock', force: rest.includes('--force') };
  if (first === 'clean') return { kind: 'clean', all: rest.includes('--all'), force: rest.includes('--force') };
  if (first === 'migrate') return { kind: 'migrate' };
  if (first === 'explain') {
    const target = rest.find((a) => !a.startsWith('-'));
    if (target === undefined) return { kind: 'unknown-command', input: 'explain (missing target)' };
    return { kind: 'explain', target, format: pickFormat(rest) };
  }
  if (first === 'resolve') return parseResolveCmd(rest);
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

function parseResolveCmd(rest: readonly string[]): ParsedCommand {
  const [sub, ...flags] = rest;
  if (sub === 'export') {
    const kindsRaw = getFlag(flags, '--kinds');
    const kinds = kindsRaw === null
      ? ['hook-fire', 'hook-listener']
      : kindsRaw.split(',').map((k) => k.trim()).filter((k) => k !== '');
    const limitRaw = getFlag(flags, '--limit');
    let limit = 50;
    if (limitRaw !== null) {
      const v = Number(limitRaw);
      if (Number.isFinite(v) && v > 0) limit = Math.floor(v);
    }
    const out = getValueFlag(flags, '-o') ?? getValueFlag(flags, '--out');
    if (out === null) return { kind: 'unknown-command', input: 'resolve export (missing -o)' };
    return { kind: 'resolve', sub: 'export', kinds, limit, force: flags.includes('--force'), out };
  }
  if (sub === 'import') {
    const input = flags.find((a) => !a.startsWith('-'));
    if (input === undefined) return { kind: 'unknown-command', input: 'resolve import (missing file)' };
    return { kind: 'resolve', sub: 'import', input };
  }
  if (sub === 'status') return { kind: 'resolve', sub: 'status' };
  return { kind: 'unknown-command', input: `resolve ${sub ?? ''}`.trim() };
}

function pickTiming(args: readonly string[]): TimingFlags {
  let emit = false;
  let topN = 0;
  for (const a of args) {
    if (a === '--timing') emit = true;
    else if (a.startsWith('--timing-top=')) {
      const v = Number(a.slice('--timing-top='.length));
      if (Number.isFinite(v) && v > 0) {
        emit = true;
        topN = Math.floor(v);
      }
    }
  }
  return { emit, topN };
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

// `--key=value` OR the space-separated `--key value` form.
function getValueFlag(args: readonly string[], key: string): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a.startsWith(`${key}=`)) return a.slice(key.length + 1);
    if (a === key) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) return next;
    }
  }
  return null;
}

export { RESERVED_VERBS };
