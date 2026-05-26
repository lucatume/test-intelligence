import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPhpWorker, hasPhpAvailable, type PhpWorker } from '../../../src/extract/php/spawn.js';
import { WP_PHP_PATTERNS } from '../../../src/extract/declarative/wp-php-patterns.js';
import { useTmpDir } from '../../helpers/tmpDir.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function write(root: string, rel: string, src: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, src);
}

describe.skipIf(!hasPhpAvailable())('PHP worker prepass op', () => {
  const getTmp = useTmpDir('ti-php-prepass-');
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

  it('prepass populates the wrapper index without emitting facts', async () => {
    const root = getTmp();
    write(root, 'wrapper.php', `<?php
function register_my_route( $route ) {
    register_rest_route( 'my-plugin/v1', $route, array( 'methods' => 'GET' ) );
}
register_my_route( '/items' );
`);
    const abs = join(root, 'wrapper.php');
    await worker.prepass(abs, 'wrapper.php');
    const entries = await worker.dumpWrapperIndex() as Array<{ wrapperName?: string; wraps?: string; kind?: string; source?: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.wrapperName).toBe('register_my_route');
    expect(entries[0]?.wraps).toBe('register_rest_route');
    expect(entries[0]?.source).toBe('auto');
  });

  it('prepass on a parse-error file responds prepass-ok and contributes no entries', async () => {
    const root = getTmp();
    // Truncated PHP — parser cannot recover. Phase-2 extract of the same file
    // would emit a parse-error fact; phase-1 prepass must not.
    write(root, 'broken.php', `<?php function broken( {`);
    const abs = join(root, 'broken.php');
    await expect(worker.prepass(abs, 'broken.php')).resolves.toBeUndefined();
    const entries = await worker.dumpWrapperIndex();
    expect(entries).toEqual([]);
  });

  it('prepass accumulates entries across multiple files', async () => {
    const root = getTmp();
    write(root, 'a.php', `<?php
function ti_route_a( $r ) { register_rest_route( 'a/v1', $r, array( 'methods' => 'GET' ) ); }
`);
    write(root, 'b.php', `<?php
function ti_route_b( $r ) { register_rest_route( 'b/v1', $r, array( 'methods' => 'GET' ) ); }
`);
    await worker.prepass(join(root, 'a.php'), 'a.php');
    await worker.prepass(join(root, 'b.php'), 'b.php');
    const entries = await worker.dumpWrapperIndex() as Array<{ wrapperName?: string }>;
    const names = entries.map((e) => e.wrapperName).sort();
    expect(names).toEqual(['ti_route_a', 'ti_route_b']);
  });
});
