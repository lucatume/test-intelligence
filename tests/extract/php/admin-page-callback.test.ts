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

  it('emits symbol-use anchored at php-symbol:<func> for a literal-string callback', async () => {
    const root = getTmp();
    write(root, 'menu.php', `<?php
add_submenu_page( 'parent', 'Title', 'Title', 'cap', 'ti_deletemeelephant_slug', 'ti_deletemeelephant_render_page' );
`);
    const out = (await worker.extract(join(root, 'menu.php'), [], 'menu.php')) as {
      facts: Array<{ kind: string; anchors: Array<{ key: string; role: string }>; payload: Record<string, unknown> }>;
    };
    const symbolUses = out.facts.filter((f) => f.kind === 'symbol-use');
    const cb = symbolUses.find((f) => f.payload['name'] === 'ti_deletemeelephant_render_page');
    expect(cb).toBeDefined();
    expect(cb?.anchors).toContainEqual({ key: 'php-symbol:ti_deletemeelephant_render_page', role: 'subject' });
  });

  it('emits symbol-use anchored at php-symbol:<Class>::<method> for array($this, "method")', async () => {
    const root = getTmp();
    write(root, 'menu.php', `<?php
class Ti_Menu {
  public function register(): void {
    add_submenu_page( 'parent', 'T', 'T', 'cap', 'ti_deletemeelephant_slug', array( $this, 'render_page' ) );
  }
}
`);
    const out = (await worker.extract(join(root, 'menu.php'), [], 'menu.php')) as {
      facts: Array<{ kind: string; anchors: Array<{ key: string; role: string }>; payload: Record<string, unknown> }>;
    };
    const cb = out.facts.find((f) => f.kind === 'symbol-use' && f.payload['name'] === 'Ti_Menu::render_page');
    expect(cb).toBeDefined();
    expect(cb?.anchors).toContainEqual({ key: 'php-symbol:Ti_Menu::render_page', role: 'subject' });
  });

  it('emits symbol-use anchored at php-symbol:<Class>::<method> for array(Class::class, "method")', async () => {
    const root = getTmp();
    write(root, 'menu.php', `<?php
add_submenu_page( 'parent', 'T', 'T', 'cap', 'ti_deletemeelephant_slug', array( Ti_Renderer::class, 'render_page' ) );
`);
    const out = (await worker.extract(join(root, 'menu.php'), [], 'menu.php')) as {
      facts: Array<{ kind: string; anchors: Array<{ key: string; role: string }>; payload: Record<string, unknown> }>;
    };
    const cb = out.facts.find((f) => f.kind === 'symbol-use' && f.payload['name'] === 'Ti_Renderer::render_page');
    expect(cb).toBeDefined();
    expect(cb?.anchors).toContainEqual({ key: 'php-symbol:Ti_Renderer::render_page', role: 'subject' });
  });

  it('emits symbol-use anchored at php-symbol:<Class>::<method> for array("Class", "method")', async () => {
    const root = getTmp();
    write(root, 'menu.php', `<?php
add_submenu_page( 'parent', 'T', 'T', 'cap', 'ti_deletemeelephant_slug', array( 'Ti_Renderer', 'render_page' ) );
`);
    const out = (await worker.extract(join(root, 'menu.php'), [], 'menu.php')) as {
      facts: Array<{ kind: string; anchors: Array<{ key: string; role: string }>; payload: Record<string, unknown> }>;
    };
    const cb = out.facts.find((f) => f.kind === 'symbol-use' && f.payload['name'] === 'Ti_Renderer::render_page');
    expect(cb).toBeDefined();
    expect(cb?.anchors).toContainEqual({ key: 'php-symbol:Ti_Renderer::render_page', role: 'subject' });
  });

  it('does not emit symbol-use for closure or variable callback', async () => {
    const root = getTmp();
    write(root, 'menu.php', `<?php
$cb = 'whatever';
add_submenu_page( 'parent', 'T', 'T', 'cap', 'ti_deletemeelephant_slug', function () {} );
add_submenu_page( 'parent2', 'T', 'T', 'cap', 'ti_deletemeelephant_slug2', $cb );
`);
    const facts = (await worker.extract(join(root, 'menu.php'), [], 'menu.php')) as { facts: Array<{ kind: string; anchors: Array<{ key: string }>; payload: Record<string, unknown> }> };
    // The extractor still emits the regular call-site symbol-use for
    // `add_submenu_page` itself. Filter that out and assert no callback-sibling
    // symbol-use remains: closure / variable callbacks must not produce a
    // synthetic name to anchor on.
    const callbackSiblings = facts.facts.filter(
      (f) => f.kind === 'symbol-use' && f.payload['name'] !== 'add_submenu_page',
    );
    expect(callbackSiblings).toEqual([]);
  });
});
