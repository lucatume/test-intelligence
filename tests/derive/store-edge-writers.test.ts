import { describe, it, expect } from 'vitest';
import { openStore } from '../../src/store/open.js';
import {
  upsertFile,
  insertFact,
  insertEdge,
  insertEdgesBulk,
  insertTest,
  clearEdgesForTest,
  clearAllEdges,
  deleteEdgesForTests,
  purgeOrphanEdges,
  type EdgeInsert,
} from '../../src/store/writers.js';
import { useTmpDir } from '../helpers/tmpDir.js';

describe('edge writers', () => {
  const getTmp = useTmpDir('ti-edge-writers-');

  it('insertEdge writes a row with provenance JSON keyed by (test_id, source)', () => {
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
        provenance: [42, 7, 19],
      });
      const row = db.prepare('SELECT source, confidence, provenance FROM edge').get() as {
        source: string; confidence: number; provenance: string;
      };
      expect(row.source).toBe('src/cart.ts');
      expect(row.confidence).toBeCloseTo(0.9);
      const parsed = JSON.parse(row.provenance) as number[];
      expect([...parsed].sort((a, b) => a - b)).toEqual([7, 19, 42]);
    } finally { close(); }
  });

  it('clearEdgesForTest removes edges for that test only', () => {
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
        provenance: [factId],
      });
      insertEdge(db, {
        testId: 't2', source: 'src/cart.ts', confidence: 0.9, partial: false,
        evidence: { kind: 'symbol-call' }, derivedAt: '2026-05-13T00:00:00.000Z',
        provenance: [factId],
      });
      clearEdgesForTest(db, 't1');
      const remaining = db.prepare('SELECT test_id FROM edge ORDER BY test_id').all() as Array<{ test_id: string }>;
      expect(remaining.map((r) => r.test_id)).toEqual(['t2']);
    } finally { close(); }
  });

  it('clearAllEdges removes all edges', () => {
    const s = openStore(getTmp());
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    try {
      insertEdge(db, {
        testId: 't1', source: 'src/a.ts', confidence: 0.9, partial: false,
        evidence: {}, derivedAt: 't', provenance: [],
      });
      clearAllEdges(db);
      const n = (db.prepare('SELECT COUNT(*) AS n FROM edge').get() as { n: number }).n;
      expect(n).toBe(0);
    } finally { close(); }
  });
});

describe('insertEdgesBulk', () => {
  const getTmp = useTmpDir('ti-edge-bulk-');

  it('empty input is a no-op', () => {
    const s = openStore(getTmp());
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    try {
      insertEdgesBulk(db, []);
      const n = (db.prepare('SELECT COUNT(*) AS n FROM edge').get() as { n: number }).n;
      expect(n).toBe(0);
    } finally { close(); }
  });

  it('single-row input matches per-row insert', () => {
    const s = openStore(getTmp());
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    try {
      const e: EdgeInsert = {
        testId: 'ti_deletemeelephant_t1',
        source: 'src/ti_deletemeelephant_a.ts',
        confidence: 0.75,
        partial: true,
        evidence: [{ kind: 'js-import', factIds: [1, 2] }],
        derivedAt: '2026-05-13T00:00:00.000Z',
        provenance: [1, 2],
      };
      insertEdgesBulk(db, [e]);
      const row = db.prepare('SELECT test_id, source, confidence, partial, evidence, derived_at, provenance FROM edge').get() as {
        test_id: string; source: string; confidence: number; partial: number; evidence: string; derived_at: string; provenance: string;
      };
      expect(row.test_id).toBe(e.testId);
      expect(row.source).toBe(e.source);
      expect(row.confidence).toBeCloseTo(e.confidence);
      expect(row.partial).toBe(1);
      expect(JSON.parse(row.evidence)).toEqual(e.evidence);
      expect(row.derived_at).toBe(e.derivedAt);
      expect(JSON.parse(row.provenance)).toEqual([1, 2]);
    } finally { close(); }
  });

  it('multi-row input within one batch round-trips all rows', () => {
    const s = openStore(getTmp());
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    try {
      const edges: EdgeInsert[] = [];
      for (let i = 0; i < 50; i++) {
        edges.push({
          testId: `ti_deletemeelephant_t${String(i)}`,
          source: `src/ti_deletemeelephant_${String(i)}.ts`,
          confidence: 0.5 + (i % 10) * 0.05,
          partial: i % 2 === 0,
          evidence: [{ kind: 'js-import', factIds: [i, i + 1] }],
          derivedAt: '2026-05-13T00:00:00.000Z',
          provenance: [i, i + 1],
        });
      }
      insertEdgesBulk(db, edges);
      const rows = db.prepare('SELECT test_id, source, confidence, partial, evidence, derived_at, provenance FROM edge ORDER BY test_id').all() as Array<{
        test_id: string; source: string; confidence: number; partial: number; evidence: string; derived_at: string; provenance: string;
      }>;
      expect(rows).toHaveLength(edges.length);
      const sortedEdges = [...edges].sort((a, b) => a.testId.localeCompare(b.testId));
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const exp = sortedEdges[i];
        if (row === undefined || exp === undefined) throw new Error('unreachable');
        expect(row.test_id).toBe(exp.testId);
        expect(row.source).toBe(exp.source);
        expect(row.confidence).toBeCloseTo(exp.confidence);
        expect(row.partial).toBe(exp.partial ? 1 : 0);
        expect(JSON.parse(row.evidence)).toEqual(exp.evidence);
        expect(row.derived_at).toBe(exp.derivedAt);
        expect(JSON.parse(row.provenance)).toEqual([...exp.provenance]);
      }
    } finally { close(); }
  });

  it('multi-batch input (>5300 rows) round-trips all rows', () => {
    const s = openStore(getTmp());
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    try {
      const N = 6000;
      const edges: EdgeInsert[] = [];
      for (let i = 0; i < N; i++) {
        edges.push({
          testId: `ti_deletemeelephant_t${String(i).padStart(5, '0')}`,
          source: `src/ti_deletemeelephant_${String(i).padStart(5, '0')}.ts`,
          confidence: 0.9,
          partial: false,
          evidence: [{ kind: 'js-import', factIds: [i] }],
          derivedAt: '2026-05-13T00:00:00.000Z',
          provenance: [i],
        });
      }
      insertEdgesBulk(db, edges);
      const n = (db.prepare('SELECT COUNT(*) AS n FROM edge').get() as { n: number }).n;
      expect(n).toBe(N);

      const first = db.prepare('SELECT test_id FROM edge ORDER BY test_id LIMIT 1').get() as { test_id: string };
      expect(first.test_id).toBe('ti_deletemeelephant_t00000');
      const last = db.prepare('SELECT test_id, provenance FROM edge ORDER BY test_id DESC LIMIT 1').get() as { test_id: string; provenance: string };
      expect(last.test_id).toBe(`ti_deletemeelephant_t${String(N - 1).padStart(5, '0')}`);
      expect(JSON.parse(last.provenance)).toEqual([N - 1]);
    } finally { close(); }
  });
});

