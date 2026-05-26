import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
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

interface EdgeRow { readonly testId: string; readonly source: string; readonly confidence: number; }

function seedFixture(root: string): void {
  // PHP side: 8 admin-page registrations across separate files so phpWorkers=4
  // scatters them. Each registers a distinct slug.
  for (let i = 0; i < 8; i++) {
    const slug = `ti_deletemeelephant_slug_${String(i)}`;
    write(root, `wp/menu_${String(i)}.php`, `<?php
add_submenu_page( 'parent', 'T', 'T', 'cap', '${slug}', 'ti_deletemeelephant_render_${String(i)}' );
function ti_deletemeelephant_render_${String(i)}() { echo 'r${String(i)}'; }
`);
  }
  // E2E side: 8 Playwright specs, each visiting one of the slugs above.
  for (let i = 0; i < 8; i++) {
    write(root, `tests/e2e/spec_${String(i)}.spec.ts`, `
import { test } from '@playwright/test';
test('opens slug ${String(i)}', async ({ page }) => {
  await page.goto('wp-admin/admin.php?page=ti_deletemeelephant_slug_${String(i)}');
});
`);
  }
  write(root, 'playwright.config.ts', `export default { testDir: 'tests/e2e' };`);
}

async function buildAndDumpE2eToPhpEdges(root: string, workers: number): Promise<readonly EdgeRow[]> {
  const cfg = parseConfig({
    tests: { playwright: { fileGlobs: ['tests/e2e/**/*.spec.ts'] } },
    concurrency: { phpWorkers: workers },
    confidence: { threshold: 0 },
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
      SELECT e.test_id AS testId, e.source AS source, e.confidence AS confidence
      FROM edge e
      JOIN test t ON t.test_id = e.test_id
      JOIN file f ON f.path = e.source
      WHERE t.framework_class = 'e2e' AND f.language = 'php'
      ORDER BY e.test_id, e.source
    `).all() as EdgeRow[];
    return rows;
  } finally { s.value.close(); }
}

describe.skipIf(!hasPhpAvailable())('e2e→PHP edges are deterministic', () => {
  const getTmp = useTmpDir('ti-e2e-php-determ-');

  it('phpWorkers=1 and phpWorkers=4 produce identical edge rows', async () => {
    const root = getTmp();
    seedFixture(root);
    const one = await buildAndDumpE2eToPhpEdges(root, 1);
    rmSync(join(root, '.ti'), { recursive: true, force: true });
    const four = await buildAndDumpE2eToPhpEdges(root, 4);

    expect(one.length).toBeGreaterThan(0);
    expect(four).toEqual(one);
  });

  it('two cold builds at phpWorkers=4 produce byte-identical edge rows', async () => {
    const root = getTmp();
    seedFixture(root);
    const first = await buildAndDumpE2eToPhpEdges(root, 4);
    rmSync(join(root, '.ti'), { recursive: true, force: true });
    const second = await buildAndDumpE2eToPhpEdges(root, 4);

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });
});
