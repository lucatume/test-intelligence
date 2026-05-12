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

  it('creates .ti/store.db on first open and applies migration to v1', () => {
    const r = openStore(root);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.schemaVersion).toBe(1);
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
      expect(r2.value.schemaVersion).toBe(1);
      r2.value.close();
    }
  });

  it('contains the v1 tables after migration', () => {
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
      'edge_provenance',
      'fact',
      'fact_anchor',
      'file',
      'meta',
      'schema_version',
      'test',
    ]) {
      expect(names).toContain(expected);
    }
    r.value.close();
  });
});
