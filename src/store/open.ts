import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Result } from '../result.js';
import { err, ok } from '../result.js';
import {
  CURRENT_SCHEMA_VERSION,
  applyInitialSchema,
  getSchemaVersion,
} from './migrations.js';

export interface OpenStore {
  readonly db: Database.Database;
  readonly schemaVersion: number;
  readonly close: () => void;
}

export interface OpenStoreError {
  readonly kind: 'OpenStoreError';
  readonly message: string;
}

export function openStore(projectRoot: string): Result<OpenStore, OpenStoreError> {
  const tiDir = join(projectRoot, '.ti');
  if (!existsSync(tiDir)) mkdirSync(tiDir, { recursive: true });

  const dbPath = join(tiDir, 'store.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  let version = getSchemaVersion(db);
  if (version === null) {
    applyInitialSchema(db);
    version = CURRENT_SCHEMA_VERSION;
  } else if (version < CURRENT_SCHEMA_VERSION) {
    db.close();
    return err({
      kind: 'OpenStoreError',
      message: `schema v${String(version)} below supported range — run \`ti migrate\``,
    });
  } else if (version > CURRENT_SCHEMA_VERSION) {
    db.close();
    return err({
      kind: 'OpenStoreError',
      message: `schema v${String(version)} above supported range — upgrade ti`,
    });
  }

  return ok({
    db,
    schemaVersion: version,
    close: () => { db.close(); },
  });
}
