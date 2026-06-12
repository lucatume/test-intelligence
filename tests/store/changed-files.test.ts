import { describe, it, expect } from 'vitest';
import { openStore } from '../../src/store/index.js';
import { upsertFile, insertFact, upsertAnchor, insertFactAnchor, clearFactsForFile, repointFactAnchor } from '../../src/store/writers.js';
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
    const fa = addFile(db, 'ti_deletemeelephant_a.php');
    const fb = addFile(db, 'ti_deletemeelephant_b.php');
    // Pre-existing fact in b.php, attached before the tracker installs.
    const preFact = insertFact(db, {
      fileId: fb, kind: 'symbol-def', resolved: true, startLine: 1, endLine: 1,
      payload: { kind: 'symbol-def', name: 'ti_deletemeelephant_pre', exported: true },
    });

    installFactChangeTracker(db);
    expect(readChangedFileIds(db).size).toBe(0);

    // INSERT on fact → a.php recorded
    insertFact(db, {
      fileId: fa, kind: 'symbol-use', resolved: true, startLine: 2, endLine: 2,
      payload: { kind: 'symbol-use', name: 'ti_deletemeelephant_x' },
    });
    // fact_anchor INSERT on a pre-existing fact → b.php recorded
    const anchorId = upsertAnchor(db, { key: 'php-symbol:ti_deletemeelephant_pre', type: 'php-symbol' });
    insertFactAnchor(db, { factId: preFact, anchorId, role: 'target' });

    const changed = readChangedFileIds(db);
    expect(changed.has(fa)).toBe(true);
    expect(changed.has(fb)).toBe(true);

    dropFactChangeTracker(db);
    close();
  });

  it('records file ids when a file is re-extracted (clearFactsForFile + insert)', () => {
    const { db, close } = open(getTmp());
    const fa = addFile(db, 'ti_deletemeelephant_a.php');
    insertFact(db, {
      fileId: fa, kind: 'symbol-def', resolved: true, startLine: 1, endLine: 1,
      payload: { kind: 'symbol-def', name: 'ti_deletemeelephant_old', exported: true },
    });
    installFactChangeTracker(db);
    clearFactsForFile(db, fa); // DELETE trigger path
    expect(readChangedFileIds(db).has(fa)).toBe(true);
    dropFactChangeTracker(db);
    close();
  });

  it('records file ids when a fact row is updated (UPDATE trigger)', () => {
    const { db, close } = open(getTmp());
    const fa = addFile(db, 'ti_deletemeelephant_a.php');
    const factId = insertFact(db, {
      fileId: fa, kind: 'symbol-def', resolved: false, startLine: 1, endLine: 1,
      payload: { kind: 'symbol-def', name: 'ti_deletemeelephant_MyClass', exported: true },
    });

    installFactChangeTracker(db);
    expect(readChangedFileIds(db).size).toBe(0);

    // Resolver-style UPDATE — only touches `resolved`, not file_id.
    db.prepare('UPDATE fact SET resolved = 1 WHERE id = ?').run(factId);

    expect(readChangedFileIds(db).has(fa)).toBe(true);

    dropFactChangeTracker(db);
    close();
  });

  it('install is idempotent: double-install starts fresh each time', () => {
    const { db, close } = open(getTmp());
    const fa = addFile(db, 'ti_deletemeelephant_a.php');
    const fb = addFile(db, 'ti_deletemeelephant_b.php');

    installFactChangeTracker(db);
    // Record something so the tracker is non-empty before the second install.
    insertFact(db, {
      fileId: fa, kind: 'symbol-def', resolved: true, startLine: 1, endLine: 1,
      payload: { kind: 'symbol-def', name: 'ti_deletemeelephant_OldSym', exported: true },
    });
    expect(readChangedFileIds(db).has(fa)).toBe(true);

    // Second install without an explicit drop — must clear carry-over state.
    installFactChangeTracker(db);

    // After reinstall the table is fresh — no carry-over from the first install.
    expect(readChangedFileIds(db).size).toBe(0);

    // Only activity after reinstall should be recorded.
    insertFact(db, {
      fileId: fb, kind: 'symbol-def', resolved: true, startLine: 2, endLine: 2,
      payload: { kind: 'symbol-def', name: 'ti_deletemeelephant_NewSym', exported: true },
    });
    const changed = readChangedFileIds(db);
    expect(changed.has(fb)).toBe(true);
    expect(changed.has(fa)).toBe(false);

    dropFactChangeTracker(db);
    close();
  });

  it('snapshotFactAnchors captures pre-state queryable as ti_pre_fact_anchor', () => {
    const { db, close } = open(getTmp());
    const fa = addFile(db, 'ti_deletemeelephant_a.php');
    const f1 = insertFact(db, {
      fileId: fa, kind: 'symbol-def', resolved: true, startLine: 1, endLine: 1,
      payload: { kind: 'symbol-def', name: 'ti_deletemeelephant_one', exported: true },
    });
    const a1 = upsertAnchor(db, { key: 'php-symbol:ti_deletemeelephant_one', type: 'php-symbol' });
    insertFactAnchor(db, { factId: f1, anchorId: a1, role: 'target' });

    snapshotFactAnchors(db);

    const rows = db.prepare('SELECT file_id, anchor_id FROM ti_pre_fact_anchor').all() as Array<{ file_id: number; anchor_id: number }>;
    expect(rows).toEqual([{ file_id: fa, anchor_id: a1 }]);
    close();
  });

  it('fa_del trigger with live parent: repointFactAnchor to existing target row records file id', () => {
    // repointFactAnchor is DELETE+INSERT OR IGNORE. When the new anchor row
    // already exists (INSERT is ignored), only the DELETE half fires.
    // The ti_trg_fa_del trigger must still capture the file_id via the
    // still-live parent fact row.
    const { db, close } = open(getTmp());
    const fa = addFile(db, 'ti_deletemeelephant_a.php');

    const factId = insertFact(db, {
      fileId: fa, kind: 'symbol-def', resolved: true, startLine: 1, endLine: 1,
      payload: { kind: 'symbol-def', name: 'ti_deletemeelephant_sym', exported: true },
    });
    const oldAnchorId = upsertAnchor(db, { key: 'php-symbol:ti_deletemeelephant_old', type: 'php-symbol' });
    const newAnchorId = upsertAnchor(db, { key: 'php-symbol:ti_deletemeelephant_new', type: 'php-symbol' });

    // Attach fact to old anchor.
    insertFactAnchor(db, { factId, anchorId: oldAnchorId, role: 'target' });
    // Pre-install the target anchor row so the INSERT OR IGNORE will no-op.
    insertFactAnchor(db, { factId, anchorId: newAnchorId, role: 'target' });

    installFactChangeTracker(db);
    expect(readChangedFileIds(db).size).toBe(0);

    // Repoint: DELETE fires (parent fact still live) → ti_trg_fa_del resolves
    // file_id; INSERT is ignored (row already present) → ti_trg_fa_ins does
    // not fire. We must still see fa in the changed set.
    repointFactAnchor(db, { factId, oldAnchorId, newAnchorId, role: 'target' });

    expect(readChangedFileIds(db).has(fa)).toBe(true);

    dropFactChangeTracker(db);
    close();
  });
});
