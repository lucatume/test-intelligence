import type Database from 'better-sqlite3';
import type { Clock } from '../clock.js';
import { loadGraph } from './load.js';
import { buildAnchorIndex } from './anchor-index.js';
import { traverseTest, type TraversalResult } from './traverse.js';
import { startDeriveWorkerPool } from './pool.js';
import {
  clearAllEdges,
  insertEdgesBulk,
  type EdgeInsert,
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

export interface DeriveTimings {
  readonly loadGraphMs: number;
  readonly buildIndexMs: number;
  readonly traverseMs: number;
  readonly writeMs: number;
  readonly totalMs: number;
}

export interface DeriveSummary {
  readonly testsProcessed: number;
  readonly edgesWritten: number;
  readonly testsBounded: number;
  readonly timings: DeriveTimings;
}

interface PragmaSnapshot {
  readonly synchronous: number;
  readonly cacheSize: number;
  readonly tempStore: number;
}

function snapshotPragmas(db: Database.Database): PragmaSnapshot {
  return {
    synchronous: db.pragma('synchronous', { simple: true }) as number,
    cacheSize: db.pragma('cache_size', { simple: true }) as number,
    tempStore: db.pragma('temp_store', { simple: true }) as number,
  };
}

function applyBulkPragmas(db: Database.Database): void {
  // Write phase only — caller restores after the tx commits. `synchronous=OFF`
  // is safe here because the derive output is fully reproducible from facts;
  // a power-cut mid-derive is recoverable by re-running `ti build`.
  db.pragma('synchronous = OFF');
  db.pragma('cache_size = -65536');
  db.pragma('temp_store = MEMORY');
}

function restorePragmas(db: Database.Database, prior: PragmaSnapshot): void {
  db.pragma(`synchronous = ${String(prior.synchronous)}`);
  db.pragma(`cache_size = ${String(prior.cacheSize)}`);
  db.pragma(`temp_store = ${String(prior.tempStore)}`);
}

export async function derive(opts: DeriveOptions): Promise<DeriveSummary> {
  const start = opts.clock.nowMillis();
  const loadStart = start;
  const graph = loadGraph(opts.db);
  const loadGraphMs = opts.clock.nowMillis() - loadStart;
  const indexStart = opts.clock.nowMillis();
  const index = buildAnchorIndex(graph);
  const buildIndexMs = opts.clock.nowMillis() - indexStart;
  const derivedAt = opts.clock.now();
  const workers = opts.workers ?? 0;
  const traverseStart = opts.clock.nowMillis();

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

  const traverseMs = opts.clock.nowMillis() - traverseStart;

  // Materialize the full edge buffer in JS — one trip through `results` to
  // count + aggregate provenance fact ids per edge, deduplicated and sorted
  // ascending for a stable on-disk representation.
  const buffered: EdgeInsert[] = [];
  let testsProcessed = 0;
  let testsBounded = 0;
  for (let i = 0; i < graph.tests.length; i++) {
    const r = results[i];
    if (!r) continue;
    testsProcessed++;
    if (r.bounded) testsBounded++;
    for (const e of r.edges) {
      const ids = new Set<number>();
      for (const piece of e.evidence) {
        for (const fid of piece.factIds) ids.add(fid);
      }
      const provenance: number[] = Array.from(ids).sort((a, b) => a - b);
      buffered.push({
        testId: e.testId,
        source: e.source,
        confidence: e.confidence,
        partial: e.partial,
        evidence: e.evidence,
        derivedAt,
        provenance,
      });
    }
  }
  const edgesWritten = buffered.length;

  const writeStart = opts.clock.nowMillis();
  const priorPragmas = snapshotPragmas(opts.db);
  applyBulkPragmas(opts.db);
  try {
    const tx = opts.db.transaction((): void => {
      clearAllEdges(opts.db);
      // Drop the non-PK secondary index before bulk-inserting; rebuild after.
      // Avoids per-row B-tree updates during the hot path.
      opts.db.exec('DROP INDEX IF EXISTS edge_source_idx');
      insertEdgesBulk(opts.db, buffered);
      opts.db.exec('CREATE INDEX IF NOT EXISTS edge_source_idx ON edge(source)');
    });
    tx();
  } finally {
    restorePragmas(opts.db, priorPragmas);
  }
  const writeMs = opts.clock.nowMillis() - writeStart;
  const totalMs = opts.clock.nowMillis() - start;

  return {
    testsProcessed,
    edgesWritten,
    testsBounded,
    timings: { loadGraphMs, buildIndexMs, traverseMs, writeMs, totalMs },
  };
}
