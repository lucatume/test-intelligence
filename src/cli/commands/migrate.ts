import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Io } from '../io.js';
import {
  CURRENT_SCHEMA_VERSION,
  getSchemaVersion,
  migrateToCurrent,
} from '../../store/migrations.js';

export interface MigrateCommandArgs {
  readonly projectRoot: string;
  readonly io: Io;
}

export function migrateCommand(args: MigrateCommandArgs): number {
  const dbPath = join(args.projectRoot, '.ti', 'store.db');
  // Avoid auto-creating an empty .ti store: when no DB exists, treat as
  // "already up to date" — the caller has nothing to migrate.
  if (!existsSync(dbPath)) {
    args.io.stderr.write(`ti: schema already at v${String(CURRENT_SCHEMA_VERSION)} (no migration needed)\n`);
    return 0;
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  } catch (e) {
    args.io.stderr.write(`ti: failed to open ${dbPath}: ${(e as Error).message}\n`);
    return 1;
  }

  try {
    const before = getSchemaVersion(db);
    if (before === null) {
      args.io.stderr.write('ti: store has no schema_version table — refusing to touch it\n');
      return 1;
    }
    if (before === CURRENT_SCHEMA_VERSION) {
      args.io.stderr.write(`ti: schema already at v${String(before)} (no migration needed)\n`);
      return 0;
    }
    if (before > CURRENT_SCHEMA_VERSION) {
      args.io.stderr.write(
        `ti: schema at v${String(before)} is newer than supported v${String(CURRENT_SCHEMA_VERSION)} — upgrade ti\n`,
      );
      return 1;
    }
    try {
      migrateToCurrent(db);
    } catch (e) {
      args.io.stderr.write(`ti: migration failed: ${(e as Error).message}\n`);
      return 1;
    }
    args.io.stderr.write(
      `ti: migrated schema v${String(before)} -> v${String(CURRENT_SCHEMA_VERSION)}\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}
