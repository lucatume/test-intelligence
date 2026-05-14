import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Database as BetterDatabase } from 'better-sqlite3';
import { openStore } from '../../src/store/open.js';
import { walk } from '../../src/discover/walk.js';
import { extractFile } from '../../src/extract/index.js';
import { synthesizeCompilerOptions } from '../../src/extract/ts/compiler.js';
import { parseConfig, HOOK_STOP_LIST_BUILTINS } from '../../src/config/parse.js';
import {
  upsertFile,
  insertFact,
  upsertAnchor,
  insertFactAnchor,
  insertTest,
} from '../../src/store/writers.js';
import { parseAnchor } from '../../src/anchors/parse.js';
import { derive } from '../../src/derive/derive.js';
import { systemClock } from '../../src/clock.js';
import { useTmpDir } from '../helpers/tmpDir.js';

function write(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

// JS-only fixture: a handful of tests that import a shared client module.
// Picks up symbol-call + symbol-def + ts-import facts — enough to write a
// non-trivial number of edges (with provenance) so the integration path
// exercises the bulk insert + index drop/recreate.
function tsFixture(root: string): void {
  write(root, 'src/client.ts', `
import { sendRequest } from './shared';
export function clientFn() { sendRequest(); }
`);
  write(root, 'src/shared.ts', `export function sendRequest() {}`);
  for (let i = 0; i < 4; i++) {
    write(root, `tests/cart${String(i)}.spec.ts`, `
import { clientFn } from '../src/client';
import { test } from '@playwright/test';
test('flow ${String(i)}', async () => { clientFn(); });
`);
  }
}

async function ingest(root: string, db: BetterDatabase): Promise<void> {
  const cfgRes = parseConfig({
    tests: { playwright: { fileGlobs: ['tests/**/*.spec.ts'] } },
    confidence: { threshold: 0 },
  });
  if (cfgRes.kind === 'err') throw new Error('config');
  const cfg = cfgRes.value;
  const opts = synthesizeCompilerOptions(root);
  for await (const file of walk(root, cfg)) {
    const source = readFileSync(join(root, file.path), 'utf8');
    const hash = createHash('sha1').update(source).digest('hex');
    const fileId = upsertFile(db, {
      path: file.path,
      language: file.language,
      contentHash: hash,
      extractedAt: '2026-05-13T00:00:00.000Z',
      isTest: file.framework !== null,
      framework: file.framework,
      frameworkClass: file.frameworkClass,
    });
    const r = await extractFile({
      projectRoot: root,
      path: file.path,
      language: file.language,
      framework: file.framework,
      compilerOptions: opts,
      patterns: [],
    });
    if (r.kind !== 'ok') continue;
    for (const f of r.value) {
      const factId = insertFact(db, {
        fileId,
        kind: f.kind,
        resolved: f.resolved,
        startLine: f.location.startLine,
        endLine: f.location.endLine,
        payload: f.payload,
      });
      for (const a of f.anchors) {
        const parsed = parseAnchor(a.key);
        if (parsed.kind === 'err') continue;
        const anchorId = upsertAnchor(db, { key: parsed.value.key, type: parsed.value.type });
        insertFactAnchor(db, { factId, anchorId, role: a.role });
      }
      if (f.kind === 'test-def') {
        const payload = f.payload as { testId: string; framework: string };
        insertTest(db, {
          testId: payload.testId,
          fileId,
          framework: payload.framework,
          frameworkClass: file.frameworkClass ?? 'e2e',
          factId,
        });
      }
    }
  }
}

async function runDerive(db: BetterDatabase): Promise<void> {
  const cfgRes = parseConfig({
    tests: { playwright: { fileGlobs: ['tests/**/*.spec.ts'] } },
    confidence: { threshold: 0 },
  });
  if (cfgRes.kind === 'err') throw new Error('config');
  const cfg = cfgRes.value;
  const stopList = new Set<string>(HOOK_STOP_LIST_BUILTINS);
  for (const h of cfg.hooks.stopList.add) stopList.add(h);
  for (const h of cfg.hooks.stopList.remove) stopList.delete(h);
  await derive({
    db,
    params: {
      maxDepth: cfg.traversal.maxDepth,
      maxMillisPerTest: cfg.traversal.maxMillisPerTest,
      threshold: cfg.confidence.threshold,
      hookStopList: stopList,
      maxWildcardMatchesPerAnchor: cfg.traversal.maxWildcardMatchesPerAnchor,
    },
    clock: systemClock,
  });
}

interface EdgeRow {
  test_id: string;
  source: string;
  confidence: number;
  partial: number;
  evidence: string;
  provenance: string;
}

function snapshotEdges(db: BetterDatabase): EdgeRow[] {
  return db
    .prepare('SELECT test_id, source, confidence, partial, evidence, provenance FROM edge ORDER BY test_id, source')
    .all() as EdgeRow[];
}

interface IndexRow { name: string }

function indexesOn(db: BetterDatabase, table: string): string[] {
  return (db.prepare(`PRAGMA index_list('${table}')`).all() as IndexRow[])
    .map((r) => r.name)
    .sort();
}

describe('derive bulk write path', () => {
  const getTmp = useTmpDir('ti-derive-bulk-write-');

  it('writes a non-empty edge set with sorted-ascending provenance', async () => {
    const root = getTmp();
    tsFixture(root);
    const sRes = openStore(root);
    if (sRes.kind === 'err') throw new Error(sRes.error.message);
    const { db, close } = sRes.value;
    try {
      await ingest(root, db);
      await runDerive(db);
      const edges = snapshotEdges(db);
      expect(edges.length).toBeGreaterThan(0);
      const sources = new Set(edges.map((e) => e.source));
      expect(sources.has('src/client.ts')).toBe(true);
      expect(sources.has('src/shared.ts')).toBe(true);

      // At least one edge should carry provenance fact-ids (sorted ascending).
      let nonEmptyProv = 0;
      for (const e of edges) {
        const ids = JSON.parse(e.provenance) as number[];
        if (ids.length > 0) {
          nonEmptyProv++;
          const sorted = [...ids].sort((a, b) => a - b);
          expect(ids).toEqual(sorted);
        }
      }
      expect(nonEmptyProv).toBeGreaterThan(0);
    } finally { close(); }
  });

  it('restores PRAGMAs (synchronous, cache_size, temp_store) after derive() returns', async () => {
    const root = getTmp();
    tsFixture(root);
    const sRes = openStore(root);
    if (sRes.kind === 'err') throw new Error(sRes.error.message);
    const { db, close } = sRes.value;
    try {
      await ingest(root, db);

      const before = {
        synchronous: db.pragma('synchronous', { simple: true }) as number,
        cacheSize: db.pragma('cache_size', { simple: true }) as number,
        tempStore: db.pragma('temp_store', { simple: true }) as number,
      };
      await runDerive(db);
      const after = {
        synchronous: db.pragma('synchronous', { simple: true }) as number,
        cacheSize: db.pragma('cache_size', { simple: true }) as number,
        tempStore: db.pragma('temp_store', { simple: true }) as number,
      };
      expect(after).toEqual(before);
    } finally { close(); }
  });

  it('preserves edge_source_idx after derive() returns', async () => {
    const root = getTmp();
    tsFixture(root);
    const sRes = openStore(root);
    if (sRes.kind === 'err') throw new Error(sRes.error.message);
    const { db, close } = sRes.value;
    try {
      await ingest(root, db);
      await runDerive(db);
      const edgeIdx = indexesOn(db, 'edge');
      expect(edgeIdx).toContain('edge_source_idx');
    } finally { close(); }
  });
});
