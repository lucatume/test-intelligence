import { describe, it, expect } from 'vitest';
import { openStore } from '../../src/store/index.js';
import { upsertFile, insertFact, upsertAnchor, insertFactAnchor, clearFactsForFile } from '../../src/store/writers.js';
import {
  installFactChangeTracker,
  readChangedFileIds,
  dropFactChangeTracker,
  snapshotFactAnchors,
} from '../../src/store/changed-files.js';
import { useTmpDir } from '../helpers/tmpDir.js';

function open(root: string) {
  const r = openStore(root);
  if (r.kind === 'err') throw new Error(r.error.message);
  return r.value;
}

function addFile(db: ReturnType<typeof open>['db'], path: string): number {
  return upsertFile(db, {
    path,
    language: 'php',
    contentHash: 'h1',
    extractedAt: '2026-06-12T00:00:00.000Z',
    isTest: false,
    framework: null,
    frameworkClass: null,
  });
}

describe('fact-change tracker', () => {
  const getTmp = useTmpDir('ti-changed-files-');

  it('records file ids for fact inserts, deletes, and anchor attaches', () => {
    const { db, close } = open(getTmp());
    const fa = addFile(db, 'a.php');
    const fb = addFile(db, 'b.php');
    // Pre-existing fact in b.php, attached before the tracker installs.
    const preFact = insertFact(db, {
      fileId: fb, kind: 'symbol-def', resolved: true, startLine: 1, endLine: 1,
      payload: { kind: 'symbol-def', name: 'pre', exported: true },
    });

    installFactChangeTracker(db);
    expect(readChangedFileIds(db).size).toBe(0);

    // INSERT on fact → a.php recorded
    insertFact(db, {
      fileId: fa, kind: 'symbol-use', resolved: true, startLine: 2, endLine: 2,
      payload: { kind: 'symbol-use', name: 'x' },
    });
    // fact_anchor INSERT on a pre-existing fact → b.php recorded
    const anchorId = upsertAnchor(db, { key: 'php-symbol:pre', type: 'php-symbol' });
    insertFactAnchor(db, { factId: preFact, anchorId, role: 'target' });

    const changed = readChangedFileIds(db);
    expect(changed.has(fa)).toBe(true);
    expect(changed.has(fb)).toBe(true);

    dropFactChangeTracker(db);
    close();
  });

  it('records file ids when a file is re-extracted (clearFactsForFile + insert)', () => {
    const { db, close } = open(getTmp());
    const fa = addFile(db, 'a.php');
    insertFact(db, {
      fileId: fa, kind: 'symbol-def', resolved: true, startLine: 1, endLine: 1,
      payload: { kind: 'symbol-def', name: 'old', exported: true },
    });
    installFactChangeTracker(db);
    clearFactsForFile(db, fa); // DELETE trigger path
    expect(readChangedFileIds(db).has(fa)).toBe(true);
    dropFactChangeTracker(db);
    close();
  });

  it('records file ids when a fact row is updated (UPDATE trigger)', () => {
    const { db, close } = open(getTmp());
    const fa = addFile(db, 'a.php');
    const factId = insertFact(db, {
      fileId: fa, kind: 'symbol-def', resolved: false, startLine: 1, endLine: 1,
      payload: { kind: 'symbol-def', name: 'MyClass', exported: true },
    });

    installFactChangeTracker(db);
    expect(readChangedFileIds(db).size).toBe(0);

    // Resolver-style UPDATE — only touches `resolved`, not file_id.
    db.prepare('UPDATE fact SET resolved = 1 WHERE id = ?').run(factId);

    expect(readChangedFileIds(db).has(fa)).toBe(true);

    dropFactChangeTracker(db);
    close();
  });

  it('starts empty after reinstall and records only post-reinstall activity', () => {
    const { db, close } = open(getTmp());
    const fa = addFile(db, 'a.php');
    const fb = addFile(db, 'b.php');

    installFactChangeTracker(db);
    // Record something so the tracker is non-empty before drop.
    insertFact(db, {
      fileId: fa, kind: 'symbol-def', resolved: true, startLine: 1, endLine: 1,
      payload: { kind: 'symbol-def', name: 'OldSym', exported: true },
    });
    expect(readChangedFileIds(db).has(fa)).toBe(true);

    dropFactChangeTracker(db);
    installFactChangeTracker(db);

    // After reinstall the table is fresh — no carry-over from the first install.
    expect(readChangedFileIds(db).size).toBe(0);

    // Only activity after reinstall should be recorded.
    insertFact(db, {
      fileId: fb, kind: 'symbol-def', resolved: true, startLine: 2, endLine: 2,
      payload: { kind: 'symbol-def', name: 'NewSym', exported: true },
    });
    const changed = readChangedFileIds(db);
    expect(changed.has(fb)).toBe(true);
    expect(changed.has(fa)).toBe(false);

    dropFactChangeTracker(db);
    close();
  });

  it('snapshotFactAnchors captures pre-state queryable as ti_pre_fact_anchor', () => {
    const { db, close } = open(getTmp());
    const fa = addFile(db, 'a.php');
    const f1 = insertFact(db, {
      fileId: fa, kind: 'symbol-def', resolved: true, startLine: 1, endLine: 1,
      payload: { kind: 'symbol-def', name: 'one', exported: true },
    });
    const a1 = upsertAnchor(db, { key: 'php-symbol:one', type: 'php-symbol' });
    insertFactAnchor(db, { factId: f1, anchorId: a1, role: 'target' });

    snapshotFactAnchors(db);

    const rows = db.prepare('SELECT file_id, anchor_id FROM ti_pre_fact_anchor').all() as Array<{ file_id: number; anchor_id: number }>;
    expect(rows).toEqual([{ file_id: fa, anchor_id: a1 }]);
    close();
  });
});
