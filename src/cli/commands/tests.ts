import type { Io } from '../io.js';
import { openStore } from '../../store/open.js';
import { testsFromSources } from '../../query/testsFromSources.js';
import { emitArgs } from '../../emit/args.js';
import { emitJson } from '../../emit/json.js';
import type { FrameworkName } from '../../types.js';

const FRAMEWORKS: ReadonlySet<string> = new Set(['phpunit', 'jest', 'playwright']);

export interface TestsCommandArgs {
  readonly projectRoot: string;
  readonly io: Io;
  readonly sources: readonly string[];
  readonly framework: string | null;
  readonly format: 'args' | 'json';
  readonly minConfidence: number;
  readonly strict: boolean;
}

export async function testsCommand(args: TestsCommandArgs): Promise<number> {
  if (args.framework === null || !FRAMEWORKS.has(args.framework)) {
    args.io.stderr.write('ti: --framework=<phpunit|jest|playwright> is required for `ti tests`\n');
    return 1;
  }
  let inputs = args.sources;
  if (inputs.length === 0 && !args.io.stdinIsTty) {
    const stdin = await args.io.readStdin();
    inputs = stdin.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  }
  if (inputs.length === 0) {
    args.io.stderr.write('ti: no source paths given (pass paths positionally or via stdin)\n');
    return 1;
  }
  const s = openStore(args.projectRoot);
  if (s.kind === 'err') {
    args.io.stderr.write(`ti: ${s.error.message}\n`);
    return 1;
  }
  try {
    const r = testsFromSources(s.value.db, {
      sources: inputs,
      framework: args.framework as FrameworkName,
      minConfidence: args.minConfidence,
    });
    for (const p of r.unknownPaths) args.io.stderr.write(`ti: unknown path ${p}\n`);
    if (args.strict && r.unknownPaths.length > 0) return 2;
    args.io.stdout.write(args.format === 'json' ? emitJson(r) : emitArgs(r, { mode: 'tests' }));
    return 0;
  } finally {
    s.value.close();
  }
}