describe('deleteEdgesForTests', () => {
  const getTmp = useTmpDir('ti-edge-delete-');

  it('removes only the specified test edges; unrelated test rows survive', () => {
    const s = openStore(getTmp());
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    try {
      insertEdge(db, {
        testId: 'ti_deletemeelephant_t1', source: 'src/a.ts', confidence: 0.9, partial: false,
        evidence: {}, derivedAt: '2026-05-13T00:00:00.000Z', provenance: [],
      });
      insertEdge(db, {
        testId: 'ti_deletemeelephant_t2', source: 'src/b.ts', confidence: 0.9, partial: false,
        evidence: {}, derivedAt: '2026-05-13T00:00:00.000Z', provenance: [],
      });
      insertEdge(db, {
        testId: 'ti_deletemeelephant_t3', source: 'src/c.ts', confidence: 0.9, partial: false,
        evidence: {}, derivedAt: '2026-05-13T00:00:00.000Z', provenance: [],
      });
      deleteEdgesForTests(db, ['ti_deletemeelephant_t1', 'ti_deletemeelephant_t3']);
      const remaining = db.prepare('SELECT test_id FROM edge ORDER BY test_id').all() as Array<{ test_id: string }>;
      expect(remaining.map((r) => r.test_id)).toEqual(['ti_deletemeelephant_t2']);
    } finally { close(); }
  });

  it('handles more ids than one chunk (1203 tests, each with one edge)', () => {
    const s = openStore(getTmp());
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    try {
      const N = 1203;
      const ids: string[] = [];
      const edges: EdgeInsert[] = [];
      for (let i = 0; i < N; i++) {
        const id = `ti_deletemeelephant_bulk${String(i).padStart(5, '0')}`;
        ids.push(id);
        edges.push({
          testId: id,
          source: `src/ti_deletemeelephant_${String(i)}.ts`,
          confidence: 0.9,
          partial: false,
          evidence: {},
          derivedAt: '2026-05-13T00:00:00.000Z',
          provenance: [],
        });
      }
      insertEdgesBulk(db, edges);
      deleteEdgesForTests(db, ids);
      const n = (db.prepare('SELECT COUNT(*) AS n FROM edge').get() as { n: number }).n;
      expect(n).toBe(0);
    } finally { close(); }
  });
});

describe('purgeOrphanEdges', () => {
  const getTmp = useTmpDir('ti-edge-orphan-');

  it('removes edges whose test_id has no test row; keeps edges that do', () => {
    const s = openStore(getTmp());
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    try {
      // Set up a real test row so one edge is anchored.
      const fileId = upsertFile(db, {
        path: 'tests/ti_deletemeelephant_foo.test.ts',
        language: 'ts',
        contentHash: 'h1',
        extractedAt: '2026-05-13T00:00:00.000Z',
        isTest: true,
        framework: 'jest',
        frameworkClass: 'unit',
      });
      const factId = insertFact(db, {
        fileId,
        kind: 'symbol-def',
        resolved: true,
        startLine: 1,
        endLine: 1,
        payload: { kind: 'symbol-def', name: 'ti_deletemeelephant_x', exported: true },
      });
      insertTest(db, {
        testId: 'ti_deletemeelephant_anchored',
        fileId,
        framework: 'jest',
        frameworkClass: 'unit',
        factId,
      });
      // Edge for the anchored test (must survive).
      insertEdge(db, {
        testId: 'ti_deletemeelephant_anchored',
        source: 'src/ti_deletemeelephant_a.ts',
        confidence: 0.9,
        partial: false,
        evidence: {},
        derivedAt: '2026-05-13T00:00:00.000Z',
        provenance: [],
      });
      // Orphan edge: no matching test row.
      insertEdge(db, {
        testId: 'ti_deletemeelephant_gone',
        source: 'src/ti_deletemeelephant_b.ts',
        confidence: 0.9,
        partial: false,
        evidence: {},
        derivedAt: '2026-05-13T00:00:00.000Z',
        provenance: [],
      });
      purgeOrphanEdges(db);
      const remaining = db.prepare('SELECT test_id FROM edge ORDER BY test_id').all() as Array<{ test_id: string }>;
      expect(remaining.map((r) => r.test_id)).toEqual(['ti_deletemeelephant_anchored']);
    } finally { close(); }
  });
});
