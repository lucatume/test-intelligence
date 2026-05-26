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
  dead: boolean;
}

// Index of the least-busy slot that is not dead, or -1 if every slot is dead.
// Exported for unit testing; the pool's pick() wraps it.
export function pickSlot(slots: readonly { pending: number; dead: boolean }[]): number {
  let bestIdx = -1;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s === undefined || s.dead) continue;
    if (bestIdx === -1 || s.pending < (slots[bestIdx]?.pending ?? Infinity)) {
      bestIdx = i;
    }
  }
  return bestIdx;
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
    slots.push({ worker: r.value, pending: 0, dead: false });
  }

  function pick(): Slot {
    const idx = pickSlot(slots);
    if (idx === -1) throw new Error('all php workers are dead');
    const s = slots[idx];
    if (s === undefined) throw new Error('all php workers are dead');
    return s;
  }

  const liveSlots = (): Slot[] => slots.filter((s) => !s.dead);

  const pool: PhpWorker = {
    async ping(): Promise<boolean> {
      const live = liveSlots();
      if (live.length === 0) return false;
      const results = await Promise.all(live.map((s) => s.worker.ping()));
      return results.every((b) => b);
    },
    async registerPatterns(patterns): Promise<number> {
      const counts = await Promise.all(liveSlots().map((s) => s.worker.registerPatterns(patterns)));
      return counts[0] ?? 0;
    },
    async extract(absFile, phpUnitBaseClasses, relFile): Promise<unknown> {
      const slot = pick();
      slot.pending++;
      try {
        return await slot.worker.extract(absFile, phpUnitBaseClasses, relFile);
      } catch (e) {
        // A rejection is either a one-off PHP-side error for a single bad file
        // (the worker emitted op:'error' but is still alive and reading) or a
        // dead subprocess. Probe with ping: only evict the slot when the
        // worker is genuinely gone, so one pathological file does not take the
        // whole worker — and, on a size-1 pool, all remaining PHP — down.
        const alive = await slot.worker.ping().catch(() => false);
        if (!alive) slot.dead = true;
        throw e;
      } finally {
        slot.pending--;
      }
    },
    async prepass(absFile, relFile): Promise<void> {
      // Phase-1 dispatch: each file's wrapper-index work goes to the least-busy
      // live slot. The dump/merge barrier (separate op, host-driven) is what
      // unifies per-slot indexes after phase-1; this method only places the
      // work. Eviction policy mirrors extract().
      const slot = pick();
      slot.pending++;
      try {
        await slot.worker.prepass(absFile, relFile);
      } catch (e) {
        const alive = await slot.worker.ping().catch(() => false);
        if (!alive) slot.dead = true;
        throw e;
      } finally {
        slot.pending--;
      }
    },
    async resetState(): Promise<void> {
      await Promise.all(slots.map((s) => s.worker.resetState()));
    },
    async dumpWrapperIndex(): Promise<unknown[]> {
      // De-duplication is the receiver's job (see mergeWrapperIndexEntries).
      const all = await Promise.all(liveSlots().map((s) => s.worker.dumpWrapperIndex()));
      const out: unknown[] = [];
      for (const arr of all) for (const e of arr) out.push(e);
      return out;
    },
    async mergeWrapperIndex(entries): Promise<void> {
      await Promise.all(liveSlots().map((s) => s.worker.mergeWrapperIndex(entries)));
    },
    async flushDeferred(): Promise<unknown> {
      // Each live worker replays its own deferred buffer; facts are merged.
      // After the host's dump/merge barrier every worker holds the same global
      // wrapper index, so the persisted index is taken from the first slot
      // only — concatenating all slots would write N duplicate rows.
      const results = await Promise.all(liveSlots().map((s) => s.worker.flushDeferred()));
      const mergedFacts: unknown[] = [];
      for (const r of results) {
        const env = r as { op?: string; facts?: unknown[] };
        if (env.op === 'facts' && Array.isArray(env.facts)) {
          for (const f of env.facts) mergedFacts.push(f);
        }
      }
      const first = results[0] as { wrapperIndex?: unknown[] } | undefined;
      const wrapperIndex = Array.isArray(first?.wrapperIndex) ? first.wrapperIndex : [];
      return { op: 'facts', facts: mergedFacts, wrapperIndex };
    },
    async shutdown(): Promise<void> {
      await Promise.all(slots.map((s) => s.worker.shutdown()));
    },
  };

  return ok(pool);
}
