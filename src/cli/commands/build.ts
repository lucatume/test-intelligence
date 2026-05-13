import type { Io } from '../io.js';
import { runBuild } from '../../build/run.js';
import { systemClock } from '../../clock.js';
import { loadEffectiveConfig } from './loadConfig.js';

export interface BuildCommandArgs {
  readonly projectRoot: string;
  readonly io: Io;
  readonly verbosity: 'quiet' | 'normal' | 'verbose';
  readonly repoRoot?: string;
}

export async function buildCommand(args: BuildCommandArgs): Promise<number> {
  const cfg = await loadEffectiveConfig(args.projectRoot, args.io);
  if (cfg === null) return 1;
  const r = await runBuild({
    projectRoot: args.projectRoot,
    config: cfg,
    clock: systemClock,
    stderr: args.io.stderr,
    verbosity: args.verbosity,
    ...(args.repoRoot !== undefined ? { repoRoot: args.repoRoot } : {}),
  });
  if (r.kind === 'err') {
    args.io.stderr.write(`ti: ${r.error.message}\n`);
    return 1;
  }
  return 0;
}
