import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPhpWorker, hasPhpAvailable, type PhpWorker } from '../../../src/extract/php/spawn.js';
import { extractPhpFile } from '../../../src/extract/php/extract.js';
import { WP_PHP_PATTERNS } from '../../../src/extract/declarative/wp-php-patterns.js';
import { useTmpDir } from '../../helpers/tmpDir.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function write(root: string, rel: string, src: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, src);
}

describe.skipIf(!hasPhpAvailable())('extract op wrapperIndexComplete flag', () => {
  const getTmp = useTmpDir('ti-php-wic-');
  let worker: PhpWorker;

  beforeAll(async () => {
    const r = startPhpWorker({ repoRoot });
    if (r.kind !== 'ok') throw new Error(r.error.message);
    worker = r.value;
    await worker.registerPatterns(WP_PHP_PATTERNS);
  });
  beforeEach(async () => {
    await worker.resetState();
    await worker.registerPatterns(WP_PHP_PATTERNS);
  });
  afterAll(async () => { await worker.shutdown(); });

  it('synthesizes via complete index without same-file def and without buffering deferred stubs', async () => {
    // Prepass the wrapper file so the complete index holds the entry. Then
    // extract the caller file with wrapperIndexComplete=true: the live-path
    // check must hit, and no deferred stub may be buffered.
    const root = getTmp();
    write(root, 'wrapper.php', `<?php
function register_my_route( $route ) {
    register_rest_route( 'my-plugin/v1', $route, array( 'methods' => 'GET' ) );
}
`);
    write(root, 'caller.php', `<?php register_my_route( '/items' );`);

    await worker.prepass(join(root, 'wrapper.php'), 'wrapper.php');
    const facts = await extractPhpFile({
      projectRoot: root,
      relPath: 'caller.php',
      worker,
      wrapperIndexComplete: true,
    });
    const rest = facts.filter((f) => f.kind === 'rest-endpoint');
    expect(rest).toHaveLength(1);
    expect(rest[0]?.anchors[0]?.key).toBe('rest:GET /my-plugin/v1/items');
  });

  it('skips buildWrapperIndex when the flag is set (no duplicate entries on re-extract)', async () => {
    const root = getTmp();
    write(root, 'wrapper.php', `<?php
function register_my_route( $route ) {
    register_rest_route( 'my-plugin/v1', $route, array( 'methods' => 'GET' ) );
}
`);
    // Phase 1 populates the index.
    await worker.prepass(join(root, 'wrapper.php'), 'wrapper.php');
    // Phase 2: extract the SAME wrapper file. If buildWrapperIndex still ran,
    // we would get a second auto entry for the same wrapper.
    await extractPhpFile({
      projectRoot: root,
      relPath: 'wrapper.php',
      worker,
      wrapperIndexComplete: true,
    });
    const entries = await worker.dumpWrapperIndex();
    expect(entries).toHaveLength(1);
  });

  it('synthesizes hook-fire facts for wrappers whose names collide with PHP_BUILTIN_FUNCTIONS', async () => {
    // The bug pinned by this test: `delete_option` is in the worker's
    // denylist. Under single-pass + cross-worker scatter, callers on the
    // worker that did not see the wrapper-def file silently drop their
    // hook-fire fact. With wrapperIndexComplete=true the live-path check
    // hits, the denylist gate is bypassed.
    const root = getTmp();
    write(root, 'wrapper.php', `<?php
function delete_option( $name ) {
    do_action( 'ti_deletemeelephant_evt', $name );
}
`);
    write(root, 'caller.php', `<?php delete_option( 'site_name' );`);
    await worker.prepass(join(root, 'wrapper.php'), 'wrapper.php');
    // Drive the caller from a "clean" worker via merge: simulates the
    // multi-worker case where the caller's worker never saw wrapper.php.
    const dump = await worker.dumpWrapperIndex();
    await worker.resetState();
    await worker.registerPatterns(WP_PHP_PATTERNS);
    await worker.mergeWrapperIndex(dump);
    const facts = await extractPhpFile({
      projectRoot: root,
      relPath: 'caller.php',
      worker,
      wrapperIndexComplete: true,
    });
    const hookFires = facts.filter((f) => f.kind === 'hook-fire');
    expect(hookFires).toHaveLength(1);
    expect(hookFires[0]?.anchors.some((a) => a.key === 'hook:ti_deletemeelephant_evt')).toBe(true);
  });
});
