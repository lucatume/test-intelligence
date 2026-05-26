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

describe.skipIf(!hasPhpAvailable())('admin-page-register callback as symbol-use', () => {
  const getTmp = useTmpDir('ti-admin-page-cb-');
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

  it('emits symbol-use for a literal-string callback', async () => {
    const root = getTmp();
    write(root, 'menu.php', `<?php
add_submenu_page( 'parent', 'Title', 'Title', 'cap', 'ti_deletemeelephant_slug', 'ti_deletemeelephant_render_page' );
`);
    const facts = (await worker.extract(join(root, 'menu.php'), [], 'menu.php')) as { facts: Array<{ kind: string; payload: Record<string, unknown> }> };
    const symbolUses = facts.facts.filter((f) => f.kind === 'symbol-use');
    const cb = symbolUses.find((f) => f.payload['name'] === 'ti_deletemeelephant_render_page');
    expect(cb).toBeDefined();
  });

  it('emits symbol-use for array($this, "method") callback', async () => {
    const root = getTmp();
    write(root, 'menu.php', `<?php
class Ti_Menu {
  public function register(): void {
    add_submenu_page( 'parent', 'T', 'T', 'cap', 'ti_deletemeelephant_slug', array( $this, 'render_page' ) );
  }
}
`);
    const facts = (await worker.extract(join(root, 'menu.php'), [], 'menu.php')) as { facts: Array<{ kind: string; payload: Record<string, unknown> }> };
    const cb = facts.facts.find((f) => f.kind === 'symbol-use' && f.payload['name'] === 'render_page');
    expect(cb).toBeDefined();
  });

  it('emits symbol-use for array(Class::class, "method") callback', async () => {
    const root = getTmp();
    write(root, 'menu.php', `<?php
add_submenu_page( 'parent', 'T', 'T', 'cap', 'ti_deletemeelephant_slug', array( Ti_Renderer::class, 'render_page' ) );
`);
    const facts = (await worker.extract(join(root, 'menu.php'), [], 'menu.php')) as { facts: Array<{ kind: string; payload: Record<string, unknown> }> };
    const cb = facts.facts.find((f) => f.kind === 'symbol-use' && f.payload['name'] === 'render_page');
    expect(cb).toBeDefined();
  });

  it('does not emit symbol-use for closure or variable callback', async () => {
    const root = getTmp();
    write(root, 'menu.php', `<?php
$cb = 'whatever';
add_submenu_page( 'parent', 'T', 'T', 'cap', 'ti_deletemeelephant_slug', function () {} );
add_submenu_page( 'parent2', 'T', 'T', 'cap', 'ti_deletemeelephant_slug2', $cb );
`);
    const facts = (await worker.extract(join(root, 'menu.php'), [], 'menu.php')) as { facts: Array<{ kind: string; anchors: Array<{ key: string }>; payload: Record<string, unknown> }> };
    // Callback-sibling symbol-uses are distinguished by their empty `anchors`
    // (the regular call-site symbol-use for `add_submenu_page` itself carries
    // a `php-symbol:add_submenu_page` target anchor). Filter to siblings only.
    const callbackSiblings = facts.facts.filter(
      (f) => f.kind === 'symbol-use' && f.anchors.length === 0,
    );
    expect(callbackSiblings).toEqual([]);
  });
});
