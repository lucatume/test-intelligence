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
  if (paths.length === 0) {
    args.io.stderr.write('ti: no paths given; pass paths positionally or via stdin\n');
    return 0;
  }

  const cfg = await loadEffectiveConfig(args.projectRoot, args.io);
  if (cfg === null) return 1;

  const r = await runBuild({
    projectRoot: args.projectRoot,
    config: cfg,
    clock: systemClock,
    stderr: args.io.stderr,
    verbosity: args.verbosity,
    onlyPaths: paths,
    ...(args.timing !== undefined ? { timing: { emit: args.timing.emit, topN: args.timing.topN } } : {}),
    ...(args.repoRoot !== undefined ? { repoRoot: args.repoRoot } : {}),
  });
  if (r.kind === 'err') {
    args.io.stderr.write(`ti: ${r.error.message}\n`);
    return 1;
  }
  return 0;
}
