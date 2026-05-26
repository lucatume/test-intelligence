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

describe.skipIf(!hasPhpAvailable())('front-end / bare wp-admin URL bridge', () => {
  const getTmp = useTmpDir('ti-frontend-');

  it('page.goto("/wp-admin/edit.php") reaches the core wp-admin/edit.php file', async () => {
    const root = getTmp();
    write(root, 'src/wp-admin/edit.php', `<?php /* core */`);
    write(root, 'tests/e2e/edit.spec.ts', `
import { test } from '@playwright/test';
test('opens edit', async ({ page }) => { await page.goto('/wp-admin/edit.php'); });
`);
    write(root, 'playwright.config.ts', `export default { testDir: 'tests/e2e' };`);

    // Default config has no playwright fileGlobs, so a *.spec.ts file would
    // be classified as jest and frameworkClass='unit'. Set the playwright
    // globs so the discover step labels the spec file 'e2e'.
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
      expect(rows.map((r) => r.source)).toContain('src/wp-admin/edit.php');
    } finally { s.value.close(); }
  });
});
