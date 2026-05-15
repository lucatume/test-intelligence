import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/store/open.js';

describe('openStore', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ti-store-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates .ti/store.db on first open and applies migration to v3', () => {
    const r = openStore(root);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.schemaVersion).toBe(3);
    r.value.close();
  });

  it('opens an existing store without re-migrating', () => {
    {
      const r = openStore(root);
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') r.value.close();
    }
    const r2 = openStore(root);
    expect(r2.kind).toBe('ok');
    if (r2.kind === 'ok') {
      expect(r2.value.schemaVersion).toBe(3);
      r2.value.close();
    }
  });

  it('schema_version table rejects duplicate version rows', () => {
    const r = openStore(root);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(() => {
      r.value.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(3);
    }).toThrow(/UNIQUE constraint failed/);
    r.value.close();
  });

  it('contains the v2 tables after migration', () => {
    const r = openStore(root);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const tables = r.value.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    for (const expected of [
      'anchor',
      'edge',
      'fact',
      'fact_anchor',
      'file',
      'meta',
      'schema_version',
      'test',
    ]) {
      expect(names).toContain(expected);
    }
    // v2 dropped edge_provenance — provenance now lives on edge as JSON.
    expect(names).not.toContain('edge_provenance');
    r.value.close();
  });

  it('edge table has a provenance TEXT column (v2)', () => {
    const r = openStore(root);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const cols = r.value.db.prepare('PRAGMA table_info(edge)').all() as Array<{ name: string; type: string }>;
    expect(cols.find((c) => c.name === 'provenance')?.type).toBe('TEXT');
    r.value.close();
  });
});
