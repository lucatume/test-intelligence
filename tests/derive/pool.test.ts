import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { openStore } from '../../src/store/open.js';
import { walk } from '../../src/discover/walk.js';
import { extractFile } from '../../src/extract/index.js';
import { synthesizeCompilerOptions } from '../../src/extract/ts/compiler.js';
import { parseConfig, HOOK_STOP_LIST_BUILTINS } from '../../src/config/parse.js';
import { startPhpWorker, hasPhpAvailable, type PhpWorker } from '../../src/extract/php/spawn.js';
import { WP_PHP_PATTERNS } from '../../src/extract/declarative/wp-php-patterns.js';
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
import type { Database as BetterDatabase } from 'better-sqlite3';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function write(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

interface EdgeRow {
  test_id: string;
  source: string;
  confidence: number;
  partial: number;
}

function snapshotEdges(db: BetterDatabase): EdgeRow[] {
  const rows = db
    .prepare('SELECT test_id, source, confidence, partial FROM edge ORDER BY test_id, source')
    .all() as EdgeRow[];
  return rows;
}

describe.skipIf(!hasPhpAvailable())('derive worker pool — byte equality', () => {
  const getTmp = useTmpDir('ti-derive-pool-');
  let phpWorker: PhpWorker;

  beforeAll(async () => {
    const r = startPhpWorker({ repoRoot });
    if (r.kind !== 'ok') throw new Error(r.error.message);
    phpWorker = r.value;
    await phpWorker.registerPatterns(WP_PHP_PATTERNS);
  });
  afterAll(async () => { await phpWorker.shutdown(); });

  // Helper that builds the same fixture, then runs derive twice (once
  // in-process, once with N workers) on an isolated copy of the data, and
  // returns both edge snapshots for direct comparison.
  async function buildAndDerive(workers: number, root: string): Promise<EdgeRow[]> {
    const cfgRes = parseConfig({
      tests: { playwright: { fileGlobs: ['tests/**/*.e2e.spec.ts'] } },
      confidence: { threshold: 0 },
    });
    if (cfgRes.kind === 'err') throw new Error('config');
    const cfg = cfgRes.value;
    const opts = synthesizeCompilerOptions(root);
    const sRes = openStore(root);
    if (sRes.kind === 'err') throw new Error(sRes.error.message);
    const { db, close } = sRes.value;
    try {
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
          phpWorker,
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
        workers,
      });
      return snapshotEdges(db);
    } finally { close(); }
  }

  it('produces identical edges with workers=0 and workers=2', async () => {
    // Synthetic project that exercises php-include, JS imports, hook bridges,
    // ajax bridges, REST bridges + multi-test traversal. Same project is
    // built twice from scratch, then derive runs in-process vs with 2 workers.
    function fixture(root: string): void {
      write(root, 'plugin.php', `<?php
add_action('wp_ajax_get_cart', 'handle_get_cart');
function handle_get_cart() {}
register_rest_route('p/v1', '/items', array());
`);
      write(root, 'src/client.ts', `
import { sendRequest } from './shared';
jQuery.ajax({ url: ajaxurl, data: { action: 'get_cart' } });
fetch('/wp-json/p/v1/items');
export function clientFn() { sendRequest(); }
`);
      write(root, 'src/shared.ts', `export function sendRequest() {}`);
      for (let i = 0; i < 6; i++) {
        write(root, `tests/cart${String(i)}.e2e.spec.ts`, `
import { clientFn } from '../src/client';
import { test } from '@playwright/test';
test('flow ${String(i)}', async () => { clientFn(); });
`);
      }
    }

    const rootA = getTmp();
    fixture(rootA);
    const baseline = await buildAndDerive(0, rootA);
    expect(baseline.length).toBeGreaterThan(0);

    // Re-build a fresh copy so the two runs do not share .test-intelligence
    // state and both populate the store identically before running derive.
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const rootB = await fs.mkdtemp(join(os.tmpdir(), 'ti-derive-pool-b-'));
    try {
      fixture(rootB);
      const parallel = await buildAndDerive(2, rootB);
      expect(parallel).toEqual(baseline);
    } finally {
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });
});
