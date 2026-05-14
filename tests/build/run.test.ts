import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuild } from '../../src/build/run.js';
import { parseConfig } from '../../src/config/parse.js';
import { systemClock } from '../../src/clock.js';
import { openStore } from '../../src/store/open.js';
import { hasPhpAvailable } from '../../src/extract/php/spawn.js';
import { useTmpDir } from '../helpers/tmpDir.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function write(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

describe.skipIf(!hasPhpAvailable())('runBuild end-to-end', () => {
  const getTmp = useTmpDir('ti-build-run-');

  it('discovers → extracts → derives, populates the store, prints summary', async () => {
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
    if (cfgRes.kind === 'err') throw new Error('cfg');

    const lines: string[] = [];
    const r = await runBuild({
      projectRoot: root,
      config: cfgRes.value,
      clock: systemClock,
      stderr: { write: (s) => { lines.push(s); } },
      repoRoot,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.value.filesExtracted).toBeGreaterThan(0);
      expect(r.value.testsFound).toBeGreaterThan(0);
      expect(r.value.edgesWritten).toBeGreaterThan(0);
    }
    expect(lines.join('')).toMatch(/build complete/);

    const sRes = openStore(root);
    if (sRes.kind !== 'ok') throw new Error('store');
    try {
      const fileCount = (sRes.value.db.prepare('SELECT COUNT(*) AS n FROM file').get() as { n: number }).n;
      const edgeCount = (sRes.value.db.prepare('SELECT COUNT(*) AS n FROM edge').get() as { n: number }).n;
      expect(fileCount).toBeGreaterThanOrEqual(4);
      expect(edgeCount).toBeGreaterThan(0);
    } finally { sRes.value.close(); }
  });

  it('phpunit test reaches a source file via class instantiation', async () => {
    // The canonical PHP coverage case: a test instantiates a class defined
    // in another file. Before symbol-use emission, all phpunit tests had
    // zero edges. This test pins down the minimum to keep PHP working.
    const root = getTmp();
    write(root, 'src/Cart.php', `<?php
namespace App;
class Cart {
  public function add(): void {}
}`);
    write(root, 'tests/CartTest.php', `<?php
namespace App\\Tests;
use App\\Cart;
use PHPUnit\\Framework\\TestCase;
class CartTest extends TestCase {
  public function testAdd(): void {
    $c = new Cart();
    $c->add();
  }
}`);
    const cfgRes = parseConfig({ confidence: { threshold: 0 } });
    if (cfgRes.kind === 'err') throw new Error('cfg');
    const r = await runBuild({
      projectRoot: root,
      config: cfgRes.value,
      clock: systemClock,
      stderr: { write: () => {} },
      repoRoot,
    });
    expect(r.kind).toBe('ok');

    const sRes = openStore(root);
    if (sRes.kind !== 'ok') throw new Error('store');
    try {
      const rows = sRes.value.db
        .prepare('SELECT test_id, source FROM edge WHERE source = ?')
        .all('src/Cart.php') as Array<{ test_id: string; source: string }>;
      expect(rows.length).toBeGreaterThan(0);
      // testId is project-relative and namespaced with framework prefix.
      expect(rows[0]?.test_id).toContain('phpunit:tests/CartTest.php');
    } finally { sRes.value.close(); }
  });

  it('produces identical totals across php worker pool sizes', async () => {
    // Concurrency MUST be a performance lever, not a correctness one. Build the
    // same fixture under phpWorkers=1 and phpWorkers=4 and require the four
    // counters in BuildSummary to match exactly. If they ever drift, the
    // parallel build is dropping work somewhere — silent and dangerous.
    const root = getTmp();
    for (let i = 0; i < 12; i++) {
      const cls = `Cart${String(i)}`;
      write(root, `src/${cls}.php`, `<?php
namespace App;
class ${cls} { public function run(): void {} }`);
      write(root, `tests/${cls}Test.php`, `<?php
namespace App\\Tests;
use App\\${cls};
use PHPUnit\\Framework\\TestCase;
class ${cls}Test extends TestCase {
  public function testRun(): void { (new ${cls}())->run(); }
}`);
    }

    async function buildOnce(workers: number) {
      // Each invocation runs against a fresh .test-intelligence so the
      // upsert/insert path is exercised fully, not just touched.
      const cfg = parseConfig({
        concurrency: { phpWorkers: workers },
        confidence: { threshold: 0 },
      });
      if (cfg.kind === 'err') throw new Error('cfg');
      const r = await runBuild({
        projectRoot: root,
        config: cfg.value,
        clock: systemClock,
        stderr: { write: () => {} },
        repoRoot,
      });
      if (r.kind !== 'ok') throw new Error('build failed');
      return r.value;
    }

    const one = await buildOnce(1);
    // wipe and rebuild
    const fs = await import('node:fs/promises');
    await fs.rm(join(root, '.test-intelligence'), { recursive: true, force: true });
    const four = await buildOnce(4);

    expect(four.filesExtracted).toBe(one.filesExtracted);
    expect(four.factsInserted).toBe(one.factsInserted);
    expect(four.testsFound).toBe(one.testsFound);
    expect(four.edgesWritten).toBe(one.edgesWritten);
  });

  it('produces identical totals across ts worker pool sizes', async () => {
    // Mirror of the PHP-pool equality test, for the JS/TS path. Both runs
    // hit the same fixture; counts must be identical regardless of whether
    // TS extraction goes through the pool or the in-process compiler.
    const root = getTmp();
    for (let i = 0; i < 12; i++) {
      write(root, `src/m${String(i)}.ts`, `
import { shared } from './shared';
export function m${String(i)}() { shared(); }
`);
      write(root, `tests/m${String(i)}.test.ts`, `
import { m${String(i)} } from '../src/m${String(i)}';
import { describe, it } from 'vitest';
describe('m${String(i)}', () => { it('runs', () => { m${String(i)}(); }); });
`);
    }
    write(root, 'src/shared.ts', 'export function shared() {}');

    async function buildOnce(workers: number) {
      const cfg = parseConfig({
        concurrency: { tsWorkers: workers, phpWorkers: 1 },
        confidence: { threshold: 0 },
      });
      if (cfg.kind === 'err') throw new Error('cfg');
      const r = await runBuild({
        projectRoot: root,
        config: cfg.value,
        clock: systemClock,
        stderr: { write: () => {} },
        repoRoot,
      });
      if (r.kind !== 'ok') throw new Error('build failed');
      return r.value;
    }

    const inProcess = await buildOnce(0);
    const fs = await import('node:fs/promises');
    await fs.rm(join(root, '.test-intelligence'), { recursive: true, force: true });
    const pooled = await buildOnce(2);

    expect(pooled.filesExtracted).toBe(inProcess.filesExtracted);
    expect(pooled.factsInserted).toBe(inProcess.factsInserted);
    expect(pooled.testsFound).toBe(inProcess.testsFound);
    expect(pooled.edgesWritten).toBe(inProcess.edgesWritten);
  }, { timeout: 30_000 });

  it('does not emit edges into nested vendor directories', async () => {
    // Earlier `vendor` detection only matched top-level vendor/; monorepos
    // place vendor/ under every package, so phpunit edges leaked into
    // packages/<x>/vendor/phpunit/... etc. Verify that's fixed.
    const root = getTmp();
    write(root, 'packages/blueprint/src/A.php', `<?php
namespace Pkg;
class A { public function run(): void {} }`);
    write(root, 'packages/blueprint/vendor/foo/lib/Helper.php', `<?php
namespace Pkg;
class A { public function leakedDef(): void {} }`);
    write(root, 'packages/blueprint/tests/ATest.php', `<?php
namespace Pkg\\Tests;
use Pkg\\A;
use PHPUnit\\Framework\\TestCase;
class ATest extends TestCase {
  public function testRun(): void { (new A())->run(); }
}`);

    const cfgRes = parseConfig({ confidence: { threshold: 0 } });
    if (cfgRes.kind === 'err') throw new Error('cfg');
    const r = await runBuild({
      projectRoot: root,
      config: cfgRes.value,
      clock: systemClock,
      stderr: { write: () => {} },
      repoRoot,
    });
    expect(r.kind).toBe('ok');
    const sRes = openStore(root);
    if (sRes.kind !== 'ok') throw new Error('store');
    try {
      const rows = sRes.value.db
        .prepare("SELECT source FROM edge WHERE source LIKE '%vendor/%'")
        .all() as Array<{ source: string }>;
      expect(rows).toEqual([]);
    } finally { sRes.value.close(); }
  });
});
