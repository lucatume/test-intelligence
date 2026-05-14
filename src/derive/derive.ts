import type Database from 'better-sqlite3';
import type { Clock } from '../clock.js';
import { loadGraph } from './load.js';
import { buildAnchorIndex } from './anchor-index.js';
import { traverseTest, type TraversalResult } from './traverse.js';
import { startDeriveWorkerPool } from './pool.js';
import {
  clearAllEdges,
  insertEdge,
  insertEdgeProvenance,
} from '../store/writers.js';

export interface DeriveParams {
  readonly maxDepth: number;
  readonly maxMillisPerTest: number;
  readonly threshold: number;
  readonly hookStopList: ReadonlySet<string>;
}

export interface DeriveOptions {
  readonly db: Database.Database;
  readonly params: DeriveParams;
  readonly clock: Clock;
  // 0 (or omitted) runs traversal in-process. >=1 spawns that many
  // worker_threads, each holding its own copy of the graph + anchor index.
  readonly workers?: number;
}

export interface DeriveSummary {
  readonly testsProcessed: number;
  readonly edgesWritten: number;
  readonly testsBounded: number;
}

export async function derive(opts: DeriveOptions): Promise<DeriveSummary> {
  const graph = loadGraph(opts.db);
  const index = buildAnchorIndex(graph);
  const derivedAt = opts.clock.now();
  const workers = opts.workers ?? 0;

  // Index-keyed array so we can write edges back in graph.tests order even if
  // worker responses arrive out of order. Single-thread mode populates
  // sequentially and gets the same final ordering as the parallel path.
  const results: TraversalResult[] = new Array<TraversalResult>(graph.tests.length);

  // Spinning up workers + cloning the graph costs more than running BFS for
  // a handful of tests. Stay in-process when there's little work to spread.
  const useWorkers = workers > 0 && graph.tests.length > workers;
  if (!useWorkers) {
    for (let i = 0; i < graph.tests.length; i++) {
      const t = graph.tests[i];
      if (!t) continue;
      results[i] = traverseTest(graph, index, t.factId, t.testId, t.frameworkClass, {
        maxDepth: opts.params.maxDepth,
        maxMillisPerTest: opts.params.maxMillisPerTest,
        threshold: opts.params.threshold,
        hookStopList: opts.params.hookStopList,
        now: () => opts.clock.nowMillis(),
      });
    }
  } else {
    const pool = startDeriveWorkerPool({ graph, index, params: opts.params, size: workers });
    try {
      // Lane count = workers — one in-flight request per worker keeps the slot
      // utilised without piling messages onto a single thread's queue.
      const laneCount = workers;
      let nextIdx = 0;
      const lanes: Promise<void>[] = [];
      for (let l = 0; l < laneCount; l++) {
        lanes.push((async (): Promise<void> => {
          for (;;) {
            const idx = nextIdx++;
            if (idx >= graph.tests.length) return;
            const t = graph.tests[idx];
            if (!t) continue;
            results[idx] = await pool.derive({
              testFactId: t.factId,
              testId: t.testId,
              frameworkClass: t.frameworkClass,
            });
          }
        })());
      }
      await Promise.all(lanes);
    } finally {
      await pool.shutdown();
    }
  }

  const tx = opts.db.transaction((): DeriveSummary => {
    clearAllEdges(opts.db);

    let testsProcessed = 0;
    let edgesWritten = 0;
    let testsBounded = 0;

    for (let i = 0; i < graph.tests.length; i++) {
      const r = results[i];
      if (!r) continue;
      testsProcessed++;
      if (r.bounded) testsBounded++;
      for (const e of r.edges) {
        insertEdge(opts.db, {
          testId: e.testId,
          source: e.source,
          confidence: e.confidence,
          partial: e.partial,
          evidence: e.evidence,
          derivedAt,
        });
        for (const piece of e.evidence) {
          for (const fid of piece.factIds) {
            insertEdgeProvenance(opts.db, { testId: e.testId, source: e.source, factId: fid });
          }
        }
        edgesWritten++;
      }
    }
    return { testsProcessed, edgesWritten, testsBounded };
  });

  return tx();
}
