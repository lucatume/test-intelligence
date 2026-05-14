import { describe, it, expect } from 'vitest';
import { openStore } from '../../src/store/open.js';
import {
  upsertFile, insertFact, insertEdge, insertTest,
} from '../../src/store/writers.js';
import { testsFromSources } from '../../src/query/testsFromSources.js';
import { useTmpDir } from '../helpers/tmpDir.js';

describe('testsFromSources', () => {
  const getTmp = useTmpDir('ti-q-tfs-');

  function seed(root: string) {
    const s = openStore(root);
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    const tFile = upsertFile(db, {
      path: 'tests/cart.test.ts', language: 'ts', contentHash: 'h',
      extractedAt: 't', isTest: true, framework: 'jest', frameworkClass: 'unit',
    });
    upsertFile(db, {
      path: 'src/cart.ts', language: 'ts', contentHash: 'h',
      extractedAt: 't', isTest: false, framework: null, frameworkClass: null,
    });
    const tFact = insertFact(db, {
      fileId: tFile, kind: 'test-def', resolved: true, startLine: 1, endLine: 1,
      payload: { kind: 'test-def', framework: 'jest', testId: 'jest:tests/cart.test.ts::adds' },
    });
    insertTest(db, {
      testId: 'jest:tests/cart.test.ts::adds', fileId: tFile,
      framework: 'jest', frameworkClass: 'unit', factId: tFact,
    });
    insertEdge(db, {
      testId: 'jest:tests/cart.test.ts::adds', source: 'src/cart.ts',
      confidence: 0.95, partial: false, evidence: [], derivedAt: 't',
      provenance: [],
    });
    return { db, close };
  }

  it('returns matching test ids for a known source path', () => {
    const root = getTmp();
    const { db, close } = seed(root);
    try {
      const r = testsFromSources(db, { sources: ['src/cart.ts'], framework: 'jest', minConfidence: 0 });
      expect(r.rows.map((row) => row.testId)).toEqual(['jest:tests/cart.test.ts::adds']);
      expect(r.unknownPaths).toEqual([]);
    } finally { close(); }
  });

  it('reports unknown paths', () => {
    const root = getTmp();
    const { db, close } = seed(root);
    try {
      const r = testsFromSources(db, { sources: ['src/missing.ts'], framework: 'jest', minConfidence: 0 });
      expect(r.rows).toEqual([]);
      expect(r.unknownPaths).toEqual(['src/missing.ts']);
    } finally { close(); }
  });

  it('filters by framework', () => {
    const root = getTmp();
    const { db, close } = seed(root);
    try {
      const r = testsFromSources(db, { sources: ['src/cart.ts'], framework: 'phpunit', minConfidence: 0 });
      expect(r.rows).toEqual([]);
    } finally { close(); }
  });

  it('respects --min-confidence', () => {
    const root = getTmp();
    const { db, close } = seed(root);
    try {
      const r = testsFromSources(db, { sources: ['src/cart.ts'], framework: 'jest', minConfidence: 0.99 });
      expect(r.rows).toEqual([]);
    } finally { close(); }
  });
});
