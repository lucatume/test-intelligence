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

function write(root: string, rel: string, src: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, src);
}

describe.skipIf(!hasPhpAvailable())('Playwright request → PHP REST bridge', () => {
  const getTmp = useTmpDir('ti-pw-rest-');

  it('an e2e spec calling request.get(./wp-json/...) reaches the register_rest_route file', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
add_action( 'rest_api_init', function () {
    register_rest_route( 'ti/v1', '/items', array(
        'methods' => 'GET',
        'callback' => 'ti_deletemeelephant_items_get',
    ) );
} );
function ti_deletemeelephant_items_get() { return array(); }
`);
    write(root, 'tests/e2e/items.spec.ts', `
import { test, expect } from '@playwright/test';
test('list items', async ({ request }) => {
  const res = await request.get('./wp-json/ti/v1/items');
  expect(res.ok()).toBeTruthy();
});
`);
    write(root, 'playwright.config.ts', `export default { testDir: 'tests/e2e' };`);

    const cfg = parseConfig({
      confidence: { threshold: 0 },
      tests: { playwright: { fileGlobs: ['tests/e2e/**/*.spec.ts'] } },
    });
    if (cfg.kind === 'err') throw new Error('cfg');
    const r = await runBuild({
      projectRoot: root, config: cfg.value, clock: systemClock,
      stderr: { write: () => {} }, repoRoot,
    });
    if (r.kind !== 'ok') throw new Error('build failed');

    const s = openStore(root);
    if (s.kind !== 'ok') throw new Error('store');
    try {
      const rows = s.value.db.prepare(`
        SELECT e.source FROM edge e
        JOIN test t ON t.test_id = e.test_id
        JOIN file f ON f.path = e.source
        WHERE t.framework_class = 'e2e' AND f.language = 'php'
      `).all() as Array<{ source: string }>;
      expect(rows.map((r) => r.source)).toContain('plugin.php');
    } finally { s.value.close(); }
  });

  it('reaches a subclass that overrides inherited REST routing properties', async () => {
    const root = getTmp();
    write(root, 'parent.php', `<?php
class Ti_REST_V1_Controller {
  protected $namespace = 'ti/v1';
  protected $rest_base = 'items';
  public function register_routes() {
    register_rest_route($this->namespace, '/' . $this->rest_base, ['methods' => 'GET']);
    register_rest_route($this->namespace, '/' . $this->missing_base, ['methods' => 'GET']);
  }
}
`);
    write(root, 'child.php', `<?php
class Ti_REST_V3_Controller extends Ti_REST_V1_Controller {
  protected $namespace = 'ti/v3';
  protected $rest_base = 'reports';
  public function register_routes() {
    parent::register_routes();
    register_rest_route($this->namespace, '/' . $this->rest_base . '/summary', ['methods' => 'GET']);
  }
}
`);
    write(root, 'tests/e2e/reports.spec.ts', `
import { test } from '@playwright/test';
test('list reports', async ({ request }) => {
  await request.get('./wp-json/ti/v3/reports');
});
test('other route', async ({ request }) => {
  await request.get('./wp-json/ti/v3/other');
});
`);
    const cfg = parseConfig({
      confidence: { threshold: 0 },
      tests: { playwright: { fileGlobs: ['tests/e2e/**/*.spec.ts'] } },
    });
    if (cfg.kind === 'err') throw new Error('cfg');
    const r = await runBuild({
      projectRoot: root, config: cfg.value, clock: systemClock,
      stderr: { write: () => {} }, repoRoot,
    });
    if (r.kind !== 'ok') throw new Error('build failed');

    const s = openStore(root);
    if (s.kind !== 'ok') throw new Error('store');
    try {
      const edge = s.value.db.prepare(`
        SELECT evidence FROM edge
        WHERE source = 'child.php' AND test_id LIKE 'playwright:%list reports'
      `).get() as { evidence: string } | undefined;
      expect(edge).toBeDefined();
      expect(JSON.parse(edge?.evidence ?? '[]')).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'rest-mediated' }),
      ]));
      const unrelated = s.value.db.prepare(`
        SELECT 1 FROM edge
        WHERE source = 'child.php' AND test_id LIKE 'playwright:%other route'
      `).get();
      expect(unrelated).toBeUndefined();
    } finally { s.value.close(); }
  });
});
