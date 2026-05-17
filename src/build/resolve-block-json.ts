// Cross-file resolver for block-render facts whose register_block_type*
// argument is a directory (or block.json file) path rather than a block name.
// Runs after every file's facts are in the store and before derive snapshots
// the graph — same position and transaction contract as resolveRestEndpoints
// and resolveEnqueueScripts.
//
// The PHP worker emits the resolved arg-0 directory as payload.dir for any
// block-render fact it could not name. This pass reads <dir>/block.json (or
// `dir` itself when it already ends in block.json), takes the `name` field,
// marks the fact resolved and inserts the block:<name> subject anchor so the
// PHP subject side meets the JS registerBlockType target side.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { upsertAnchor, updateFactResolvedPayload } from '../store/writers.js';

export interface ResolveBlockJsonOptions {
  /** Absolute project root, used to read block.json files from disk. */
  readonly projectRoot: string;
}

export interface ResolveBlockJsonSummary {
  /** block-render facts carrying a `dir` payload field that were inspected. */
  readonly examined: number;
  /** facts that gained a block:<name> anchor from a readable block.json. */
  readonly resolved: number;
}

interface IdPayloadRow {
  readonly id: number;
  readonly payload: string;
}

// Resolve every unresolved block-render fact whose payload carries a `dir`.
// Mutates fact and fact_anchor rows in place. Caller owns the transaction.
export function resolveBlockJson(
  db: Database.Database,
  opts: ResolveBlockJsonOptions,
): ResolveBlockJsonSummary {
  let examined = 0;
  let resolved = 0;

  const rows = db
    .prepare(`SELECT id, payload FROM fact WHERE kind = 'block-render' AND resolved = 0`)
    .all() as IdPayloadRow[];

  for (const row of rows) {
    const payload = safeParse(row.payload);
    const dir = payload?.['dir'];
    if (typeof dir !== 'string' || dir === '') continue;
    examined++;

    const name = readBlockName(opts.projectRoot, dir);
    if (name === null) continue;

    const newPayload: Record<string, unknown> = { ...payload, kind: 'block-render', name };
    updateFactResolvedPayload(db, { factId: row.id, resolved: true, payload: newPayload });

    const anchorId = upsertAnchor(db, { key: 'block:' + name, type: 'block' });
    db.prepare(
      `INSERT OR IGNORE INTO fact_anchor (fact_id, anchor_id, role) VALUES (?, ?, 'subject')`,
    ).run(row.id, anchorId);
    resolved++;
  }

  return { examined, resolved };
}

// Read <projectRoot>/<dir>/block.json (or <dir> itself when it already names a
// block.json file) and return a non-empty `name` string, or null on any miss:
// missing file, unreadable file, invalid JSON, absent/empty/non-string name.
function readBlockName(projectRoot: string, dir: string): string | null {
  const rel = dir.endsWith('/block.json') || dir === 'block.json' ? dir : dir + '/block.json';
  let raw: string;
  try {
    raw = readFileSync(join(projectRoot, rel), 'utf8');
  } catch {
    return null;
  }
  const parsed = safeParse(raw);
  if (parsed === null) return null;
  const name = parsed['name'];
  return typeof name === 'string' && name !== '' ? name : null;
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(s);
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
