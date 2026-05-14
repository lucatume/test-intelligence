import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { useTmpDir } from '../helpers/tmpDir.js';
import { hasPhpAvailable } from '../../src/extract/php/spawn.js';
import { runBuild } from '../../src/build/run.js';
import { parseConfig } from '../../src/config/parse.js';
import { systemClock } from '../../src/clock.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function write(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

describe.skipIf(!hasPhpAvailable())('integration: extraction-gap end-to-end', () => {
  const getTmp = useTmpDir('ti-extgap-');

  it('produces php-include, hook-mediated(-uncertain), and shortcode-render evidence', async () => {
    const root = getTmp();

    // Listener: defines a function, registers an add_action + add_shortcode.
    // The listener name `wp_ajax_save_order` matches the wildcard fire
    // skeleton `wp_ajax_{*}` produced from `'wp_ajax_' . $context`.
    write(root, 'src/listener.php', `<?php
function ti_listener() { return 1; }
add_action('wp_ajax_save_order', 'ti_listener');
add_shortcode('ti_tag', 'ti_listener');
`);

    // Fire: requires listener, fires the hook with a concat (wildcard skeleton)
    // and renders a shortcode.
    write(root, 'src/fire.php', `<?php
require_once __DIR__ . '/listener.php';
function ti_fire($context) {
  do_action('wp_ajax_' . $context);
  do_shortcode('ti_tag');
}
`);

    // PHPUnit test that drives the chain.
    write(root, 'tests/MyTest.php', `<?php
namespace Tests;
use PHPUnit\\Framework\\TestCase;
class MyTest extends TestCase {
  public function testIt(): void {
    require_once __DIR__ . '/../src/fire.php';
    ti_fire('save_order');
  }
}
`);

    const cfgRes = parseConfig({ confidence: { threshold: 0 } });
    if (cfgRes.kind === 'err') throw new Error('cfg');

    const r = await runBuild({
      projectRoot: root,
      config: cfgRes.value,
      clock: systemClock,
      stderr: { write: () => {} },
      repoRoot,
    });
    expect(r.kind).toBe('ok');

    const db = new Database(join(root, '.ti/store.db'), { readonly: true });
    try {
      const edges = db
        .prepare('SELECT test_id, source, evidence FROM edge')
        .all() as Array<{ test_id: string; source: string; evidence: string }>;
      const kinds = new Set<string>();
      for (const e of edges) {
        const parsed = JSON.parse(e.evidence) as Array<{ kind: string }>;
        for (const ev of parsed) kinds.add(ev.kind);
      }
      const sources = new Set(edges.map((e) => e.source));
      try {
        expect(sources.has('src/fire.php')).toBe(true);
        expect(sources.has('src/listener.php')).toBe(true);
        expect(kinds.has('php-include')).toBe(true);
        expect(kinds.has('hook-mediated-uncertain') || kinds.has('hook-mediated')).toBe(true);
        expect(kinds.has('shortcode-render')).toBe(true);
      } catch (e) {
        const facts = db.prepare('SELECT id, file_id, kind, resolved FROM fact').all();
        const anchors = db.prepare('SELECT id, key, type FROM anchor').all();
        const factAnchors = db.prepare('SELECT fact_id, anchor_id, role FROM fact_anchor').all();
        console.error('FACTS:', JSON.stringify(facts, null, 2));
        console.error('ANCHORS:', JSON.stringify(anchors, null, 2));
        console.error('FACT_ANCHORS:', JSON.stringify(factAnchors, null, 2));
        console.error('EDGES:', JSON.stringify(edges, null, 2));
        throw e;
      }
    } finally {
      db.close();
    }
  }, 60000);
});
