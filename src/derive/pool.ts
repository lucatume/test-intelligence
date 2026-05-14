import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Graph } from './types.js';
import type { AnchorIndex } from './anchor-index.js';
import type { TraversalResult } from './traverse.js';
import type { DeriveParams } from './derive.js';

export interface DeriveRequest {
  readonly testFactId: number;
  readonly testId: string;
  readonly frameworkClass: 'unit' | 'e2e';
}

export interface DeriveWorkerPool {
  derive(req: DeriveRequest): Promise<TraversalResult>;
  shutdown(): Promise<void>;
}

export interface DerivePoolOptions {
  readonly graph: Graph;
  readonly index: AnchorIndex;
  readonly params: DeriveParams;
  readonly size: number;
}

interface Slot {
  readonly worker: Worker;
  pending: number;
}

interface PendingResolver {
  resolve: (r: TraversalResult) => void;
  reject: (e: Error) => void;
  slot: Slot;
}

interface WorkerMessage {
  readonly id: number;
  readonly result: TraversalResult;
}

// startDeriveWorkerPool spawns N worker threads, each holding its own copy of
// the graph + anchor index. Per-test traversal requests dispatch to the
// least-busy slot. Workers are oversubscribable (the lane count in the caller
// is what actually bounds in-flight work) — a slow request on one slot does
// not stall the others.
//
// The worker entry resolves to dist/derive/worker.js after `tsc` runs; in
// dev / vitest it points at src/derive/worker.ts and we ask Node to load
// `jiti/register` so the .ts source is interpretable in the spawned thread.
export function startDeriveWorkerPool(opts: DerivePoolOptions): DeriveWorkerPool {
  if (opts.size < 1) throw new Error('pool size must be >= 1');

  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = join(here, 'worker.js');
  const isCompiled = existsSync(compiled);
  const workerPath = isCompiled ? compiled : join(here, 'worker.ts');
  const execArgv = isCompiled ? [] : ['--import', 'jiti/register'];

  const init = {
    graph: opts.graph,
    index: opts.index,
    params: {
      maxDepth: opts.params.maxDepth,
      maxMillisPerTest: opts.params.maxMillisPerTest,
      threshold: opts.params.threshold,
      hookStopList: [...opts.params.hookStopList],
    },
  };

  const pending = new Map<number, PendingResolver>();
  let nextId = 1;

  const slots: Slot[] = [];
  for (let i = 0; i < opts.size; i++) {
    const w = new Worker(workerPath, { workerData: init, execArgv });
    w.on('message', (msg: WorkerMessage) => {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      p.slot.pending--;
      p.resolve(msg.result);
    });
    w.on('error', (e: Error) => {
      // Fail every in-flight request so callers see the failure rather than
      // hanging on a never-resolving promise.
      for (const p of pending.values()) p.reject(e);
      pending.clear();
    });
    slots.push({ worker: w, pending: 0 });
  }

  function pick(): Slot {
    let best = slots[0];
    if (!best) throw new Error('pool empty');
    for (let i = 1; i < slots.length; i++) {
      const s = slots[i];
      if (s && s.pending < best.pending) best = s;
    }
    return best;
  }

  return {
    derive(req): Promise<TraversalResult> {
      const id = nextId++;
      const slot = pick();
      slot.pending++;
      return new Promise<TraversalResult>((resolve, reject) => {
        pending.set(id, { resolve, reject, slot });
        slot.worker.postMessage({ id, ...req });
      });
    },
    async shutdown(): Promise<void> {
      await Promise.all(slots.map((s) => s.worker.terminate()));
    },
  };
}
