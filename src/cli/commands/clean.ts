import type { Io } from '../io.js';
import { removeStoreContents } from '../../store/clean.js';

export interface CleanCommandArgs {
  readonly projectRoot: string;
  readonly io: Io;
  readonly all: boolean;
  readonly force: boolean;
}

export function cleanCommand(args: CleanCommandArgs): number {
  const r = removeStoreContents(args.projectRoot, { all: args.all, force: args.force });
  if (r.kind === 'err') {
    args.io.stderr.write(`ti: ${r.error.message}\n`);
    return 1;
  }
  args.io.stderr.write(
    args.all ? 'ti: removed .ti/\n' : 'ti: cleaned .ti/ contents\n',
  );
  return 0;
}
