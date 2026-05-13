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
});
