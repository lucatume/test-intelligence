import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk } from '../../src/discover/walk.js';
import { extractFile } from '../../src/extract/index.js';
import { synthesizeCompilerOptions } from '../../src/extract/ts/compiler.js';
import { parseConfig } from '../../src/config/parse.js';
import { startPhpWorker, hasPhpAvailable, type PhpWorker } from '../../src/extract/php/spawn.js';
import { WP_PHP_PATTERNS } from '../../src/extract/declarative/wp-php-patterns.js';
import { useTmpDir } from '../helpers/tmpDir.js';
import type { Fact } from '../../src/facts/types.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function write(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

describe.skipIf(!hasPhpAvailable())('WP integration: hooks/REST/AJAX/scripts + JS clients', () => {
  const getTmp = useTmpDir('ti-wp-integration-');
  let worker: PhpWorker;

  beforeAll(async () => {
    const r = startPhpWorker({ repoRoot });
    if (r.kind !== 'ok') throw new Error(r.error.message);
    worker = r.value;
    await worker.registerPatterns(WP_PHP_PATTERNS);
  });
  beforeEach(async () => {
    // Reset cross-file wrapper state between tests so accumulated wrapperIndex
    // entries from prior tests don't cause duplicate or missing synthesis.
    await worker.resetState();
    await worker.registerPatterns(WP_PHP_PATTERNS);
  });
  afterAll(async () => { await worker.shutdown(); });

  it('extracts a complete fact graph across PHP and JS', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
add_action('init', 'register_my_route');
add_action('wp_enqueue_scripts', 'enqueue_my_script');
add_action('wp_ajax_get_cart', 'handle_get_cart');
function register_my_route() {
  register_rest_route('myplugin/v1', '/items', array());
}
function enqueue_my_script() {
  wp_enqueue_script('my-handle', plugins_url('build/index.js', __FILE__));
}
function handle_get_cart() {}
`);
    write(root, 'src/client.ts', `
import apiFetch from '@wordpress/api-fetch';
apiFetch({ path: '/myplugin/v1/items' });
jQuery.ajax({ url: ajaxurl, data: { action: 'get_cart' } });
`);

    const cfg = parseConfig({});
    if (cfg.kind === 'err') throw new Error('config');
    const opts = synthesizeCompilerOptions(root);

    const anchors = new Set<string>();
    const kinds = new Set<string>();
    const collected: Fact[] = [];
    for await (const file of walk(root, cfg.value)) {
      const r = await extractFile({
        projectRoot: root,
        path: file.path,
        language: file.language,
        framework: file.framework,
        compilerOptions: opts,
        patterns: [],
        phpWorker: worker,
      });
      if (r.kind !== 'ok') continue;
      for (const f of r.value) {
        collected.push(f);
        kinds.add(f.kind);
        for (const a of f.anchors) anchors.add(a.key);
      }
    }

    // PHP-side
    expect(kinds.has('hook-listener')).toBe(true);
    expect(kinds.has('rest-endpoint')).toBe(true);
    expect(kinds.has('enqueue-script')).toBe(true);
    expect(kinds.has('ajax-listener')).toBe(true);
    expect(anchors.has('hook:init')).toBe(true);
    expect(anchors.has('rest:GET /myplugin/v1/items')).toBe(true);
    expect(anchors.has('script-handle:my-handle')).toBe(true);
    expect(anchors.has('ajax:get_cart')).toBe(true);
    // Phase 3: wp_enqueue_script $src resolves to a js-module anchor.
    const enqueueFact = collected.find((f) => f.kind === 'enqueue-script');
    expect(enqueueFact).toBeDefined();
    const moduleAnchor = enqueueFact?.anchors.find(
      (a) => a.role === 'target' && a.key.startsWith('js-module:'),
    );
    expect(moduleAnchor).toBeDefined();
    // plugin.php sits at the project root, so plugins_url('build/index.js',
    // __FILE__) resolves to 'build/index.js' project-relative.
    expect(moduleAnchor?.key).toBe('js-module:build/index.js');
    // JS-side
    expect(kinds.has('rest-call-js')).toBe(true);
    expect(kinds.has('ajax-call-js')).toBe(true);
  });
});
