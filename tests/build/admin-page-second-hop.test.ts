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

describe.skipIf(!hasPhpAvailable())('admin-page second-hop traversal', () => {
  const getTmp = useTmpDir('ti-admin-2hop-');

  it('e2e test reaches the callback file, not just the registration file', async () => {
    const root = getTmp();
    write(root, 'menu.php', `<?php
add_submenu_page( 'parent', 'T', 'T', 'cap', 'ti_deletemeelephant_slug', 'ti_deletemeelephant_render_page' );
`);
    write(root, 'render.php', `<?php
function ti_deletemeelephant_render_page() { echo 'hi'; }
`);
    write(root, 'tests/e2e/sample.spec.ts', `
import { test } from '@playwright/test';
test('opens admin', async ({ page }) => {
  await page.goto('wp-admin/admin.php?page=ti_deletemeelephant_slug');
});
`);
    write(root, 'playwright.config.ts', `export default { testDir: 'tests/e2e' };`);

    const cfg = parseConfig({
      confidence: { threshold: 0 },
      // Classify the .spec.ts under tests/e2e/ as playwright (framework_class
      // 'e2e'). Without this, the file falls through to the default jest globs
      // and the framework_class='e2e' WHERE clause below matches nothing.
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
        WHERE t.framework_class = 'e2e'
        ORDER BY e.source
      `).all() as Array<{ source: string }>;
      const sources = rows.map((r) => r.source);
      expect(sources).toContain('menu.php');
      expect(sources).toContain('render.php');
    } finally { s.value.close(); }
  });

  it('reaches the callback file via array(Class::class, "method") across files', async () => {
    const root = getTmp();
    write(root, 'menu.php', `<?php
add_submenu_page( 'parent', 'T', 'T', 'cap', 'ti_deletemeelephant_slug', array( Ti_DeleteMeElephant_Handler::class, 'render_page' ) );
`);
    write(root, 'handler.php', `<?php
class Ti_DeleteMeElephant_Handler {
  public function render_page(): void { echo 'hi'; }
}
`);
    write(root, 'tests/e2e/sample.spec.ts', `
import { test } from '@playwright/test';
test('opens admin', async ({ page }) => {
  await page.goto('wp-admin/admin.php?page=ti_deletemeelephant_slug');
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
        WHERE t.framework_class = 'e2e'
        ORDER BY e.source
      `).all() as Array<{ source: string }>;
      const sources = rows.map((r) => r.source);
      expect(sources).toContain('menu.php');
      // The class lives in handler.php — only reachable via the second-hop
      // symbol-call bridge through the FQN php-symbol:<Class>::<method>
      // anchor. Without the FQN fix, this assertion fails.
      expect(sources).toContain('handler.php');
    } finally { s.value.close(); }
  });

  it('pins symbol-call evidence on the registration-file edge for array($this, "method")', async () => {
    const root = getTmp();
    // For $this-method callbacks the method body and the registration site
    // live in the same file by construction, so no new file appears in the
    // edge set — but the FQN-anchored symbol-use bridges to the same-file
    // symbol-def, adding a 'symbol-call' evidence kind to the existing
    // admin-page-mediated edge. Pin that as the observable signal.
    write(root, 'menu.php', `<?php
class Ti_DeleteMeElephant_Menu {
  public function register(): void {
    add_submenu_page( 'parent', 'T', 'T', 'cap', 'ti_deletemeelephant_slug', array( $this, 'render_page' ) );
  }
  public function render_page(): void { echo 'hi'; }
}
`);
    write(root, 'tests/e2e/sample.spec.ts', `
import { test } from '@playwright/test';
test('opens admin', async ({ page }) => {
  await page.goto('wp-admin/admin.php?page=ti_deletemeelephant_slug');
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
        SELECT e.source, e.evidence FROM edge e
        JOIN test t ON t.test_id = e.test_id
        WHERE t.framework_class = 'e2e' AND e.source = 'menu.php'
      `).all() as Array<{ source: string; evidence: string }>;
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (row === undefined) throw new Error('unreachable: row guarded by toHaveLength above');
      const evidence = JSON.parse(row.evidence) as Array<{ kind: string }>;
      const kinds = evidence.map((e) => e.kind);
      expect(kinds).toContain('admin-page-mediated');
      expect(kinds).toContain('symbol-call');
    } finally { s.value.close(); }
  });
});
