import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrateCommand } from '../../../src/cli/commands/migrate.js';
import { useTmpDir } from '../../helpers/tmpDir.js';
import { makeIo } from '../_helpers/makeIo.js';

const V1_SCHEMA = `
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY NOT NULL
);
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE file (
  id              INTEGER PRIMARY KEY,
  path            TEXT NOT NULL UNIQUE,
  language        TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  extracted_at    TEXT NOT NULL,
  is_test         INTEGER NOT NULL,
  framework       TEXT,
  framework_class TEXT
);
CREATE INDEX file_path_idx ON file(path);
CREATE TABLE fact (
  id          INTEGER PRIMARY KEY,
  file_id     INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  resolved    INTEGER NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  payload     TEXT NOT NULL
);
CREATE TABLE anchor (
  id   INTEGER PRIMARY KEY,
  key  TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL
);
CREATE TABLE fact_anchor (
  fact_id   INTEGER NOT NULL REFERENCES fact(id) ON DELETE CASCADE,
  anchor_id INTEGER NOT NULL REFERENCES anchor(id),
  role      TEXT NOT NULL,
  PRIMARY KEY (fact_id, anchor_id, role)
);
CREATE TABLE test (
  test_id          TEXT PRIMARY KEY,
  file_id          INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  framework        TEXT NOT NULL,
  framework_class  TEXT NOT NULL,
  fact_id          INTEGER NOT NULL REFERENCES fact(id) ON DELETE CASCADE
);
CREATE TABLE edge (
  test_id    TEXT NOT NULL,
  source     TEXT NOT NULL,
  confidence REAL NOT NULL,
  partial    INTEGER NOT NULL,
  evidence   TEXT NOT NULL,
  derived_at TEXT NOT NULL,
  PRIMARY KEY (test_id, source)
);
CREATE INDEX edge_source_idx ON edge(source);
CREATE TABLE edge_provenance (
  test_id TEXT NOT NULL,
  source  TEXT NOT NULL,
  fact_id INTEGER NOT NULL,
  PRIMARY KEY (test_id, source, fact_id)
);
CREATE INDEX edge_prov_fact_idx ON edge_provenance(fact_id);
`;

function makeV1Store(root: string): void {
  const tiDir = join(root, '.ti');
  if (!existsSync(tiDir)) mkdirSync(tiDir, { recursive: true });
  const db = new Database(join(tiDir, 'store.db'));
  db.exec('BEGIN');
  db.exec(V1_SCHEMA);
  db.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
  db.exec('COMMIT');
  db.close();
}

describe('migrateCommand', () => {
  const getTmp = useTmpDir('ti-migrate-');

  it('exits 0 with already-current message on fresh store', () => {
    const root = getTmp();
    const t = makeIo();
    expect(migrateCommand({ projectRoot: root, io: t.io })).toBe(0);
    expect(t.err).toMatch(/already at v/);
  });

  it('migrates v1 store to the current version', () => {
    const root = getTmp();
    makeV1Store(root);
    const t = makeIo();
    expect(migrateCommand({ projectRoot: root, io: t.io })).toBe(0);
    expect(t.err).toMatch(/migrated.*v1.*v3/i);

    // After migration the store should open cleanly.
    const db = new Database(join(root, '.ti', 'store.db'));
    try {
      const v = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
      expect(v).toBe(3);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      expect(tables.map((r) => r.name)).not.toContain('edge_provenance');
      const cols = db.prepare('PRAGMA table_info(edge)').all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain('provenance');
    } finally { db.close(); }
  });
});
