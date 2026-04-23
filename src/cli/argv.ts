import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { TiError } from '../errors.js';
import type { FrameworkName } from '../types.js';

export type InputSource =
  | { readonly kind: 'args'; readonly values: readonly string[] }
  | { readonly kind: 'stdin' };

export type OutputFormat = 'args' | 'json';

export type ParsedCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | {
      readonly kind: 'tests';
      readonly fromSources: InputSource;
      readonly framework: FrameworkName;
      readonly format: OutputFormat;
      readonly minConfidence: number | undefined;
      readonly strict: boolean;
    }
  | {
      readonly kind: 'sources';
      readonly fromTests: InputSource;
      readonly format: OutputFormat;
      readonly minConfidence: number | undefined;
      readonly strict: boolean;
    }
  | { readonly kind: 'explain'; readonly target: string }
  | { readonly kind: 'unlock'; readonly force: boolean };

export type ParseArgvInput = {
  readonly argv: readonly string[];
  readonly stdinIsTty: boolean;
};

const KNOWN_FRAMEWORKS: readonly FrameworkName[] = ['phpunit', 'jest', 'playwright'];
const KNOWN_FORMATS: readonly OutputFormat[] = ['args', 'json'];

type FlagValue = { readonly value: string; readonly consumedPositions: 1 | 2 };

function cliError(message: string): Result<ParsedCommand, TiError> {
  return err<TiError>({ kind: 'CliError', message });
}

// Splits `--key=value` and `--key value` uniformly. Returns consumedPositions 1
// for `--key=value` (current token only), 2 for `--key value` (current + next).
// Returns null if the current token doesn't match `flag`, or if the next token
// is missing or looks like another flag.
function readFlagValue(
  argv: readonly string[],
  i: number,
  flag: string,
): FlagValue | null {
  const tok = argv[i];
  if (tok === undefined) return null;
  if (tok.startsWith(`${flag}=`)) {
    return { value: tok.slice(flag.length + 1), consumedPositions: 1 };
  }
  if (tok === flag) {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('-')) return null;
    return { value: next, consumedPositions: 2 };
  }
  return null;
}

function parseMinConfidence(raw: string): Result<number, TiError> {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    return err<TiError>({
      kind: 'CliError',
      message: `--min-confidence must be a number in [0, 1], got '${raw}'`,
    });
  }
  return ok(n);
}

function parseFramework(raw: string): Result<FrameworkName, TiError> {
  if ((KNOWN_FRAMEWORKS as readonly string[]).includes(raw)) {
    return ok(raw as FrameworkName);
  }
  return err<TiError>({
    kind: 'CliError',
    message: `unknown framework '${raw}' — must be one of: ${KNOWN_FRAMEWORKS.join(', ')}`,
  });
}

function parseFormat(raw: string): Result<OutputFormat, TiError> {
  if ((KNOWN_FORMATS as readonly string[]).includes(raw)) {
    return ok(raw as OutputFormat);
  }
  return err<TiError>({
    kind: 'CliError',
    message: `--format must be one of: ${KNOWN_FORMATS.join(', ')}`,
  });
}

type ScanOutput = {
  readonly positionals: readonly string[];
  readonly named: Readonly<Record<string, string>>;
  readonly booleans: ReadonlySet<string>;
};

// Scans a subcommand's argv (starting *after* the subcommand token). Collects:
//   - positional tail of the `fromFlag` (paths/ids between fromFlag and the next --flag)
//   - value-bearing named flags (from the `named` list)
//   - boolean flags (from the `booleans` list)
// Unknown flags are rejected. Returns a CliError if `fromFlag` is missing.
function scanSubcommand(
  argv: readonly string[],
  spec: {
    readonly fromFlag: string;
    readonly named: readonly string[];
    readonly booleans: readonly string[];
  },
): Result<ScanOutput, TiError> {
  const positionals: string[] = [];
  const named: Record<string, string> = {};
  const booleans = new Set<string>();
  let sawFromFlag = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (tok === spec.fromFlag) {
      sawFromFlag = true;
      for (let j = i + 1; j < argv.length; j++) {
        const t = argv[j];
        if (t === undefined) break;
        if (t.startsWith('-')) break;
        positionals.push(t);
        i = j;
      }
      continue;
    }
    let matchedNamed = false;
    for (const flag of spec.named) {
      const v = readFlagValue(argv, i, flag);
      if (v !== null) {
        named[flag] = v.value;
        if (v.consumedPositions === 2) i += 1;
        matchedNamed = true;
        break;
      }
    }
    if (matchedNamed) continue;
    if (spec.booleans.includes(tok)) {
      booleans.add(tok);
      continue;
    }
    return err<TiError>({
      kind: 'CliError',
      message: `unknown or misplaced flag '${tok}'`,
    });
  }

  if (!sawFromFlag) {
    return err<TiError>({
      kind: 'CliError',
      message: `missing ${spec.fromFlag}`,
    });
  }
  return ok({ positionals, named, booleans });
}

