import type { Io } from '../io.js';
import { createMemoryStore } from '../../store/open.js';
import { sourcesFromTests } from '../../query/sourcesFromTests.js';
import { emitArgs } from '../../emit/args.js';
import { emitJson } from '../../emit/json.js';
import { runBuild } from '../../build/run.js';
import { systemClock } from '../../clock.js';
import type { TimingFlags } from '../parseArgv.js';
import { loadEffectiveConfig } from './loadConfig.js';

export interface SourcesCommandArgs {
  readonly projectRoot: string;
  readonly io: Io;
  readonly testIds: readonly string[];
  readonly format: 'args' | 'json';
  readonly minConfidence: number;
  readonly strict: boolean;
  readonly timing?: TimingFlags;
}

export async function sourcesCommand(args: SourcesCommandArgs): Promise<number> {
  let inputs = args.testIds;
  if (inputs.length === 0 && !args.io.stdinIsTty) {
    const stdin = await args.io.readStdin();
    inputs = stdin.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  }
  if (inputs.length === 0) {
    args.io.stderr.write('ti: no test ids given (pass ids positionally or via stdin)\n');
    return 1;
  }
  const cfg = await loadEffectiveConfig(args.projectRoot, args.io);
  if (cfg === null) return 1;
  const s = createMemoryStore();
  if (s.kind === 'err') {
    args.io.stderr.write(`ti: ${s.error.message}\n`);
    return 1;
  }
  try {
    const build = await runBuild({
      projectRoot: args.projectRoot,
      config: cfg,
      clock: systemClock,
      db: s.value.db,
      stderr: args.io.stderr,
      ...(args.timing !== undefined ? { timing: args.timing } : {}),
    });
    if (build.kind === 'err') {
      args.io.stderr.write(`ti: ${build.error.message}\n`);
      return 1;
    }
    const r = sourcesFromTests(s.value.db, { testIds: inputs, minConfidence: args.minConfidence });
    for (const id of r.unknownTestIds) args.io.stderr.write(`ti: unknown test ${id}\n`);
    if (args.strict && r.unknownTestIds.length > 0) return 2;
    args.io.stdout.write(args.format === 'json' ? emitJson(r) : emitArgs(r, { mode: 'sources' }));
    return 0;
  } finally {
    s.value.close();
  }
}
