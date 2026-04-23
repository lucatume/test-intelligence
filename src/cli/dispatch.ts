import * as path from 'node:path';
import { parseArgv } from './argv.js';
import type { ParsedCommand } from './argv.js';
import type { Io } from './io.js';
import { HELP_TEXT } from './help.js';
import { versionString } from './version.js';
import { resolveProjectRoot } from '../config/resolve.js';
import { unlockManaged } from '../storage/lock.js';
import { exitCodeFor, stderrLine } from '../errors.js';
import type { TiError } from '../errors.js';
import type { Clock } from '../clock.js';
import { readIndex, readShard } from '../storage/read.js';
import { readSchemaVersion, checkSchemaRange } from '../storage/schema.js';
import type { Shard } from '../storage/shard.js';
import type { Index } from '../storage/index.js';
import { parseProjectRelativePath } from '../paths.js';
import { parseTestId } from '../ids.js';
import { computeSourceHash } from '../query/hash.js';
import { testsFromSources } from '../query/testsFromSources.js';
import type { ShardWithStaleness } from '../query/testsFromSources.js';
import { sourcesFromTests } from '../query/sourcesFromTests.js';
import type { TestInput } from '../query/sourcesFromTests.js';
import { explain as explainQuery } from '../query/explain.js';
import type { ExplainTarget } from '../query/explain.js';
import type { Weights } from '../query/confidence.js';
import { formatArgs } from '../emit/args.js';
import { formatTestsJson, formatSourcesArgs, formatSourcesJson, formatExplainJson, formatExplainHuman } from '../emit/json.js';
import { loadConfigFile } from '../config/load.js';
import { parseConfig } from '../config/parse.js';

export type DispatchInput = {
  readonly argv: readonly string[];
  readonly io: Io;
  readonly cwd: string;
  readonly clock: Clock;
};

function emitError(io: Io, err: TiError): void {
  io.stderr.write(`${stderrLine(err, 'error')}\n`);
}

function emitNotice(io: Io, message: string): void {
  io.stderr.write(`ti: info: ${message}\n`);
}

const DEFAULT_WEIGHTS: Weights = { runtime: 1.0, static: 0.7, heuristic: 0.3 };

type LoadedMap = {
  readonly projectRoot: string;
  readonly tiDir: string;
  readonly index: Index;
  readonly weights: Weights;
};

async function loadMapGated(
  cwd: string,
  io: Io,
): Promise<{ ok: LoadedMap } | { exitCode: number }> {
  const rooted = await resolveProjectRoot(cwd);
  if (rooted.kind === 'err') {
    emitError(io, rooted.error);
    return { exitCode: exitCodeFor(rooted.error, { strict: false }) };
  }
  const tiDir = path.join(rooted.value.projectRoot, '.test-intelligence');
  const versionRead = await readSchemaVersion(tiDir);
  if (versionRead.kind === 'err') {
    emitError(io, versionRead.error);
    return { exitCode: exitCodeFor(versionRead.error, { strict: false }) };
  }
  const check = checkSchemaRange(versionRead.value);
  if (check.kind === 'err') {
    emitError(io, check.error);
    return { exitCode: exitCodeFor(check.error, { strict: false }) };
  }
  const indexRead = await readIndex(tiDir);
  if (indexRead.kind === 'err') {
    emitError(io, indexRead.error);
    return { exitCode: exitCodeFor(indexRead.error, { strict: false }) };
  }
  let weights: Weights = DEFAULT_WEIGHTS;
  const cfgRaw = await loadConfigFile(rooted.value.configFile);
  if (cfgRaw.kind === 'ok') {
    const parsed = parseConfig(cfgRaw.value);
    if (parsed.kind === 'ok') {
      weights = parsed.value.confidence;
    }
  }
  return {
    ok: {
      projectRoot: rooted.value.projectRoot,
      tiDir,
      index: indexRead.value,
      weights,
    },
  };
}

async function loadShardsForSources(
  map: LoadedMap,
  projectRelSources: readonly string[],
): Promise<{ shardsBySource: Map<string, ShardWithStaleness>; unknown: string[]; errors: TiError[] }> {
  const shardsBySource = new Map<string, ShardWithStaleness>();
  const unknown: string[] = [];
  const errors: TiError[] = [];
  for (const src of projectRelSources) {
    const shardHash = map.index.by_path[src];
    if (shardHash === undefined) {
      unknown.push(src);
      continue;
    }
    const shardPath = path.join(map.tiDir, 'shards', `${shardHash}.json`);
    const r = await readShard(shardPath);
    if (r.kind === 'err') {
      errors.push(r.error);
      continue;
    }
    const absoluteSource = path.join(map.projectRoot, src);
    const hashNow = await computeSourceHash(absoluteSource);
    const stale = hashNow.kind === 'ok' && hashNow.value !== r.value.source_hash;
    shardsBySource.set(src, { shard: r.value, stale });
  }
  return { shardsBySource, unknown, errors };
}