function resolveInputSource(
  positionals: readonly string[],
  stdinIsTty: boolean,
  what: string,
): Result<InputSource, TiError> {
  if (positionals.length > 0) return ok({ kind: 'args', values: positionals });
  if (!stdinIsTty) return ok({ kind: 'stdin' });
  return err<TiError>({
    kind: 'CliError',
    message: `no ${what} given — pass them as positional arguments after --from-* or pipe newline-delimited input on stdin`,
  });
}

function parseTests(
  argv: readonly string[],
  stdinIsTty: boolean,
): Result<ParsedCommand, TiError> {
  const scan = scanSubcommand(argv, {
    fromFlag: '--from-sources',
    named: ['--framework', '--format', '--min-confidence'],
    booleans: ['--strict'],
  });
  if (scan.kind === 'err') return scan;
  const { positionals, named, booleans } = scan.value;

  const fwRaw = named['--framework'];
  if (fwRaw === undefined) {
    return cliError(`'ti tests --from-sources' requires --framework=<name>`);
  }
  const fw = parseFramework(fwRaw);
  if (fw.kind === 'err') return fw;

  let format: OutputFormat = 'args';
  const formatRaw = named['--format'];
  if (formatRaw !== undefined) {
    const r = parseFormat(formatRaw);
    if (r.kind === 'err') return r;
    format = r.value;
  }

  let minConfidence: number | undefined;
  const minConfRaw = named['--min-confidence'];
  if (minConfRaw !== undefined) {
    const r = parseMinConfidence(minConfRaw);
    if (r.kind === 'err') return r;
    minConfidence = r.value;
  }

  const src = resolveInputSource(positionals, stdinIsTty, 'source paths');
  if (src.kind === 'err') return src;

  return ok({
    kind: 'tests',
    fromSources: src.value,
    framework: fw.value,
    format,
    minConfidence,
    strict: booleans.has('--strict'),
  });
}

function parseSources(
  argv: readonly string[],
  stdinIsTty: boolean,
): Result<ParsedCommand, TiError> {
  const scan = scanSubcommand(argv, {
    fromFlag: '--from-tests',
    named: ['--format', '--min-confidence'],
    booleans: ['--strict'],
  });
  if (scan.kind === 'err') return scan;
  const { positionals, named, booleans } = scan.value;

  let format: OutputFormat = 'args';
  const formatRaw = named['--format'];
  if (formatRaw !== undefined) {
    const r = parseFormat(formatRaw);
    if (r.kind === 'err') return r;
    format = r.value;
  }

  let minConfidence: number | undefined;
  const minConfRaw = named['--min-confidence'];
  if (minConfRaw !== undefined) {
    const r = parseMinConfidence(minConfRaw);
    if (r.kind === 'err') return r;
    minConfidence = r.value;
  }

  const src = resolveInputSource(positionals, stdinIsTty, 'test ids or paths');
  if (src.kind === 'err') return src;

  return ok({
    kind: 'sources',
    fromTests: src.value,
    format,
    minConfidence,
    strict: booleans.has('--strict'),
  });
}

function parseExplain(argv: readonly string[]): Result<ParsedCommand, TiError> {
  const positionals: string[] = [];
  for (const tok of argv) {
    if (tok.startsWith('-')) {
      return err<TiError>({ kind: 'CliError', message: `'ti explain' takes no flags; got '${tok}'` });
    }
    positionals.push(tok);
  }
  if (positionals.length === 0) {
    return err<TiError>({ kind: 'CliError', message: `'ti explain' requires a target id or path` });
  }
  if (positionals.length > 1) {
    return err<TiError>({ kind: 'CliError', message: `'ti explain' requires exactly one target, got ${String(positionals.length)}` });
  }
  const [target] = positionals;
  return ok({ kind: 'explain', target: target ?? '' });
}

function parseUnlock(argv: readonly string[]): Result<ParsedCommand, TiError> {
  let force = false;
  for (const tok of argv) {
    if (tok === '--force') { force = true; continue; }
    return err<TiError>({ kind: 'CliError', message: `'ti unlock' does not accept '${tok}'` });
  }
  return ok({ kind: 'unlock', force });
}

export function parseArgv(input: ParseArgvInput): Result<ParsedCommand, TiError> {
  const { argv, stdinIsTty } = input;
  if (argv.length === 0) return ok({ kind: 'help' });
  const head = argv[0];
  if (head === '--help' || head === '-h') return ok({ kind: 'help' });
  if (head === '--version' || head === '-v') return ok({ kind: 'version' });
  const rest = argv.slice(1);
  switch (head) {
    case 'tests':
      return parseTests(rest, stdinIsTty);
    case 'sources':
      return parseSources(rest, stdinIsTty);
    case 'explain':
      return parseExplain(rest);
    case 'unlock':
      return parseUnlock(rest);
    default:
      return cliError(`unknown command '${String(head)}' — run 'ti --help' for usage`);
  }
}
