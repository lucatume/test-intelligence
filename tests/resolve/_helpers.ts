// Shared fixtures for the resolve-zone tests. Each builds a real migrated
// store with `hook-fire` facts left `resolved = 0`, carrying the Phase-0
// `unresolved` block keyed by `exprHash`.
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applyInitialSchema } from '../../src/store/migrations.js';
import {
  upsertFile, insertFact, upsertAnchor, insertFactAnchor,
} from '../../src/store/writers.js';

const NOW = '2026-05-17T00:00:00.000Z';

export function migratedDb(): Database.Database {
  const db = new Database(':memory:');
  applyInitialSchema(db);
  return db;
}

// Build a store with one unresolved `hook-fire` fact per exprHash. Each fact
// gets a backing file row (`inc.php`) and a broad `hook:{*}` subject anchor.
// When `root` is given, a real backing source file is written under it so the
// bundle builder can slice a code-context window.
export function fixtureWithUnresolvedHookFacts(
  hashes: readonly string[],
  filePath = 'inc.php',
  root?: string,
): Database.Database {
  const db = migratedDb();
  if (root !== undefined) {
    const full = join(root, filePath);
    mkdirSync(dirname(full), { recursive: true });
    const lines: string[] = [];
    for (let i = 1; i <= 40; i++) lines.push(`do_action( $hook ); // line ${String(i)}`);
    writeFileSync(full, lines.join('\n') + '\n');
  }
  const fileId = upsertFile(db, {
    path: filePath, language: 'php', contentHash: 'fh', extractedAt: NOW,
    isTest: false, framework: null, frameworkClass: null,
  });
  const broad = upsertAnchor(db, { key: 'hook:{*}', type: 'hook' });
  hashes.forEach((h, i) => {
    const factId = insertFact(db, {
      fileId, kind: 'hook-fire', resolved: false,
      startLine: 10 + i, endLine: 10 + i,
      payload: {
        kind: 'hook-fire', hook: '{*}',
        unresolved: {
          scope: '(file)',
          fields: [{ field: 'hook', expression: '$hook' }],
          exprHash: h,
        },
      },
    });
    insertFactAnchor(db, { factId, anchorId: broad, role: 'target' });
  });
  return db;
}

// As above but writes a real source file under `root` so the importer can
// re-read a citation. Line 12 of the file contains the token `save_post`.
export function fixtureProjectWithUnresolvedHookFact(
  root: string,
  exprHash: string,
  relPath = 'inc.php',
): Database.Database {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= 20; i++) {
    lines.push(i === 12 ? "add_action( 'save_post', 'cb' );" : `// line ${String(i)}`);
  }
  writeFileSync(full, lines.join('\n') + '\n');

  const db = migratedDb();
  const fileId = upsertFile(db, {
    path: relPath, language: 'php', contentHash: 'fh', extractedAt: NOW,
    isTest: false, framework: null, frameworkClass: null,
  });
  const broad = upsertAnchor(db, { key: 'hook:{*}', type: 'hook' });
  const factId = insertFact(db, {
    fileId, kind: 'hook-fire', resolved: false, startLine: 14, endLine: 14,
    payload: {
      kind: 'hook-fire', hook: '{*}',
      unresolved: {
        scope: '(file)',
        fields: [{ field: 'hook', expression: '$hook' }],
        exprHash,
      },
    },
  });
  insertFactAnchor(db, { factId, anchorId: broad, role: 'target' });
  return db;
}

export function readHookFact(db: Database.Database, exprHash: string): {
  id: number; resolved: number; payload: Record<string, unknown>;
} {
  const rows = db.prepare(
    `SELECT id, resolved, payload FROM fact WHERE kind = 'hook-fire'`,
  ).all() as { id: number; resolved: number; payload: string }[];
  for (const r of rows) {
    const p = JSON.parse(r.payload) as Record<string, unknown>;
    const u = p['unresolved'] as { exprHash?: string } | undefined;
    const rh = (p['meta'] as { resolutionHash?: string } | undefined)?.resolutionHash;
    if (u?.exprHash === exprHash || rh === exprHash) {
      return { id: r.id, resolved: r.resolved, payload: p };
    }
  }
  throw new Error(`no hook-fire fact for exprHash ${exprHash}`);
}

export function anchorKeysForFact(db: Database.Database, factId: number): string[] {
  const rows = db.prepare(
    `SELECT a.key AS key FROM fact_anchor fa
       JOIN anchor a ON a.id = fa.anchor_id
      WHERE fa.fact_id = ?`,
  ).all(factId) as { key: string }[];
  return rows.map((r) => r.key);
}