async function loadAllShards(
  map: LoadedMap,
): Promise<{ shards: Array<{ shard: Shard; stale: boolean }>; errors: TiError[] }> {
  const seen = new Set<string>();
  for (const hash of Object.values(map.index.by_path)) seen.add(hash);
  const shards: Array<{ shard: Shard; stale: boolean }> = [];
  const errors: TiError[] = [];
  for (const hash of seen) {
    const r = await readShard(path.join(map.tiDir, 'shards', `${hash}.json`));
    if (r.kind === 'err') {
      errors.push(r.error);
      continue;
    }
    const absoluteSource = path.join(map.projectRoot, r.value.source);
    const hashNow = await computeSourceHash(absoluteSource);
    const stale = hashNow.kind === 'ok' && hashNow.value !== r.value.source_hash;
    shards.push({ shard: r.value, stale });
  }
  return { shards, errors };
}

async function readStdinLines(io: Io): Promise<string[]> {
  const raw = await io.readStdin();
  return raw.split('\n').map((s) => s.trim()).filter((s) => s !== '');
}

function runHelp(io: Io): 0 {
  io.stdout.write(HELP_TEXT);
  return 0;
}

function runVersion(io: Io): 0 {
  io.stdout.write(`${versionString()}\n`);
  return 0;
}

async function runUnlock(
  cmd: Extract<ParsedCommand, { kind: 'unlock' }>,
  io: Io,
  cwd: string,
): Promise<number> {
  const rooted = await resolveProjectRoot(cwd);
  if (rooted.kind === 'err') {
    emitError(io, rooted.error);
    return exitCodeFor(rooted.error, { strict: false });
  }
  const tiDir = path.join(rooted.value.projectRoot, '.test-intelligence');
  const r = await unlockManaged({ tiDir, force: cmd.force });
  if (r.kind === 'err') {
    emitError(io, r.error);
    return exitCodeFor(r.error, { strict: false });
  }
  if (r.value.kind === 'no-lock') {
    emitNotice(io, `no lock at ${path.join(tiDir, '.lock')}`);
    return 0;
  }
  const prev = r.value.previous;
  if (prev === null) {
    emitNotice(io, 'released unparseable lock file');
  } else {
    emitNotice(io, `released lock (was pid=${String(prev.pid)}, host=${prev.hostname}, command='${prev.command}')`);
  }
  return 0;
}

async function runTests(
  cmd: Extract<ParsedCommand, { kind: 'tests' }>,
  io: Io,
  cwd: string,
): Promise<number> {
  const loaded = await loadMapGated(cwd, io);
  if ('exitCode' in loaded) return loaded.exitCode;
  const map = loaded.ok;

  const rawInputs = cmd.fromSources.kind === 'args'
    ? cmd.fromSources.values
    : await readStdinLines(io);
  const projectRelSources: string[] = [];
  const inputUnknown: string[] = [];
  for (const raw of rawInputs) {
    const r = parseProjectRelativePath(raw, map.projectRoot);
    if (r.kind === 'err') {
      inputUnknown.push(raw);
      continue;
    }
    projectRelSources.push(r.value);
  }

  const loadShards = await loadShardsForSources(map, projectRelSources);
  for (const e of loadShards.errors) io.stderr.write(`${stderrLine(e, 'warning')}\n`);

  const result = testsFromSources({
    shardsBySource: loadShards.shardsBySource,
    sources: projectRelSources,
    framework: cmd.framework,
    minConfidence: cmd.minConfidence,
    weights: map.weights,
  });

  const allUnknown = [...inputUnknown, ...loadShards.unknown, ...result.unknownInputs];
  for (const u of allUnknown) {
    io.stderr.write(`ti: warning: unknown input '${u}'\n`);
  }

  const body = cmd.format === 'json' ? formatTestsJson(result) : formatArgs(result);
  if (body.length > 0) io.stdout.write(`${body}\n`);

  if (allUnknown.length > 0 && cmd.strict) {
    return exitCodeFor({ kind: 'UnknownInputError', message: '', inputs: allUnknown }, { strict: true });
  }
  return 0;
}

