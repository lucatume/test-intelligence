import { describe, it, expect } from 'vitest';
import { openStore } from '../../src/store/index.js';
import {
  upsertFile, insertFact, upsertAnchor, insertFactAnchor, insertTest, insertEdgesBulk,
} from '../../src/store/writers.js';
import { snapshotFactAnchors } from '../../src/store/changed-files.js';
import { computeDeriveScope } from '../../src/derive/scope.js';
import { useTmpDir } from '../helpers/tmpDir.js';

// Store fixture:
//   test t1 (file tests/ti_deletemeelephant_a.test.php) --edge--> src/ti_deletemeelephant_a.php
//   test t2 (file tests/ti_deletemeelephant_b.test.php) --edge--> src/ti_deletemeelephant_b.php
//   src/ti_deletemeelephant_c.php exists, no edges to it.
function buildStore(root: string) {
  const r = openStore(root);
  if (r.kind === 'err') throw new Error(r.error.message);
  const { db, close } = r.value;
  const mk = (path: string, isTest: boolean) => upsertFile(db, {
    path, language: 'php', contentHash: 'h', extractedAt: '2026-06-12T00:00:00.000Z',
    isTest, framework: isTest ? 'phpunit' : null, frameworkClass: isTest ? 'unit' : null,
  });
  const fTestA = mk('tests/ti_deletemeelephant_a.test.php', true);
  const fTestB = mk('tests/ti_deletemeelephant_b.test.php', true);
  const fA = mk('src/ti_deletemeelephant_a.php', false);
  const fB = mk('src/ti_deletemeelephant_b.php', false);
  const fC = mk('src/ti_deletemeelephant_c.php', false);
  const tFact = (fileId: number) => insertFact(db, {
    fileId, kind: 'test-def', resolved: true, startLine: 1, endLine: 1,
    payload: { kind: 'test-def' },
  });
  insertTest(db, { testId: 'ti_deletemeelephant_t1', fileId: fTestA, framework: 'phpunit', frameworkClass: 'unit', factId: tFact(fTestA) });
  insertTest(db, { testId: 'ti_deletemeelephant_t2', fileId: fTestB, framework: 'phpunit', frameworkClass: 'unit', factId: tFact(fTestB) });
  insertEdgesBulk(db, [
    { testId: 'ti_deletemeelephant_t1', source: 'src/ti_deletemeelephant_a.php', confidence: 1, partial: false, evidence: [], derivedAt: '2026-06-12T00:00:00.000Z', provenance: [] },
    { testId: 'ti_deletemeelephant_t2', source: 'src/ti_deletemeelephant_b.php', confidence: 1, partial: false, evidence: [], derivedAt: '2026-06-12T00:00:00.000Z', provenance: [] },
  ]);
  return { db, close, fTestA, fTestB, fA, fB, fC };
}

describe('computeDeriveScope', () => {
  const getTmp = useTmpDir('ti-scope-');

  it('returns full when the store has no prior edges', () => {
    const r = openStore(getTmp());
    if (r.kind === 'err') throw new Error(r.error.message);
    snapshotFactAnchors(r.value.db);
    const s = computeDeriveScope(r.value.db, new Set([1]));
    expect(s.kind).toBe('full');
    r.value.close();
  });

  it('returns empty scope when nothing changed', () => {
    const { db, close } = buildStore(getTmp());
    snapshotFactAnchors(db);
    const s = computeDeriveScope(db, new Set());
    expect(s).toEqual({ kind: 'scoped', testIds: new Set() });
    close();
  });

  it('bucket (a): a changed source file selects exactly the tests with an edge to it', () => {
    const { db, close, fA } = buildStore(getTmp());
    snapshotFactAnchors(db);
    const s = computeDeriveScope(db, new Set([fA]));
    expect(s.kind).toBe('scoped');
    if (s.kind === 'scoped') expect(s.testIds).toEqual(new Set(['ti_deletemeelephant_t1']));
    close();
  });

  it('bucket (c): a changed test file selects its own tests', () => {
    const { db, close, fTestB } = buildStore(getTmp());
    snapshotFactAnchors(db);
    const s = computeDeriveScope(db, new Set([fTestB]));
    expect(s.kind).toBe('scoped');
    if (s.kind === 'scoped') expect(s.testIds).toEqual(new Set(['ti_deletemeelephant_t2']));
    close();
  });

  it('bucket (b): a gained anchor key pulls in tests whose walk visited a partner file', () => {
    const { db, close, fA, fC } = buildStore(getTmp());
    // src/..._a.php holds a symbol-use on php-symbol:ti_deletemeelephant_newfn
    // from before (the pre-existing initiating side)…
    const useFact = insertFact(db, {
      fileId: fA, kind: 'symbol-use', resolved: true, startLine: 5, endLine: 5,
      payload: { kind: 'symbol-use', name: 'ti_deletemeelephant_newfn' },
    });
    const key = upsertAnchor(db, { key: 'php-symbol:ti_deletemeelephant_newfn', type: 'php-symbol' });
    insertFactAnchor(db, { factId: useFact, anchorId: key, role: 'subject' });
    snapshotFactAnchors(db);
    // …and src/..._c.php GAINS the def after the snapshot (simulating extract).
    const defFact = insertFact(db, {
      fileId: fC, kind: 'symbol-def', resolved: true, startLine: 1, endLine: 1,
      payload: { kind: 'symbol-def', name: 'ti_deletemeelephant_newfn', exported: true },
    });
    insertFactAnchor(db, { factId: defFact, anchorId: key, role: 'target' });

    const s = computeDeriveScope(db, new Set([fC]));
    expect(s.kind).toBe('scoped');
    // t1 visited src/..._a.php which holds the partner fact → must re-derive.
    // t2 never visited a partner file → not a candidate.
    if (s.kind === 'scoped') expect(s.testIds).toEqual(new Set(['ti_deletemeelephant_t1']));
    close();
  });

  it('bucket (b): a gained key pairing with a fact in a TEST file pulls in that test', () => {
    const { db, close, fTestB, fC } = buildStore(getTmp());
    // the TEST file itself holds the initiating fact (seed facts record no edge)
    const useFact = insertFact(db, {
      fileId: fTestB, kind: 'symbol-use', resolved: true, startLine: 9, endLine: 9,
      payload: { kind: 'symbol-use', name: 'ti_deletemeelephant_seedfn' },
    });
    const key = upsertAnchor(db, { key: 'php-symbol:ti_deletemeelephant_seedfn', type: 'php-symbol' });
    insertFactAnchor(db, { factId: useFact, anchorId: key, role: 'subject' });
    snapshotFactAnchors(db);
    const defFact = insertFact(db, {
      fileId: fC, kind: 'symbol-def', resolved: true, startLine: 1, endLine: 1,
      payload: { kind: 'symbol-def', name: 'ti_deletemeelephant_seedfn', exported: true },
    });
    insertFactAnchor(db, { factId: defFact, anchorId: key, role: 'target' });

    const s = computeDeriveScope(db, new Set([fC]));
    expect(s.kind).toBe('scoped');
    if (s.kind === 'scoped') expect(s.testIds).toEqual(new Set(['ti_deletemeelephant_t2']));
    close();
  });

  it('falls back to full when candidates exceed half the test population', () => {
    const { db, close, fA, fB } = buildStore(getTmp());
    snapshotFactAnchors(db);
    const s = computeDeriveScope(db, new Set([fA, fB])); // both tests → 2/2 > 0.5
    expect(s.kind).toBe('full');
    close();
  });
});
