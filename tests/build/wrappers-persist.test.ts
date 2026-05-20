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

const getTmp = useTmpDir('ti-build-wrappers-persist-');

it.skipIf(!hasPhpAvailable())(
  'persists wrapper_index entries and wrapper_call_site rows after a build with wrappers',
  async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
function register_my_route( $route ) {
    register_rest_route( 'my-plugin/v1', $route, array( 'methods' => 'GET' ) );
}
register_my_route( '/items' );
`);
    const cfgRes = parseConfig({ confidence: { threshold: 0 } });
    if (cfgRes.kind !== 'ok') throw new Error('config parse failed');

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
      const idxRows = db.prepare(
        'SELECT wrapper_name, wraps, def_file, source FROM wrapper_index',
      ).all() as Array<{ wrapper_name: string; wraps: string; def_file: string; source: string }>;
      expect(idxRows).toEqual([
        {
          wrapper_name: 'register_my_route',
          wraps: 'register_rest_route',
          def_file: 'plugin.php',
          source: 'auto',
        },
      ]);

      const csRows = db.prepare('SELECT COUNT(*) AS n FROM wrapper_call_site').get() as { n: number };
      expect(csRows.n).toBe(1);
    } finally {
      db.close();
    }
  },
);