async function runSources(
  cmd: Extract<ParsedCommand, { kind: 'sources' }>,
  io: Io,
  cwd: string,
): Promise<number> {
  const loaded = await loadMapGated(cwd, io);
  if ('exitCode' in loaded) return loaded.exitCode;
  const map = loaded.ok;

  const rawInputs = cmd.fromTests.kind === 'args'
    ? cmd.fromTests.values
    : await readStdinLines(io);
  const parsedInputs: TestInput[] = [];
  const inputUnknown: string[] = [];
  for (const raw of rawInputs) {
    if (raw.includes(':')) {
      const idR = parseTestId(raw, map.projectRoot);
      if (idR.kind === 'err') {
        inputUnknown.push(raw);
        continue;
      }
      parsedInputs.push({ kind: 'id', framework: idR.value.framework, file: idR.value.file, filter: idR.value.filter, raw });
    } else {
      const pR = parseProjectRelativePath(raw, map.projectRoot);
      if (pR.kind === 'err') {
        inputUnknown.push(raw);
        continue;
      }
      parsedInputs.push({ kind: 'file', file: pR.value, raw });
    }
  }

  const all = await loadAllShards(map);
  for (const e of all.errors) io.stderr.write(`${stderrLine(e, 'warning')}\n`);

  const result = sourcesFromTests({
    allShards: all.shards,
    inputs: parsedInputs,
    minConfidence: cmd.minConfidence,
    weights: map.weights,
  });

  const allUnknown = [...inputUnknown, ...result.unknownInputs];
  for (const u of allUnknown) {
    io.stderr.write(`ti: warning: unknown input '${u}'\n`);
  }

  const body = cmd.format === 'json' ? formatSourcesJson(result) : formatSourcesArgs(result);
  if (body.length > 0) io.stdout.write(`${body}\n`);

  if (allUnknown.length > 0 && cmd.strict) {
    return exitCodeFor({ kind: 'UnknownInputError', message: '', inputs: allUnknown }, { strict: true });
  }
  return 0;
}

async function runExplain(
  cmd: Extract<ParsedCommand, { kind: 'explain' }>,
  io: Io,
  cwd: string,
): Promise<number> {
  const loaded = await loadMapGated(cwd, io);
  if ('exitCode' in loaded) return loaded.exitCode;
  const map = loaded.ok;

  let target: ExplainTarget;
  const raw = cmd.target;
  const colon = raw.indexOf(':');
  if (colon > 0) {
    const prefix = raw.slice(0, colon);
    if (prefix === 'http' || prefix === 'rest' || prefix === 'cli') {
      target = { kind: 'view-id', raw };
    } else {
      const idR = parseTestId(raw, map.projectRoot);
      if (idR.kind === 'err') {
        io.stderr.write(`ti: error: unknown id: ${raw}\n`);
        return 1;
      }
      target = { kind: 'id', framework: idR.value.framework, file: idR.value.file, filter: idR.value.filter, raw };
    }
  } else {
    const pR = parseProjectRelativePath(raw, map.projectRoot);
    if (pR.kind === 'err') {
      io.stderr.write(`ti: error: unknown id: ${raw}\n`);
      return 1;
    }
    target = { kind: 'source', path: pR.value, raw };
  }

  const all = await loadAllShards(map);
  for (const e of all.errors) io.stderr.write(`${stderrLine(e, 'warning')}\n`);

  const result = explainQuery({ target, allShards: all.shards, weights: map.weights });
  if (result.kind === 'unknown') {
    io.stderr.write(`ti: error: unknown id: ${result.target}\n`);
    return 1;
  }
  io.stdout.write(`${formatExplainHuman(result)}\n`);
  // formatExplainJson is kept so Plan C can wire --format for explain.
  void formatExplainJson;
  return 0;
}

export async function dispatch(input: DispatchInput): Promise<number> {
  const parsed = parseArgv({ argv: input.argv, stdinIsTty: input.io.stdinIsTty });
  if (parsed.kind === 'err') {
    emitError(input.io, parsed.error);
    return exitCodeFor(parsed.error, { strict: false });
  }
  const cmd = parsed.value;
  switch (cmd.kind) {
    case 'help':    return runHelp(input.io);
    case 'version': return runVersion(input.io);
    case 'unlock':  return runUnlock(cmd, input.io, input.cwd);
    case 'tests':   return runTests(cmd, input.io, input.cwd);
    case 'sources': return runSources(cmd, input.io, input.cwd);
    case 'explain': return runExplain(cmd, input.io, input.cwd);
  }
}
