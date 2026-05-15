import type { Io } from '../io.js';
import { runBuild } from '../../build/run.js';
import { systemClock } from '../../clock.js';
import type { TimingFlags } from '../parseArgv.js';
import { loadEffectiveConfig } from './loadConfig.js';

export interface UpdateCommandArgs {
  readonly projectRoot: string;
  readonly io: Io;
  readonly verbosity: 'quiet' | 'normal' | 'verbose';
  readonly paths: readonly string[];
  readonly timing?: TimingFlags;
  readonly repoRoot?: string;
}

export async function updateCommand(args: UpdateCommandArgs): Promise<number> {
  let paths = args.paths;
  if (paths.length === 0 && !args.io.stdinIsTty) {
    const stdin = await args.io.readStdin();
    paths = stdin.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  }

  const cfg = await loadEffectiveConfig(args.projectRoot, args.io);
  if (cfg === null) return 1;

  // No paths → re-validate hashes over the full discovery walk: every file is
  // hashed, unchanged ones skip extraction, changed/new ones re-extract. With
  // paths → differential update over the listed paths. Both run with the
  // content-hash skip on; only `ti build` does a forced full extract.
  const r = await runBuild({
    projectRoot: args.projectRoot,
    config: cfg,
    clock: systemClock,
    stderr: args.io.stderr,
    verbosity: args.verbosity,
    skipUnchanged: true,
    ...(paths.length > 0 ? { onlyPaths: paths } : {}),
    ...(args.timing !== undefined ? { timing: { emit: args.timing.emit, topN: args.timing.topN } } : {}),
    ...(args.repoRoot !== undefined ? { repoRoot: args.repoRoot } : {}),
  });
  if (r.kind === 'err') {
    args.io.stderr.write(`ti: ${r.error.message}\n`);
    return 1;
  }
  return 0;
}
