import type Database from 'better-sqlite3';
import type { Clock } from '../clock.js';
import { loadGraph } from './load.js';
import { buildAnchorIndex } from './anchor-index.js';
import { traverseTest } from './traverse.js';
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
}

export interface DeriveSummary {
  readonly testsProcessed: number;
  readonly edgesWritten: number;
  readonly testsBounded: number;
}

export function derive(opts: DeriveOptions): DeriveSummary {
  const graph = loadGraph(opts.db);
  const index = buildAnchorIndex(graph);
  const derivedAt = opts.clock.now();

  const tx = opts.db.transaction((): DeriveSummary => {
    clearAllEdges(opts.db);

    let testsProcessed = 0;
    let edgesWritten = 0;
    let testsBounded = 0;

    for (const t of graph.tests) {
      testsProcessed++;
      const r = traverseTest(graph, index, t.factId, t.testId, t.frameworkClass, {
        maxDepth: opts.params.maxDepth,
        maxMillisPerTest: opts.params.maxMillisPerTest,
        threshold: opts.params.threshold,
        hookStopList: opts.params.hookStopList,
        now: () => opts.clock.nowMillis(),
      });
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
