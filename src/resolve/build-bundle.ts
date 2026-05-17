// Build a `ResolveBundle` from a store's `resolved = 0` hook facts. Reads the
// Phase-0 `unresolved` block off each fact payload — `exprHash` is the cache
// key, `fields[0].expression` the source text the runner must resolve,
// `scope` the enclosing function/method.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { ok, type Result } from '../result.js';
import { pruneStaleResolutions, readResolution } from '../store/writers.js';
import type {
  ResolveBundle, ResolveUnit, ResolveError, FactKind,
} from './types.js';

export interface BuildBundleParams {
  readonly kinds: readonly FactKind[];
  readonly force: boolean;
  readonly projectRoot: string;
  readonly generatedAt: string;
}

// Lines of surrounding source captured above and below the fact's own region.
const CONTEXT_MARGIN = 8;

interface FactRow {
  readonly id: number;
  readonly kind: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly payload: string;
  readonly path: string;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function buildBundle(
  db: Database.Database, params: BuildBundleParams,
): Result<ResolveBundle, ResolveError> {
  const placeholders = params.kinds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT f.id AS id, f.kind AS kind, f.start_line AS start_line,
            f.end_line AS end_line, f.payload AS payload, fl.path AS path
       FROM fact f JOIN file fl ON fl.id = f.file_id
      WHERE f.kind IN (${placeholders}) AND f.resolved = 0
      ORDER BY f.id`,
  ).all(...params.kinds) as FactRow[];

  // Collect the live expr-hash set, then prune resolution rows for hashes that
  // no longer match any live unresolved fact.
  const liveHashes = new Set<string>();
  for (const r of rows) {
    const h = exprHashOf(r.payload);
    if (h !== null) liveHashes.add(h);
  }
  pruneStaleResolutions(db, liveHashes);

  const units: ResolveUnit[] = [];
  for (const r of rows) {
    const payload = safeParse(r.payload);
    if (payload === null) continue;
    const unresolved = payload['unresolved'];
    if (!isObject(unresolved)) continue;
    const exprHash = unresolved['exprHash'];
    const scope = unresolved['scope'];
    const fields = unresolved['fields'];
    if (typeof exprHash !== 'string' || exprHash === '') continue;
    if (typeof scope !== 'string' || !Array.isArray(fields)) continue;

    // Already resolved / classified for this expression — skip unless --force.
    if (!params.force && readResolution(db, exprHash, 'llm') !== null) continue;

    const first: unknown = fields[0];
    const expression = isObject(first) && typeof first['expression'] === 'string'
      ? first['expression']
      : '';

    const ctx = readContext(params.projectRoot, r.path, r.start_line, r.end_line);
    // A missing / unreadable file leaves the unit without context — skip it
    // rather than ship a contextless unit the runner cannot resolve.
    if (ctx === null) continue;

    units.push({
      exprHash,
      factKind: r.kind as FactKind,
      unresolvedExpression: expression,
      enclosingScope: scope,
      filePath: r.path as ResolveUnit['filePath'],
      codeContext: ctx,
    });
  }

  return ok({
    version: 1, pass: 'llm',
    project: params.projectRoot,
    generatedAt: params.generatedAt as ResolveBundle['generatedAt'],
    units,
  });
}

function exprHashOf(payloadJson: string): string | null {
  const p = safeParse(payloadJson);
  if (p === null) return null;
  const u = p['unresolved'];
  if (!isObject(u)) return null;
  const h = u['exprHash'];
  return typeof h === 'string' && h !== '' ? h : null;
}

function readContext(
  root: string, relPath: string, startLine: number, endLine: number,
): ResolveUnit['codeContext'] | null {
  let source: string;
  try {
    source = readFileSync(join(root, relPath), 'utf8');
  } catch {
    return null;
  }
  const lines = source.split('\n');
  const from = Math.max(1, startLine - CONTEXT_MARGIN);
  const to = Math.min(lines.length, endLine + CONTEXT_MARGIN);
  const text = lines.slice(from - 1, to).join('\n');
  return { startLine: from, endLine: to, text };
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(s);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}
