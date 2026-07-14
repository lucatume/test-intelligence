import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuild } from '../../src/build/run.js';
import type { BuildSummary } from '../../src/build/types.js';
import { parseConfig } from '../../src/config/parse.js';
import { systemClock } from '../../src/clock.js';
import { hasPhpAvailable } from '../../src/extract/php/spawn.js';
import { useTmpDir } from '../helpers/tmpDir.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const FILES: Record<string, string> = {
  'src/ti_deletemeelephant_lib.php': `<?php
function ti_deletemeelephant_helper_one() {
  return (new Ti_Deletemeelephant_Helper2())->go() + ti_deletemeelephant_helper_three();
}
`,
  'src/ti_deletemeelephant_lib2.php': `<?php
class Ti_Deletemeelephant_Helper2 { public function go() { return 1; } }
`,
  'src/ti_deletemeelephant_other.php': `<?php
function ti_deletemeelephant_other() { return 2; }
`,
  'src/ti_deletemeelephant_third.php': `<?php
function ti_deletemeelephant_third() { return 3; }
`,
  'tests/ti_deletemeelephant_LibTest.php': `<?php
use PHPUnit\\Framework\\TestCase;
class Ti_Deletemeelephant_LibTest extends TestCase {
  public function test_helper() { $this->assertSame(1, ti_deletemeelephant_helper_one()); }
}
`,
  'tests/ti_deletemeelephant_OtherTest.php': `<?php
use PHPUnit\\Framework\\TestCase;
class Ti_Deletemeelephant_OtherTest extends TestCase {
  public function test_other() { $this->assertSame(2, ti_deletemeelephant_other()); }
}
`,
  'tests/ti_deletemeelephant_ThirdTest.php': `<?php
use PHPUnit\\Framework\\TestCase;
class Ti_Deletemeelephant_ThirdTest extends TestCase {
  public function test_third() { $this->assertSame(3, ti_deletemeelephant_third()); }
}
`,
};

function write(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function fixture(path: string): string {
  const body = FILES[path];
  if (body === undefined) throw new Error(`missing fixture: ${path}`);
  return body;
}

function config() {
  const r = parseConfig({ confidence: { threshold: 0 } });
  if (r.kind === 'err') throw new Error('config');
  return r.value;
}

async function build(root: string, onlyPaths?: readonly string[]): Promise<BuildSummary> {
  const r = await runBuild({
    projectRoot: root,
    config: config(),
    clock: systemClock,
    stderr: { write: () => undefined },
    repoRoot,
    ...(onlyPaths === undefined ? {} : { onlyPaths, skipUnchanged: true }),
  });
  if (r.kind === 'err') throw new Error(r.error.message);
  return r.value;
}

function dumpEdges(root: string): string[] {
  const db = new Database(join(root, '.ti', 'store.db'), { readonly: true });
  try {
    const rows = db.prepare(`
      SELECT test_id, source, ROUND(confidence, 6) AS confidence, partial,
        (SELECT GROUP_CONCAT(json_extract(j.value, '$.kind'))
         FROM json_each(edge.evidence) AS j) AS evidence_kinds
      FROM edge ORDER BY test_id, source
    `).all();
    return rows.map((row) => JSON.stringify(row));
  } finally {
    db.close();
  }
}

function testCount(root: string): number {
  const db = new Database(join(root, '.ti', 'store.db'), { readonly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM test').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe.skipIf(!hasPhpAvailable())('scoped derive equivalence gate', () => {
  const getTmp = useTmpDir('ti-scoped-gate-');

  async function assertEquivalence(
    mutate: (root: string) => void,
    changed: readonly string[],
    expectScoped = true,
  ): Promise<void> {
    const root = getTmp();
    for (const [path, body] of Object.entries(FILES)) write(root, path, body);
    await build(root);

    mutate(root);
    const scopedSummary = await build(root, changed);
    const scoped = dumpEdges(root);
    if (expectScoped) {
      expect(scopedSummary.deriveScopedTo).toBeTypeOf('number');
      expect(scopedSummary.deriveScopedTo).toBeLessThan(testCount(root));
    }

    await build(root);
    expect(scoped).toEqual(dumpEdges(root));
    expect(scoped.length).toBeGreaterThan(0);
  }

  it('body-only edit', async () => {
    await assertEquivalence((root) => {
      write(root, 'src/ti_deletemeelephant_lib.php', fixture('src/ti_deletemeelephant_lib.php').replace(
        'return (new', 'return 0 + (new',
      ));
    }, ['src/ti_deletemeelephant_lib.php']);
  });

  it('gained anchor key creates a new bridge', async () => {
    await assertEquivalence((root) => {
      write(root, 'src/ti_deletemeelephant_lib3.php', `<?php
function ti_deletemeelephant_helper_three() { return 0; }
`);
    }, ['src/ti_deletemeelephant_lib3.php']);
  });

  it('removed definition drops its edge', async () => {
    await assertEquivalence((root) => {
      write(root, 'src/ti_deletemeelephant_lib2.php', '<?php // class removed\n');
    }, ['src/ti_deletemeelephant_lib2.php']);
  });

  it('edited test file replaces its test edges', async () => {
    await assertEquivalence((root) => {
      write(root, 'tests/ti_deletemeelephant_LibTest.php', fixture('tests/ti_deletemeelephant_LibTest.php').replace(
        'test_helper()', 'test_helper_renamed()',
      ));
    }, ['tests/ti_deletemeelephant_LibTest.php']);
  });

  it('new test file gains its edges', async () => {
    await assertEquivalence((root) => {
      write(root, 'tests/ti_deletemeelephant_NewTest.php', `<?php
use PHPUnit\\Framework\\TestCase;
class Ti_Deletemeelephant_NewTest extends TestCase {
  public function test_new() { $this->assertSame(1, (new Ti_Deletemeelephant_Helper2())->go()); }
}
`);
    }, ['tests/ti_deletemeelephant_NewTest.php'], false);
  });
});
