import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { join, dirname, resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { useTmpDir } from '../helpers/tmpDir.js';
import { runBuild } from '../../src/build/run.js';
import { parseConfig } from '../../src/config/parse.js';
import { systemClock } from '../../src/clock.js';
import { hasPhpAvailable } from '../../src/extract/php/spawn.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function write(root: string, rel: string, src: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, src);
}

const getTmp = useTmpDir('ti-build-wrappers-pool-');

// Regression guard: cross-file wrapper synthesis must survive even when the
// build processes multiple PHP files. Previously a multi-worker pool would
// silently drop deferred stubs when the wrapper-def and caller files landed on
// different workers. A single-file unit test cannot catch this — only a full
// runBuild over several files can.
it.skipIf(!hasPhpAvailable())(
  'synthesizes wrapper facts when wrapper-def and call sites live in different files (full build)',
  async () => {
    const root = getTmp();

    // Wrapper definition in one file.
    write(root, 'lib/wrapper.php', `<?php
function register_my_route( $route ) {
    register_rest_route( 'my-plugin/v1', $route, array( 'methods' => 'GET' ) );
}
`);
    // Multiple caller files — spread across what would have been multiple workers.
    write(root, 'features/a.php', "<?php register_my_route( '/items' );");
    write(root, 'features/b.php', "<?php register_my_route( '/orders' );");
    write(root, 'features/c.php', "<?php register_my_route( '/customers' );");

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

    const db = new Database(join(root, '.ti', 'store.db'), { readonly: true });
    try {
      const restAnchors = db.prepare(
        `SELECT DISTINCT a.key
         FROM anchor a
         JOIN fact_anchor fa ON fa.anchor_id = a.id
         JOIN fact f ON fa.fact_id = f.id
         WHERE f.kind = 'rest-endpoint'
         ORDER BY a.key`,
      ).all() as Array<{ key: string }>;
      expect(restAnchors.map((row) => row.key)).toEqual([
        'rest:GET /my-plugin/v1/customers',
        'rest:GET /my-plugin/v1/items',
        'rest:GET /my-plugin/v1/orders',
      ]);
    } finally {
      db.close();
    }
  },
);
