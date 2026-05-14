import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));

export const CURRENT_SCHEMA_VERSION = 2;

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

/**
 * Run any pending migrations against the connected database. Idempotent —
 * safe to call on a store already at CURRENT_SCHEMA_VERSION.
 *
 * Throws on programmer errors (corrupt schema, missing schema_version table).
 * Callers handle these as fatal — `ti migrate` surfaces the message to stderr.
 */
export function migrateToCurrent(db: Database.Database): void {
  const current = getSchemaVersion(db);
  if (current === null) {
    throw new Error('migrateToCurrent: schema_version table missing');
  }
  if (current === CURRENT_SCHEMA_VERSION) return;
  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(`migrateToCurrent: schema v${String(current)} newer than supported v${String(CURRENT_SCHEMA_VERSION)}`);
  }
  if (current === 1) {
    migrateV1ToV2(db);
  } else {
    throw new Error(`migrateToCurrent: no migration path from v${String(current)}`);
  }
}

function migrateV1ToV2(db: Database.Database): void {
  db.exec('BEGIN');
  try {
    // Add provenance JSON column with literal default '[]' so existing rows
    // become "[]". SQLite expression-default of NULL would violate NOT NULL,
    // so we rely on the string literal default.
    db.exec(`ALTER TABLE edge ADD COLUMN provenance TEXT NOT NULL DEFAULT '[]'`);
    // Drop the old provenance table + its sole index.
    db.exec('DROP INDEX IF EXISTS edge_prov_fact_idx');
    db.exec('DROP TABLE IF EXISTS edge_provenance');
    db.prepare('UPDATE schema_version SET version = ?').run(2);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
