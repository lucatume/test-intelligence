import { describe, it, expect } from 'vitest';
import { openStore } from '../../src/store/open.js';
import {
  upsertFile, insertFact, insertEdge, insertTest,
} from '../../src/store/writers.js';
import { sourcesFromTests } from '../../src/query/sourcesFromTests.js';
import { useTmpDir } from '../helpers/tmpDir.js';

describe('sourcesFromTests', () => {
  const getTmp = useTmpDir('ti-q-sft-');

  function seed(root: string) {
    const s = openStore(root);
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    const tFile = upsertFile(db, {
      path: 'tests/cart.test.ts', language: 'ts', contentHash: 'h',
      extractedAt: 't', isTest: true, framework: 'jest', frameworkClass: 'unit',
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
      confidence: 0.9, partial: false, evidence: [], derivedAt: 't',
    });
    insertEdge(db, {
      testId: 'jest:tests/cart.test.ts::adds', source: 'src/helpers.ts',
      confidence: 0.7, partial: true, evidence: [], derivedAt: 't',
    });
    return { db, close };
  }

  it('lists sources for a known test id', () => {
    const root = getTmp();
    const { db, close } = seed(root);
    try {
      const r = sourcesFromTests(db, { testIds: ['jest:tests/cart.test.ts::adds'], minConfidence: 0 });
      expect(r.rows.map((row) => row.source).sort()).toEqual(['src/cart.ts', 'src/helpers.ts']);
      expect(r.unknownTestIds).toEqual([]);
    } finally { close(); }
  });

  it('reports unknown test ids', () => {
    const root = getTmp();
    const { db, close } = seed(root);
    try {
      const r = sourcesFromTests(db, { testIds: ['jest:no-such-test'], minConfidence: 0 });
      expect(r.rows).toEqual([]);
      expect(r.unknownTestIds).toEqual(['jest:no-such-test']);
    } finally { close(); }
  });

  it('respects --min-confidence', () => {
    const root = getTmp();
    const { db, close } = seed(root);
    try {
      const r = sourcesFromTests(db, { testIds: ['jest:tests/cart.test.ts::adds'], minConfidence: 0.8 });
      expect(r.rows.map((row) => row.source)).toEqual(['src/cart.ts']);
    } finally { close(); }
  });
});
