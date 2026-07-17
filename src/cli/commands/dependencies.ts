import type { Io } from '../io.js';
import type { TimingFlags } from '../parseArgv.js';
import { createMemoryStore } from '../../store/open.js';
import { runBuild } from '../../build/run.js';
import { sourceDependencies } from '../../build/dependencies.js';
import { systemClock } from '../../clock.js';
import { loadEffectiveConfig } from './loadConfig.js';

export interface DependenciesCommandArgs {
  readonly projectRoot: string;
  readonly io: Io;
  readonly sources: readonly string[];
  readonly format: 'args' | 'json';
  readonly minConfidence: number;
  readonly strict: boolean;
  readonly timing?: TimingFlags;
}

export async function dependenciesCommand(args: DependenciesCommandArgs): Promise<number> {
  let inputs = args.sources;
  if (inputs.length === 0 && !args.io.stdinIsTty) {
    inputs = (await args.io.readStdin()).split('\n').map((line) => line.trim()).filter(Boolean);
  }
  if (inputs.length === 0) {
    args.io.stderr.write('ti: no source paths given (pass paths positionally or via stdin)\n');
    return 1;
  }
  const config = await loadEffectiveConfig(args.projectRoot, args.io);
  if (config === null) return 1;
  const store = createMemoryStore();
  if (store.kind === 'err') {
    args.io.stderr.write(`ti: ${store.error.message}\n`);
    return 1;
  }
  try {
    const build = await runBuild({
      projectRoot: args.projectRoot,
      config,
      clock: systemClock,
      db: store.value.db,
      stderr: args.io.stderr,
      ...(args.timing !== undefined ? { timing: args.timing } : {}),
    });
    if (build.kind === 'err') {
      args.io.stderr.write(`ti: ${build.error.message}\n`);
      return 1;
    }
    const result = sourceDependencies(store.value.db, config, inputs, args.minConfidence);
    for (const path of result.unknownPaths) args.io.stderr.write(`ti: unknown path ${path}\n`);
    if (args.strict && result.unknownPaths.length > 0) return 2;
    if (args.format === 'json') {
      args.io.stdout.write(JSON.stringify({ dependencies: result.rows, unknownPaths: result.unknownPaths }) + '\n');
    } else {
      const targets = [...new Set(result.rows.map((row) => row.target))].sort();
      if (targets.length > 0) args.io.stdout.write(targets.join('\n') + '\n');
    }
    return 0;
  } finally {
    store.value.close();
  }
}
