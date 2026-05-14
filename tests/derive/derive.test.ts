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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function write(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

describe.skipIf(!hasPhpAvailable())('derive end-to-end', () => {
  const getTmp = useTmpDir('ti-derive-');
  let worker: PhpWorker;

  beforeAll(async () => {
    const r = startPhpWorker({ repoRoot });
    if (r.kind !== 'ok') throw new Error(r.error.message);
    worker = r.value;
    await worker.registerPatterns(WP_PHP_PATTERNS);
  });
  afterAll(async () => { await worker.shutdown(); });

  it('produces test→source edges across WP boundaries', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
add_action('wp_ajax_get_cart', 'handle_get_cart');
function handle_get_cart() {}
`);
    write(root, 'src/client.ts', `
import { sendRequest } from './shared';
jQuery.ajax({ url: ajaxurl, data: { action: 'get_cart' } });
export function clientFn() { sendRequest(); }
`);
    write(root, 'src/shared.ts', `export function sendRequest() {}`);
    write(root, 'tests/cart.e2e.spec.ts', `
import { clientFn } from '../src/client';
import { test } from '@playwright/test';
test('cart flow', async () => { clientFn(); });
`);

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
          phpWorker: worker,
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
      const summary = await derive({
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
      expect(summary.testsProcessed).toBeGreaterThan(0);
      expect(summary.edgesWritten).toBeGreaterThan(0);

      const sources = (db.prepare('SELECT DISTINCT source FROM edge').all() as Array<{ source: string }>)
        .map((r) => r.source)
        .sort();
      expect(sources).toContain('src/client.ts');
      expect(sources).toContain('src/shared.ts');
      expect(sources).toContain('plugin.php');
    } finally { close(); }
  });
});
