import { describe, it, expect } from 'vitest';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { startPhpWorkerPool } from '../../../src/extract/php/pool.js';
import { hasPhpAvailable } from '../../../src/extract/php/spawn.js';
import { WP_PHP_PATTERNS } from '../../../src/extract/declarative/wp-php-patterns.js';
import { extractPhpFile } from '../../../src/extract/php/extract.js';
import { useTmpDir } from '../../helpers/tmpDir.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function write(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

describe.skipIf(!hasPhpAvailable())('startPhpWorkerPool', () => {
  const getTmp = useTmpDir('ti-php-pool-');

  it('boots N workers and shuts them down cleanly', async () => {
    const r = startPhpWorkerPool({ repoRoot, size: 3 });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const pong = await r.value.ping();
      expect(pong).toBe(true);
      await r.value.shutdown();
    }
  });

  it('registers patterns on every worker (extract works through any slot)', async () => {
    const r = startPhpWorkerPool({ repoRoot, size: 2 });
    if (r.kind !== 'ok') throw new Error('pool failed');
    try {
      const count = await r.value.registerPatterns(WP_PHP_PATTERNS);
      expect(count).toBe(WP_PHP_PATTERNS.length);
      const root = getTmp();
      // Force traffic to both workers — fire 10 concurrent extracts, expect
      // every one to find a hook-listener even though dispatch routes them
      // round-robin / least-busy.
      for (let i = 0; i < 10; i++) {
        write(root, `f${String(i)}.php`, `<?php add_action('init', 'cb${String(i)}');`);
      }
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          extractPhpFile({ projectRoot: root, relPath: `f${String(i)}.php`, worker: r.value }),
        ),
      );
      for (const facts of results) {
        expect(facts.some((f) => f.kind === 'hook-listener')).toBe(true);
      }
    } finally {
      await r.value.shutdown();
    }
  });

  it('dispatches 100 concurrent extracts across pool of 2 without loss', async () => {
    const r = startPhpWorkerPool({ repoRoot, size: 2 });
    if (r.kind !== 'ok') throw new Error('pool failed');
    try {
      await r.value.registerPatterns(WP_PHP_PATTERNS);
      const root = getTmp();
      const N = 100;
      for (let i = 0; i < N; i++) {
        write(root, `f${String(i)}.php`, `<?php register_rest_route('p/v1', '/r${String(i)}', array());`);
      }
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          extractPhpFile({ projectRoot: root, relPath: `f${String(i)}.php`, worker: r.value }),
        ),
      );
      expect(results.length).toBe(N);
      for (const facts of results) {
        expect(facts.some((f) => f.kind === 'rest-endpoint')).toBe(true);
      }
    } finally {
      await r.value.shutdown();
    }
  });

  it('size=1 works (degenerate pool == single worker behavior)', async () => {
    const r = startPhpWorkerPool({ repoRoot, size: 1 });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(await r.value.ping()).toBe(true);
      await r.value.shutdown();
    }
  });

  it('rejects size < 1', () => {
    const r = startPhpWorkerPool({ repoRoot, size: 0 });
    expect(r.kind).toBe('err');
  });
});
