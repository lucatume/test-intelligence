import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));

export const CURRENT_SCHEMA_VERSION = 5;

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
  if (current < 1) {
    throw new Error(`migrateToCurrent: no migration path from v${String(current)}`);
  }
  if (current < 2) {
    migrateV1ToV2(db);
  }
  if (current < 3) {
    migrateV2ToV3(db);
  }
  if (current < 4) {
    migrateV3ToV4(db);
  }
  if (current < 5) {
    migrateV4ToV5(db);
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

function migrateV2ToV3(db: Database.Database): void {
  db.exec('BEGIN');
  try {
    // Index test(fact_id) so the fact->test ON DELETE CASCADE is
    // index-resolved. Without it, clearFactsForFile's per-fact DELETE
    // forces a full SCAN of `test` to enforce the cascade.
    db.exec('CREATE INDEX IF NOT EXISTS test_fact_idx ON test(fact_id)');
    db.prepare('UPDATE schema_version SET version = ?').run(3);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function migrateV4ToV5(db: Database.Database): void {
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE wrapper_index (
        id              INTEGER PRIMARY KEY,
        wrapper_name    TEXT NOT NULL,
        wraps           TEXT NOT NULL,
        def_file        TEXT NOT NULL,
        def_start_line  INTEGER NOT NULL,
        def_end_line    INTEGER NOT NULL,
        arg_specs_json  TEXT NOT NULL,
        source          TEXT NOT NULL CHECK (source IN ('auto', 'config'))
      );
      CREATE INDEX wrapper_index_name     ON wrapper_index (wrapper_name);
      CREATE INDEX wrapper_index_def_file ON wrapper_index (def_file);
      CREATE TABLE wrapper_call_site (
        fact_id    INTEGER PRIMARY KEY REFERENCES fact(id) ON DELETE CASCADE,
        wrapper_id INTEGER NOT NULL REFERENCES wrapper_index(id) ON DELETE CASCADE
      );
    `);
    db.prepare('UPDATE schema_version SET version = ?').run(5);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function migrateV3ToV4(db: Database.Database): void {
  db.exec('BEGIN');
  try {
    // Additive: the LLM-resolution pass cache. No data migration.
    db.exec(`
      CREATE TABLE resolution (
        expr_hash      TEXT NOT NULL,
        pass           TEXT NOT NULL,
        resolved_value TEXT NOT NULL,
        classification TEXT NOT NULL,
        cite_path      TEXT NOT NULL,
        cite_line      INTEGER NOT NULL,
        cite_verified  INTEGER NOT NULL,
        imported_at    TEXT NOT NULL,
        PRIMARY KEY (expr_hash, pass)
      );
      CREATE INDEX resolution_class_idx ON resolution(classification);
    `);
    db.prepare('UPDATE schema_version SET version = ?').run(4);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
