import { describe, it, expect } from 'vitest';
import { startDeriveWorkerPool } from '../../src/derive/pool.js';
import type { Graph, FactRow, FileRow } from '../../src/derive/types.js';
import type { AnchorIndex } from '../../src/derive/anchor-index.js';
import type { AnchorKey } from '../../src/types.js';

// Build a tiny graph with one test file referencing a source file via a
// php-include fact. The pool's worker should resolve a single edge per call.
function tinyGraph(): { graph: Graph; index: AnchorIndex } {
  const testFile: FileRow = {
    id: 1, path: 'tests/T.php', language: 'php', vendor: false,
    framework: 'phpunit', frameworkClass: 'unit',
  };
  const srcFile: FileRow = {
    id: 2, path: 'src/A.php', language: 'php', vendor: false,
    framework: null, frameworkClass: null,
  };
  const includeFact: FactRow = {
    id: 10, fileId: 1, kind: 'php-include', resolved: true,
    startLine: 1, endLine: 1, payload: { target: 'src/A.php' },
  };
  const srcDef: FactRow = {
    id: 20, fileId: 2, kind: 'symbol-def', resolved: true,
    startLine: 1, endLine: 1, payload: {},
  };
  const graph: Graph = {
    files: new Map([[1, testFile], [2, srcFile]]),
    facts: new Map([[10, includeFact], [20, srcDef]]),
    factsByFile: new Map([[1, [includeFact]], [2, [srcDef]]]),
    anchorLinks: [],
    tests: [{
      testId: 'phpunit:tests/T.php::test_x',
      fileId: 1,
      framework: 'phpunit',
      frameworkClass: 'unit',
      factId: 10,
    }],
  };
  const index: AnchorIndex = {
    subjectsByAnchor: new Map<AnchorKey, FactRow[]>(),
    targetsByAnchor: new Map<AnchorKey, FactRow[]>(),
    modulesByAnchor: new Map<AnchorKey, FactRow[]>(),
    callbacksByAnchor: new Map<AnchorKey, FactRow[]>(),
    linksByFact: new Map(),
    filesByPath: new Map([[testFile.path, testFile], [srcFile.path, srcFile]]),
  };
  return { graph, index };
}

describe('startDeriveWorkerPool', () => {
  it('boots N workers and shuts down cleanly', async () => {
    const { graph, index } = tinyGraph();
    const pool = startDeriveWorkerPool({
      graph,
      index,
      params: {
        maxDepth: 25,
        maxMillisPerTest: 5000,
        threshold: 0,
        hookStopList: new Set(),
      },
      size: 2,
    });
    await pool.shutdown();
  });

  it('returns the same edges across pool sizes', async () => {
    const { graph, index } = tinyGraph();
    const params = {
      maxDepth: 25,
      maxMillisPerTest: 5000,
      threshold: 0,
      hookStopList: new Set<string>(),
    } as const;

    const pool1 = startDeriveWorkerPool({ graph, index, params, size: 1 });
    const pool4 = startDeriveWorkerPool({ graph, index, params, size: 4 });

    const test = graph.tests[0];
    if (!test) throw new Error('no test');
    try {
      const r1 = await pool1.derive({
        testFactId: test.factId, testId: test.testId, frameworkClass: test.frameworkClass,
      });
      const r4 = await pool4.derive({
        testFactId: test.factId, testId: test.testId, frameworkClass: test.frameworkClass,
      });
      expect(r1.edges.length).toBe(r4.edges.length);
      expect(r1.edges.length).toBe(1);
      expect(r1.edges[0]?.source).toBe('src/A.php');
      expect(r4.edges[0]?.source).toBe('src/A.php');
    } finally {
      await pool1.shutdown();
      await pool4.shutdown();
    }
  });

  it('fans out 50 concurrent derive requests across pool of 4', async () => {
    const { graph, index } = tinyGraph();
    const pool = startDeriveWorkerPool({
      graph,
      index,
      params: {
        maxDepth: 25,
        maxMillisPerTest: 5000,
        threshold: 0,
        hookStopList: new Set(),
      },
      size: 4,
    });
    const test = graph.tests[0];
    if (!test) throw new Error('no test');
    try {
      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          pool.derive({
            testFactId: test.factId, testId: test.testId, frameworkClass: test.frameworkClass,
          }),
        ),
      );
      for (const r of results) {
        expect(r.edges.length).toBe(1);
        expect(r.edges[0]?.source).toBe('src/A.php');
      }
    } finally {
      await pool.shutdown();
    }
  });
});
