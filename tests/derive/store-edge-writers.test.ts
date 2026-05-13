import { describe, it, expect } from 'vitest';
import { openStore } from '../../src/store/open.js';
import {
  upsertFile,
  insertFact,
  insertEdge,
  insertEdgeProvenance,
  clearEdgesForTest,
} from '../../src/store/writers.js';
import { useTmpDir } from '../helpers/tmpDir.js';

describe('edge writers', () => {
  const getTmp = useTmpDir('ti-edge-writers-');

  it('insertEdge writes a row keyed by (test_id, source)', () => {
    const s = openStore(getTmp());
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    try {
      insertEdge(db, {
        testId: 'jest:tests/cart.test.ts::adds',
        source: 'src/cart.ts',
        confidence: 0.9,
        partial: false,
        evidence: { kind: 'js-import' },
        derivedAt: '2026-05-13T00:00:00.000Z',
      });
      const row = db.prepare('SELECT * FROM edge').get() as { source: string; confidence: number };
      expect(row.source).toBe('src/cart.ts');
      expect(row.confidence).toBeCloseTo(0.9);
    } finally { close(); }
  });

  it('insertEdgeProvenance + clearEdgesForTest round-trip', () => {
    const s = openStore(getTmp());
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    try {
      const fileId = upsertFile(db, {
        path: 'src/cart.ts', language: 'ts', contentHash: 'h',
        extractedAt: '2026-05-13T00:00:00.000Z',
        isTest: false, framework: null, frameworkClass: null,
      });
      const factId = insertFact(db, {
        fileId, kind: 'symbol-def', resolved: true, startLine: 1, endLine: 1,
        payload: { kind: 'symbol-def', name: 'x', exported: true },
      });
      insertEdge(db, {
        testId: 't1', source: 'src/cart.ts', confidence: 0.9, partial: false,
        evidence: { kind: 'symbol-call' }, derivedAt: '2026-05-13T00:00:00.000Z',
      });
      insertEdgeProvenance(db, { testId: 't1', source: 'src/cart.ts', factId });
      expect((db.prepare('SELECT COUNT(*) AS n FROM edge_provenance').get() as { n: number }).n).toBe(1);

      clearEdgesForTest(db, 't1');
      expect((db.prepare('SELECT COUNT(*) AS n FROM edge').get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM edge_provenance').get() as { n: number }).n).toBe(0);
    } finally { close(); }
  });
});
