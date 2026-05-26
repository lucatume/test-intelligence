import { describe, it, expect } from 'vitest';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { startPhpWorkerPool } from '../../../src/extract/php/pool.js';
import { hasPhpAvailable } from '../../../src/extract/php/spawn.js';
import { WP_PHP_PATTERNS } from '../../../src/extract/declarative/wp-php-patterns.js';
import { extractPhpFile, flushDeferredPhpFacts } from '../../../src/extract/php/extract.js';
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

  it('synthesizes cross-worker wrappers via the dump/merge barrier', async () => {
    const r = startPhpWorkerPool({ repoRoot, size: 2 });
    if (r.kind !== 'ok') throw new Error('pool failed');
    const pool = r.value;
    try {
      await pool.registerPatterns(WP_PHP_PATTERNS);
      const root = getTmp();
      write(root, 'wrapper.php', `<?php
function register_my_route( $route ) {
    register_rest_route( 'my-plugin/v1', $route, array( 'methods' => 'GET' ) );
}
`);
      write(root, 'a.php', "<?php register_my_route( '/items' );");
      write(root, 'b.php', "<?php register_my_route( '/orders' );");
      // Concurrent dispatch spreads the three files across both slots.
      const perFile = await Promise.all([
        extractPhpFile({ projectRoot: root, relPath: 'wrapper.php', worker: pool }),
        extractPhpFile({ projectRoot: root, relPath: 'a.php', worker: pool }),
        extractPhpFile({ projectRoot: root, relPath: 'b.php', worker: pool }),
      ]);
      // Barrier: gather every worker's wrapper entries, broadcast the union.
      const globalIndex = await pool.dumpWrapperIndex();
      await pool.mergeWrapperIndex(globalIndex);
      const flush = await flushDeferredPhpFacts({ projectRoot: root, worker: pool });

      const restKeys = [...perFile.flat(), ...flush.facts]
        .filter((f) => f.kind === 'rest-endpoint')
        .flatMap((f) => f.anchors.map((a) => a.key))
        .sort();
      expect(restKeys).toEqual([
        'rest:GET /my-plugin/v1/items',
        'rest:GET /my-plugin/v1/orders',
      ]);
      // The wrapper index is persisted once, not once per slot.
      expect(flush.wrapperIndex).toHaveLength(1);
    } finally {
      await pool.shutdown();
    }
  });

  it('fan-outs prepass across slots so the union covers every file', async () => {
    // Two slots, two wrapper files dispatched concurrently — pickSlot's
    // least-busy selection forces one wrapper onto slot 0 and the other onto
    // slot 1. dumpWrapperIndex on the pool gathers from every live slot, so
    // the union is the full set.
    const r = startPhpWorkerPool({ repoRoot, size: 2 });
    if (r.kind !== 'ok') throw new Error('pool failed');
    try {
      await r.value.registerPatterns(WP_PHP_PATTERNS);
      const root = getTmp();
      write(root, 'a.php', `<?php
function ti_route_a( $r ) { register_rest_route( 'a/v1', $r, array( 'methods' => 'GET' ) ); }
`);
      write(root, 'b.php', `<?php
function ti_route_b( $r ) { register_rest_route( 'b/v1', $r, array( 'methods' => 'GET' ) ); }
`);
      await Promise.all([
        r.value.prepass(join(root, 'a.php'), 'a.php'),
        r.value.prepass(join(root, 'b.php'), 'b.php'),
      ]);
      const entries = await r.value.dumpWrapperIndex() as Array<{ wrapperName?: string }>;
      const names = entries.map((e) => e.wrapperName).sort();
      expect(names).toEqual(['ti_route_a', 'ti_route_b']);
    } finally {
      await r.value.shutdown();
    }
  });
});
