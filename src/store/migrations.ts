import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));

export const CURRENT_SCHEMA_VERSION = 1;

export function readCurrentSchema(): string {
  return readFileSync(join(here, 'schema.sql'), 'utf8');
}

export function getSchemaVersion(db: Database.Database): number | null {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get();
  if (!row) return null;
  const v = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined;
  return v?.version ?? null;
}

export function applyInitialSchema(db: Database.Database): void {
  const sql = readCurrentSchema();
  db.exec('BEGIN');
  try {
    db.exec(sql);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(CURRENT_SCHEMA_VERSION);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
