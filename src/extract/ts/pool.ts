import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fact } from '../../facts/types.js';
import type { FrameworkName, Language } from '../../types.js';
import type { UserPattern } from '../declarative/pattern.js';

export interface TsExtractRequest {
  readonly relPath: string;
  readonly language: Language;
  readonly framework: FrameworkName | null;
  readonly source: string;
  readonly patterns: readonly UserPattern[];
}

export interface TsWorkerPool {
  extract(req: TsExtractRequest): Promise<Fact[]>;
  shutdown(): Promise<void>;
}

export interface TsPoolOptions {
  readonly projectRoot: string;
  readonly size: number;
}

interface Slot {
  readonly worker: Worker;
  pending: number;
}

interface PendingResolver {
  resolve: (facts: Fact[]) => void;
  reject: (e: Error) => void;
  slot: Slot;
}

interface WorkerOk {
  readonly id: number;
  readonly facts: Fact[];
}

interface WorkerErr {
  readonly id: number;
  readonly error: string;
}

type WorkerMessage = WorkerOk | WorkerErr;

// startTsWorkerPool spawns N worker_threads, each owning its own typescript
// import + per-directory CompilerOptionsResolver cache. Dispatch is least-busy.
// Memory cost is real (~40MB per worker for ts), so callers should keep the
// pool small (default min(cpus-2, 4) at the build/run.ts boundary).
export function startTsWorkerPool(opts: TsPoolOptions): TsWorkerPool {
  if (opts.size < 1) throw new Error('pool size must be >= 1');

  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = join(here, 'worker.js');
  const isCompiled = existsSync(compiled);
  const workerPath = isCompiled ? compiled : join(here, 'worker.ts');
  const execArgv = isCompiled ? [] : ['--import', 'jiti/register'];

  const init = { projectRoot: opts.projectRoot };

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
      if ('error' in msg) p.reject(new Error(msg.error));
      else p.resolve(msg.facts);
    });
    w.on('error', (e: Error) => {
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
    extract(req): Promise<Fact[]> {
      const id = nextId++;
      const slot = pick();
      slot.pending++;
      return new Promise<Fact[]>((resolve, reject) => {
        pending.set(id, { resolve, reject, slot });
        slot.worker.postMessage({ id, ...req });
      });
    },
    async shutdown(): Promise<void> {
      await Promise.all(slots.map((s) => s.worker.terminate()));
    },
  };
}
