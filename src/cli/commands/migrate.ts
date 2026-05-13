import type { Io } from '../io.js';
import { openStore } from '../../store/open.js';
import { CURRENT_SCHEMA_VERSION } from '../../store/migrations.js';

export interface MigrateCommandArgs {
  readonly projectRoot: string;
  readonly io: Io;
}

export function migrateCommand(args: MigrateCommandArgs): number {
  const s = openStore(args.projectRoot);
  if (s.kind === 'err') {
    args.io.stderr.write(`ti: ${s.error.message}\n`);
    return 1;
  }
  const version = s.value.schemaVersion;
  s.value.close();
  if (version === CURRENT_SCHEMA_VERSION) {
    args.io.stderr.write(`ti: schema already at v${String(version)} (no migration needed)\n`);
    return 0;
  }
  args.io.stderr.write(
    `ti: schema at v${String(version)}, target v${String(CURRENT_SCHEMA_VERSION)} — no migration path implemented yet\n`,
  );
  return 1;
}
