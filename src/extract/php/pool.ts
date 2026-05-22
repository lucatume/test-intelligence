import { err, ok, type Result } from '../../result.js';
import {
  startPhpWorker,
  type PhpWorker,
  type SpawnError,
  type SpawnOptions,
} from './spawn.js';

export interface PoolOptions extends SpawnOptions {
  readonly size: number;
}

interface Slot {
  readonly worker: PhpWorker;
  pending: number;
}

// startPhpWorkerPool wraps N PhpWorkers behind the same interface. Dispatch is
// least-busy by in-flight count, so a slow request on one slot does not stall
// the others. registerPatterns fans out; ping and shutdown await all slots.
export function startPhpWorkerPool(opts: PoolOptions): Result<PhpWorker, SpawnError> {
  if (opts.size < 1) {
    return err({ kind: 'PhpSpawnError', message: 'pool size must be >= 1' });
  }

  const slots: Slot[] = [];
  for (let i = 0; i < opts.size; i++) {
    const r = startPhpWorker(opts);
    if (r.kind === 'err') {
      // Tear down any slots already booted; surface the spawn error verbatim.
      void Promise.all(slots.map((s) => s.worker.shutdown())).catch(() => undefined);
      return r;
    }
    slots.push({ worker: r.value, pending: 0 });
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

  const pool: PhpWorker = {
    async ping(): Promise<boolean> {
      const results = await Promise.all(slots.map((s) => s.worker.ping()));
      return results.every((b) => b);
    },
    async registerPatterns(patterns): Promise<number> {
      const counts = await Promise.all(slots.map((s) => s.worker.registerPatterns(patterns)));
      return counts[0] ?? 0;
    },
    async extract(absFile, phpUnitBaseClasses, relFile): Promise<unknown> {
      const slot = pick();
      slot.pending++;
      try {
        return await slot.worker.extract(absFile, phpUnitBaseClasses, relFile);
      } finally {
        slot.pending--;
      }
    },
    async resetState(): Promise<void> {
      await Promise.all(slots.map((s) => s.worker.resetState()));
    },
    async dumpWrapperIndex(): Promise<unknown[]> {
      // De-duplication is the receiver's job (see mergeWrapperIndexEntries).
      const all = await Promise.all(slots.map((s) => s.worker.dumpWrapperIndex()));
      const out: unknown[] = [];
      for (const arr of all) for (const e of arr) out.push(e);
      return out;
    },
    async mergeWrapperIndex(entries): Promise<void> {
      await Promise.all(slots.map((s) => s.worker.mergeWrapperIndex(entries)));
    },
    async flushDeferred(): Promise<unknown> {
      // Fan out to all slots: each worker may have its own deferred call buffer.
      const results = await Promise.all(slots.map((s) => s.worker.flushDeferred()));
      // Merge the facts arrays and wrapperIndex arrays from each slot's response.
      const mergedFacts: unknown[] = [];
      const mergedWrapperIndex: unknown[] = [];
      for (const r of results) {
        const env = r as { op?: string; facts?: unknown[]; wrapperIndex?: unknown[] };
        if (env.op === 'facts' && Array.isArray(env.facts)) {
          for (const f of env.facts) mergedFacts.push(f);
        }
        if (Array.isArray(env.wrapperIndex)) {
          for (const w of env.wrapperIndex) mergedWrapperIndex.push(w);
        }
      }
      return { op: 'facts', facts: mergedFacts, wrapperIndex: mergedWrapperIndex };
    },
    async shutdown(): Promise<void> {
      await Promise.all(slots.map((s) => s.worker.shutdown()));
    },
  };

  return ok(pool);
}
