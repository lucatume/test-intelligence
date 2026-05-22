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
});
