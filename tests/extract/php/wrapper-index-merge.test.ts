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

const WRAPPER_SRC = `<?php
function register_my_route( $route ) {
    register_rest_route( 'my-plugin/v1', $route, array( 'methods' => 'GET' ) );
}
`;

describe.skipIf(!hasPhpAvailable())('wrapper index dump/merge', () => {
  const getTmp = useTmpDir('ti-php-wrapidx-');
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

  it('dump-wrapper-index returns this worker auto entries', async () => {
    const root = getTmp();
    write(root, 'wrapper.php', WRAPPER_SRC);
    await extractPhpFile({ projectRoot: root, relPath: 'wrapper.php', worker });
    const entries = await worker.dumpWrapperIndex();
    expect(entries).toHaveLength(1);
    const e = entries[0] as { wrapperName?: string; wraps?: string; kind?: string; source?: string };
    expect(e.wrapperName).toBe('register_my_route');
    expect(e.wraps).toBe('register_rest_route');
    expect(e.kind).toBe('function');
    expect(e.source).toBe('auto');
  });

  it('dump-wrapper-index is empty when no wrappers were seen', async () => {
    const entries = await worker.dumpWrapperIndex();
    expect(entries).toEqual([]);
  });

  it('merge-wrapper-index re-adds entries so the worker can synthesize from them', async () => {
    const root = getTmp();
    write(root, 'wrapper.php', WRAPPER_SRC);
    write(root, 'caller.php', "<?php register_my_route( '/items' );");
    await extractPhpFile({ projectRoot: root, relPath: 'wrapper.php', worker });
    const dumped = await worker.dumpWrapperIndex();
    // Drop the worker's own auto entries; the merge is now the only source.
    await worker.resetState();
    await worker.registerPatterns(WP_PHP_PATTERNS);
    await worker.mergeWrapperIndex(dumped);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'caller.php', worker });
    const rest = facts.filter((f) => f.kind === 'rest-endpoint');
    expect(rest).toHaveLength(1);
    expect(rest[0]?.anchors[0]?.key).toBe('rest:GET /my-plugin/v1/items');
  });

  it('merge-wrapper-index skips entries the worker already holds (idempotent)', async () => {
    const root = getTmp();
    write(root, 'wrapper.php', WRAPPER_SRC);
    await extractPhpFile({ projectRoot: root, relPath: 'wrapper.php', worker });
    const dumped = await worker.dumpWrapperIndex();
    // Reset so the merge is the only path entries enter the index; merging the
    // same dump twice must still leave exactly one entry.
    await worker.resetState();
    await worker.registerPatterns(WP_PHP_PATTERNS);
    await worker.mergeWrapperIndex(dumped);
    await worker.mergeWrapperIndex(dumped);
    const entries = await worker.dumpWrapperIndex();
    expect(entries).toHaveLength(1);
  });
});
