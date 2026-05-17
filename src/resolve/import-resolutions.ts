// The citation-verifying resolutions importer — the hallucination guard's
// runtime half. For every resolution it re-reads the cited source line and
// confirms the claimed hook token literally appears before writing anything.
//
// Phase-0 reconciliation: the partial-fact context lives in the shared
// `payload.unresolved` block (`{ scope, fields[], exprHash }`). The cache key
// is `unresolved.exprHash`. On apply the block is dropped; the captured
// expression text is preserved as `payload.unresolved_expression` for audit
// (the pre-Phase-0 field name the spec's audit clause names).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { ok, type Result } from '../result.js';
import type { Clock } from '../clock.js';
import {
  upsertResolution, updateFactResolvedPayload, repointFactAnchor, upsertAnchor,
} from '../store/writers.js';
import { derive, type DeriveParams } from '../derive/derive.js';
import type { ResolutionsFile, ImportSummary, ResolveError } from './types.js';

// Re-exported so the `cli` zone — which may import `resolve` but not `derive`
// — can name the param type without crossing a boundary it is not allowed.
export type { DeriveParams };

// Lines of tolerance around the cited line — an LLM may cite off-by-one.
const CITE_WINDOW = 2;

export interface ImportContext {
  readonly root: string;
  readonly deriveParams: DeriveParams;
  readonly clock: Clock;
}

