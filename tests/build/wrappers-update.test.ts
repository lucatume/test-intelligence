import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { useTmpDir } from '../helpers/tmpDir.js';
import { runBuild } from '../../src/build/run.js';
import { fixedClock } from '../../src/clock.js';
import type { ISODate } from '../../src/types.js';
import { parseConfig } from '../../src/config/parse.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const getTmp = useTmpDir('ti-build-wrappers-update-');

function write(root: string, rel: string, src: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
}

const wrapperGetSrc = `<?php
function register_my_route( $route ) {
    register_rest_route( 'my-plugin/v1', $route, array( 'methods' => 'GET' ) );
}
`;

const wrapperPostSrc = `<?php
function register_my_route( $route ) {
    register_rest_route( 'my-plugin/v1', $route, array( 'methods' => 'POST' ) );
}
`;

const callerSrc = `<?php
register_my_route( '/items' );
`;

it('re-extracts callers when their wrapper definition changes', async () => {
  const root = getTmp();
  write(root, 'wrapper.php', wrapperGetSrc);
  write(root, 'caller.php', callerSrc);
  const cfg = parseConfig({});
  if (cfg.kind !== 'ok') throw new Error('config');
  const clock = fixedClock('2026-05-20T00:00:00.000Z' as ISODate);
  const baseOpts = {
    projectRoot: root,
    config: cfg.value,
    clock,
    stderr: { write: () => undefined },
    repoRoot,
  };
  await runBuild(baseOpts);

  write(root, 'wrapper.php', wrapperPostSrc);
  await runBuild({ ...baseOpts, onlyPaths: ['wrapper.php'] });

  const db = new Database(join(root, '.ti', 'store.db'), { readonly: true });
  const restRows = db.prepare(
    "SELECT payload FROM fact WHERE kind='rest-endpoint'"
  ).all() as Array<{ payload: string }>;
  expect(restRows).toHaveLength(1);
  const first = restRows[0];
  if (first === undefined) throw new Error('no rest-endpoint row');
  const payload = JSON.parse(first.payload) as { method: string };
  expect(payload.method).toBe('POST');
  db.close();
});
