import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { useTmpDir } from '../helpers/tmpDir.js';
import {
  CURRENT_SCHEMA_VERSION,
  migrateToCurrent,
  getSchemaVersion,
} from '../../src/store/migrations.js';

// v1 schema (frozen — historical). This is what users upgrading from v1 have on disk.
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
CREATE INDEX fact_file_idx ON fact(file_id);
CREATE INDEX fact_kind_idx ON fact(kind);
CREATE TABLE anchor (
  id   INTEGER PRIMARY KEY,
  key  TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL
);
CREATE INDEX anchor_type_idx ON anchor(type);
CREATE TABLE fact_anchor (
  fact_id   INTEGER NOT NULL REFERENCES fact(id) ON DELETE CASCADE,
  anchor_id INTEGER NOT NULL REFERENCES anchor(id),
  role      TEXT NOT NULL,
  PRIMARY KEY (fact_id, anchor_id, role)
);
CREATE INDEX fact_anchor_anchor_idx ON fact_anchor(anchor_id, role);
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

function makeV1Store(root: string): Database.Database {
  const db = new Database(join(root, 'store.db'));
  db.exec('BEGIN');
  db.exec(V1_SCHEMA);
  db.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
  db.exec('COMMIT');
  return db;
}

describe('migrateToCurrent v1 -> v2', () => {
  const getTmp = useTmpDir('ti-migrate-v1v2-');

  it('upgrades schema_version to v2', () => {
    const db = makeV1Store(getTmp());
    try {
      expect(getSchemaVersion(db)).toBe(1);
      migrateToCurrent(db);
      expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(CURRENT_SCHEMA_VERSION).toBe(4);
    } finally { db.close(); }
  });

  it('drops edge_provenance and edge_prov_fact_idx', () => {
    const db = makeV1Store(getTmp());
    try {
      migrateToCurrent(db);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name)).not.toContain('edge_provenance');
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(indexes.map((i) => i.name)).not.toContain('edge_prov_fact_idx');
    } finally { db.close(); }
  });

  it('adds provenance TEXT NOT NULL DEFAULT \'[]\' column to edge', () => {
    const db = makeV1Store(getTmp());
    try {
      migrateToCurrent(db);
      const cols = db.prepare("PRAGMA table_info(edge)").all() as Array<{
        name: string; type: string; notnull: number; dflt_value: string | null;
      }>;
      const prov = cols.find((c) => c.name === 'provenance');
      expect(prov).toBeDefined();
      expect(prov?.type).toBe('TEXT');
      expect(prov?.notnull).toBe(1);
      expect(prov?.dflt_value).toBe("'[]'");
    } finally { db.close(); }
  });

  it('preserves existing edge rows with provenance = "[]"', () => {
    const root = getTmp();
    const db = makeV1Store(root);
    try {
      db.prepare(`
        INSERT INTO edge (test_id, source, confidence, partial, evidence, derived_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('t1', 'src/a.ts', 0.9, 0, '[]', 't');
      db.prepare(`
        INSERT INTO edge_provenance (test_id, source, fact_id) VALUES (?, ?, ?)
      `).run('t1', 'src/a.ts', 42);
      migrateToCurrent(db);
      const row = db.prepare('SELECT test_id, source, provenance FROM edge').get() as {
        test_id: string; source: string; provenance: string;
      };
      expect(row.test_id).toBe('t1');
      expect(row.source).toBe('src/a.ts');
      expect(row.provenance).toBe('[]');
    } finally { db.close(); }
  });

  it('is a no-op on the current version', () => {
    const db = makeV1Store(getTmp());
    try {
      migrateToCurrent(db);
      expect(getSchemaVersion(db)).toBe(4);
      migrateToCurrent(db);
      expect(getSchemaVersion(db)).toBe(4);
    } finally { db.close(); }
  });
});

describe('migrateToCurrent v2 -> v3', () => {
  const getTmp = useTmpDir('ti-migrate-v2v3-');

  it('adds the test_fact_idx index and bumps schema_version forward', () => {
    // A v1 store migrated forward must reach the current version with the
    // index present.
    const db = makeV1Store(getTmp());
    try {
      migrateToCurrent(db);
      expect(getSchemaVersion(db)).toBe(4);
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all() as Array<{ name: string }>;
      expect(indexes.map((i) => i.name)).toContain('test_fact_idx');
    } finally { db.close(); }
  });

  it('test_fact_idx resolves the fact-delete cascade without a table scan', () => {
    const db = makeV1Store(getTmp());
    try {
      migrateToCurrent(db);
      const plan = db
        .prepare('EXPLAIN QUERY PLAN DELETE FROM test WHERE fact_id = ?')
        .all(1) as Array<{ detail: string }>;
      const detail = plan.map((r) => r.detail).join(' ');
      expect(detail).toContain('test_fact_idx');
      expect(detail).not.toContain('SCAN test');
    } finally { db.close(); }
  });
});

describe('migrateToCurrent v3 -> v4', () => {
  const getTmp = useTmpDir('ti-migrate-v3v4-');

  it('migrates a v1 store forward to v4 adding the resolution table', () => {
    const db = makeV1Store(getTmp());
    try {
      migrateToCurrent(db);
      expect(getSchemaVersion(db)).toBe(4);
      expect(CURRENT_SCHEMA_VERSION).toBe(4);
      const cols = db.prepare('PRAGMA table_info(resolution)').all() as { name: string }[];
      expect(cols.map((c) => c.name).sort()).toEqual(
        ['cite_line', 'cite_path', 'cite_verified', 'classification',
         'expr_hash', 'imported_at', 'pass', 'resolved_value'].sort(),
      );
    } finally { db.close(); }
  });

  it('migrateToCurrent is idempotent on a v4 store', () => {
    const db = makeV1Store(getTmp());
    try {
      migrateToCurrent(db);
      expect(() => { migrateToCurrent(db); }).not.toThrow();
      expect(getSchemaVersion(db)).toBe(4);
    } finally { db.close(); }
  });
});