interface LiveFactRow {
  readonly id: number;
  readonly payload: string;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(s);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

// Index every live `resolved = 0` hook fact by its expr hash.
function liveFactsByHash(db: Database.Database): Map<string, LiveFactRow> {
  const out = new Map<string, LiveFactRow>();
  const rows = db.prepare(
    `SELECT id, payload FROM fact
      WHERE kind IN ('hook-fire','hook-listener') AND resolved = 0`,
  ).all() as LiveFactRow[];
  for (const r of rows) {
    const p = safeParse(r.payload);
    const u = p?.['unresolved'];
    if (!isObject(u)) continue;
    const h = u['exprHash'];
    if (typeof h === 'string' && h !== '') out.set(h, r);
  }
  return out;
}

// Re-read `relPath` and confirm `token` appears in the window around `line`.
function citationVerifies(
  root: string, relPath: string, line: number, token: string,
): boolean {
  let source: string;
  try {
    source = readFileSync(join(root, relPath), 'utf8');
  } catch {
    return false;
  }
  const lines = source.split('\n');
  const from = Math.max(1, line - CITE_WINDOW);
  const to = Math.min(lines.length, line + CITE_WINDOW);
  if (line < 1 || line > lines.length) return false;
  for (let i = from; i <= to; i++) {
    if ((lines[i - 1] ?? '').includes(token)) return true;
  }
  return false;
}

export async function importResolutions(
  db: Database.Database, fileDoc: ResolutionsFile, ctx: ImportContext,
): Promise<Result<ImportSummary, ResolveError>> {
  let applied = 0;
  let rejected = 0;
  let stale = 0;
  let classifiedUnresolvable = 0;
  const rejections: { exprHash: string; reason: string }[] = [];
  const appliedFactIds: number[] = [];

  // One transaction for the whole import (the `ti` convention). Per-resolution
  // rejections are expected outcomes and do not roll back.
  db.exec('BEGIN');
  let committed = false;
  try {
    const live = liveFactsByHash(db);

    for (const r of fileDoc.resolutions) {
      const factRow = live.get(r.exprHash);
      if (factRow === undefined) {
        // No live unresolved fact for this hash — the code changed since
        // export, or the fact already resolved.
        stale++;
        continue;
      }

      if (r.classification === 'data-dependent-unresolvable') {
        // Cache marker — `export` never re-offers this fact. Fact untouched.
        upsertResolution(db, {
          exprHash: r.exprHash, pass: 'llm', resolvedValue: {},
          classification: r.classification, citePath: '', citeLine: 0,
          citeVerified: false, importedAt: ctx.clock.now(),
        });
        classifiedUnresolvable++;
        continue;
      }

      // structural-rule / project-constant — verify the citation.
      const hookName = r.resolvedValue?.hookName;
      const cite = r.citation;
      if (hookName === undefined || cite === undefined) {
        // Unreachable: the parser already enforces this. Defensive.
        rejected++;
        rejections.push({ exprHash: r.exprHash, reason: 'missing resolvedValue/citation' });
        continue;
      }
      if (!citationVerifies(ctx.root, cite.path, cite.line, hookName)) {
        rejected++;
        rejections.push({
          exprHash: r.exprHash,
          reason: `citation ${cite.path}:${String(cite.line)} does not contain "${hookName}"`,
        });
        continue;
      }

      // Verified. Write the resolution row, then apply to the fact.
      upsertResolution(db, {
        exprHash: r.exprHash, pass: 'llm', resolvedValue: { hookName },
        classification: r.classification, citePath: cite.path, citeLine: cite.line,
        citeVerified: true, importedAt: ctx.clock.now(),
      });

      const payload = safeParse(factRow.payload) ?? {};
      const unresolved = payload['unresolved'];
      // Preserve the captured expression text for audit, drop the block.
      let auditExpr = '';
      if (isObject(unresolved)) {
        const fields: unknown = unresolved['fields'];
        if (Array.isArray(fields) && isObject(fields[0])) {
          const ex = fields[0]['expression'];
          if (typeof ex === 'string') auditExpr = ex;
        }
      }
      const priorMeta = isObject(payload['meta']) ? payload['meta'] : {};
      const newPayload: Record<string, unknown> = {
        ...payload,
        hook: hookName,
        unresolved_expression: auditExpr,
        meta: { ...priorMeta, resolvedBy: 'llm-pass', resolutionHash: r.exprHash },
      };
      delete newPayload['unresolved'];
      updateFactResolvedPayload(db, { factId: factRow.id, resolved: true, payload: newPayload });

      // Repoint the fact's broad/absent hook anchor to the exact hook anchor,
      // preserving whatever role(s) it already carries. A `hook-fire` carries
      // its hook anchor at `target` role, a `hook-listener` at `subject` —
      // hard-coding a role would break the bridge join. When the fact carries
      // no hook anchor at all, attach the exact one at `subject` (a sane
      // default for the anchor-less case).
      const newAnchorId = upsertAnchor(db, { key: `hook:${hookName}`, type: 'hook' });
      const oldAnchors = db.prepare(
        `SELECT fa.anchor_id AS anchorId, fa.role AS role FROM fact_anchor fa
           JOIN anchor a ON a.id = fa.anchor_id
          WHERE fa.fact_id = ? AND a.type = 'hook'`,
      ).all(factRow.id) as { anchorId: number; role: string }[];
      if (oldAnchors.length === 0) {
        db.prepare(
          `INSERT OR IGNORE INTO fact_anchor (fact_id, anchor_id, role) VALUES (?, ?, 'subject')`,
        ).run(factRow.id, newAnchorId);
      } else {
        for (const oa of oldAnchors) {
          repointFactAnchor(db, {
            factId: factRow.id, oldAnchorId: oa.anchorId, newAnchorId, role: oa.role,
          });
        }
      }

      applied++;
      appliedFactIds.push(factRow.id);
    }

    db.exec('COMMIT');
    committed = true;
  } finally {
    if (!committed) {
      try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    }
  }

  // Re-derive so the new exact `hook:` anchors yield edges. Phase-1 fallback
  // (spec Risk 3): `derive` has no per-test entry point, so a whole-store
  // re-derive runs when any resolution was applied. `derive` owns its own
  // transaction, so it runs after the import transaction commits.
  if (appliedFactIds.length > 0) {
    await derive({ db, params: ctx.deriveParams, clock: ctx.clock });
  }

  return ok({ applied, rejected, stale, classifiedUnresolvable, rejections });
}
