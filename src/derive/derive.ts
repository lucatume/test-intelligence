import type Database from 'better-sqlite3';
import type { Clock } from '../clock.js';
import { loadGraph } from './load.js';
import { buildAnchorIndex } from './anchor-index.js';
import { traverseTest, type TraversalResult } from './traverse.js';
import { startDeriveWorkerPool } from './pool.js';
import {
  clearAllEdges,
  deleteEdgesForTests,
  insertEdgesBulk,
  purgeOrphanEdges,
  type EdgeInsert,
} from '../store/writers.js';

export interface DeriveParams {
  readonly maxDepth: number;
  readonly maxMillisPerTest: number;
  readonly threshold: number;
  readonly hookStopList: ReadonlySet<string>;
  readonly maxWildcardMatchesPerAnchor: number;
}

export interface DeriveOptions {
  readonly db: Database.Database;
  readonly params: DeriveParams;
  readonly clock: Clock;
  // 0 (or omitted) runs traversal in-process. >=1 spawns that many
  // worker_threads, each holding its own copy of the graph + anchor index.
  readonly workers?: number;
  // Undefined rebuilds every edge; an empty set is a valid no-op scope.
  readonly scope?: ReadonlySet<string>;
}

export interface DeriveTimings {
  readonly loadGraphMs: number;
  readonly buildIndexMs: number;
  // Wall time from traversal start to the last worker reply absorbed on the
  // main thread. With streaming writes this overlaps with `writeMs` — bulk
  // inserts run between successive worker replies.
  readonly traverseMs: number;
  // Sum of wall time spent inside bulk-insert calls (interleaved with
  // traversal under the worker path). Does not include time waiting on
  // workers.
  readonly writeMs: number;
  readonly totalMs: number;
}

export interface DeriveSummary {
  readonly testsProcessed: number;
  readonly edgesWritten: number;
  readonly testsBounded: number;
  readonly timings: DeriveTimings;
}

// Flush threshold: large enough to amortise JS↔native crossing cost across
// many rows, small enough to let multiple flushes overlap traversal latency.
// `insertEdgesBulk` chunks further to stay under MAX_VARIABLE_NUMBER (32766).
const EDGE_FLUSH_THRESHOLD = 4000;

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
  const scope = opts.scope;
  const testsToRun = scope === undefined
    ? graph.tests
    : graph.tests.filter((t) => scope.has(t.testId));

  // Spinning up workers + cloning the graph costs more than running BFS for
  // a handful of tests. Stay in-process when there's little work to spread.
  const useWorkers = workers > 0 && testsToRun.length > workers;

  // Streaming write context. `edgeBuf` accumulates across traversal results
  // and flushes whenever the threshold trips. `writeMs` sums only the time
  // spent inside `insertEdgesBulk`; queue-wait time is attributed to
  // `traverseMs` (which spans the whole traversal phase).
  const edgeBuf: EdgeInsert[] = [];
  let testsProcessed = 0;
  let edgesWritten = 0;
  let testsBounded = 0;
  let writeMs = 0;

  const traverseStart = opts.clock.nowMillis();

  const priorPragmas = snapshotPragmas(opts.db);
  applyBulkPragmas(opts.db);
  // Raw BEGIN/COMMIT instead of db.transaction(fn) so the body can await
  // worker replies between flushes. better-sqlite3 transactions are sync.
  opts.db.exec('BEGIN');
  let committed = false;
  try {
    if (scope === undefined) {
      clearAllEdges(opts.db);
      // Drop the secondary index for the duration of the write so each bulk
      // INSERT avoids per-row B-tree updates. Recreate after the final flush.
      opts.db.exec('DROP INDEX IF EXISTS edge_source_idx');
    } else {
      deleteEdgesForTests(opts.db, [...scope]);
      purgeOrphanEdges(opts.db);
    }

    const flushEdges = (): void => {
      if (edgeBuf.length === 0) return;
      const t0 = opts.clock.nowMillis();
      insertEdgesBulk(opts.db, edgeBuf);
      writeMs += opts.clock.nowMillis() - t0;
      edgeBuf.length = 0;
    };

    const absorb = (r: TraversalResult): void => {
      testsProcessed++;
      if (r.bounded) testsBounded++;
      for (const e of r.edges) {
        // Aggregate the per-edge provenance fact-ids (dedup + sorted
        // ascending) so the on-disk JSON array is stable regardless of
        // arrival order.
        const ids = new Set<number>();
        for (const piece of e.evidence) {
          for (const fid of piece.factIds) ids.add(fid);
        }
        const provenance: number[] = Array.from(ids).sort((a, b) => a - b);
        edgeBuf.push({
          testId: e.testId,
          source: e.source,
          confidence: e.confidence,
          partial: e.partial,
          evidence: e.evidence,
          derivedAt,
          provenance,
        });
        edgesWritten++;
      }
      if (edgeBuf.length >= EDGE_FLUSH_THRESHOLD) flushEdges();
    };

    if (!useWorkers) {
      // No overlap to gain when traversal is sync on the main thread; the
      // streaming buffer + flushes still apply but degenerate into one
      // final flush for small fixtures.
      for (let i = 0; i < testsToRun.length; i++) {
        const t = testsToRun[i];
        if (!t) continue;
        const r = traverseTest(graph, index, t.factId, t.testId, {
          maxDepth: opts.params.maxDepth,
          maxMillisPerTest: opts.params.maxMillisPerTest,
          threshold: opts.params.threshold,
          hookStopList: opts.params.hookStopList,
          now: () => opts.clock.nowMillis(),
          maxWildcardMatchesPerAnchor: opts.params.maxWildcardMatchesPerAnchor,
        });
        absorb(r);
      }
    } else {
      const pool = startDeriveWorkerPool({ graph, index, params: opts.params, size: workers });
      try {
        // Lane count = workers — one in-flight request per worker keeps the
        // slot utilised. Results are absorbed as soon as each lane's await
        // settles, so bulk inserts on the main thread interleave with
        // further traversal in the worker threads.
        const laneCount = workers;
        let nextIdx = 0;
        const lanes: Promise<void>[] = [];
        for (let l = 0; l < laneCount; l++) {
          lanes.push((async (): Promise<void> => {
            for (;;) {
              const idx = nextIdx++;
              if (idx >= testsToRun.length) return;
              const t = testsToRun[idx];
              if (!t) continue;
              const r = await pool.derive({
                testFactId: t.factId,
                testId: t.testId,
              });
              absorb(r);
            }
          })());
        }
        await Promise.all(lanes);
      } finally {
        await pool.shutdown();
      }
    }

    // Drain residual buffer before recreating the index + committing.
    flushEdges();

    // Recreate the dropped index inside the same tx so subsequent reads
    // (query/ commands) still hit it. CREATE INDEX inside an open tx is
    // fine for better-sqlite3.
    if (scope === undefined) {
      opts.db.exec('CREATE INDEX edge_source_idx ON edge(source)');
    }

    opts.db.exec('COMMIT');
    committed = true;
  } finally {
    if (!committed) {
      try { opts.db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    }
    restorePragmas(opts.db, priorPragmas);
  }

  const traverseMs = opts.clock.nowMillis() - traverseStart;
  const totalMs = opts.clock.nowMillis() - start;

  return {
    testsProcessed,
    edgesWritten,
    testsBounded,
    timings: { loadGraphMs, buildIndexMs, traverseMs, writeMs, totalMs },
  };
}
