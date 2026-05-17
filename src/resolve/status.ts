// `ti resolve status` — a read-only report of the resolution surface, plus the
// stale-cache prune (the one side effect: a resolution whose expr_hash matches
// no live unresolved fact is dropped here).
import type Database from 'better-sqlite3';
import { pruneStaleResolutions } from '../store/writers.js';
import type { Classification, FactKind } from './types.js';

export interface ResolveStatus {
  readonly unresolved: Record<FactKind, number>;
  readonly cached: number;
  readonly stale: number;
  readonly classHistogram: Record<Classification, number>;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function resolveStatus(db: Database.Database): ResolveStatus {
  // 1. resolved=0 hook facts grouped by kind.
  const unresolved: Record<FactKind, number> = { 'hook-fire': 0, 'hook-listener': 0 };
  const kindRows = db.prepare(
    `SELECT kind, COUNT(*) AS n FROM fact
      WHERE kind IN ('hook-fire','hook-listener') AND resolved = 0
      GROUP BY kind`,
  ).all() as { kind: string; n: number }[];
  for (const r of kindRows) {
    if (r.kind === 'hook-fire' || r.kind === 'hook-listener') unresolved[r.kind] = r.n;
  }

  // 2. live expr-hash set, then prune stale resolution rows.
  const liveHashes = new Set<string>();
  const factRows = db.prepare(
    `SELECT payload FROM fact
      WHERE kind IN ('hook-fire','hook-listener') AND resolved = 0`,
  ).all() as { payload: string }[];
  for (const r of factRows) {
    try {
      const p: unknown = JSON.parse(r.payload);
      if (isObject(p)) {
        const u = p['unresolved'];
        if (isObject(u)) {
          const h = u['exprHash'];
          if (typeof h === 'string' && h !== '') liveHashes.add(h);
        }
      }
    } catch { /* unreadable payload — not a live hash */ }
  }
  const stale = pruneStaleResolutions(db, liveHashes);

  // 3. cached count + classification histogram after the prune.
  const cached = (db.prepare('SELECT COUNT(*) AS n FROM resolution').get() as { n: number }).n;
  const classHistogram: Record<Classification, number> = {
    'structural-rule': 0, 'project-constant': 0, 'data-dependent-unresolvable': 0,
  };
  const classRows = db.prepare(
    'SELECT classification, COUNT(*) AS n FROM resolution GROUP BY classification',
  ).all() as { classification: string; n: number }[];
  for (const r of classRows) {
    if (r.classification === 'structural-rule'
      || r.classification === 'project-constant'
      || r.classification === 'data-dependent-unresolvable') {
      classHistogram[r.classification] = r.n;
    }
  }

  return { unresolved, cached, stale, classHistogram };
}
