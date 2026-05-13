import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPhpWorker, hasPhpAvailable, type PhpWorker } from '../../../src/extract/php/spawn.js';
import { extractPhpFile } from '../../../src/extract/php/extract.js';
import { WP_PHP_PATTERNS } from '../../../src/extract/declarative/wp-php-patterns.js';
import { useTmpDir } from '../../helpers/tmpDir.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function write(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

describe.skipIf(!hasPhpAvailable())('extractPhpFile', () => {
  const getTmp = useTmpDir('ti-extract-php-');
  let worker: PhpWorker;

  beforeAll(async () => {
    const r = startPhpWorker({ repoRoot });
    if (r.kind !== 'ok') throw new Error(r.error.message);
    worker = r.value;
    await worker.registerPatterns(WP_PHP_PATTERNS);
  });
  afterAll(async () => { await worker.shutdown(); });

  it('returns parsed Facts for a hook listener', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php add_action('init', 'my_cb');");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const hook = facts.find((f) => f.kind === 'hook-listener');
    expect(hook).toBeDefined();
    expect(hook?.location.file).toBe('plugin.php');
    const [a] = hook?.anchors ?? [];
    expect(a?.key).toBe('hook:init');
  });

  it('emits rest-endpoint with proper anchor', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php register_rest_route('myplugin/v1', '/items', array());");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest?.anchors[0]?.key).toBe('rest:GET /myplugin/v1/items');
  });

  it('emits PHPUnit test-def for class extending TestCase', async () => {
    const root = getTmp();
    write(root, 'tests/CartTest.php', `<?php
namespace MyPkg\\Tests;
use PHPUnit\\Framework\\TestCase;
class CartTest extends TestCase {
  public function testAdds(): void {}
}`);
    const facts = await extractPhpFile({
      projectRoot: root,
      relPath: 'tests/CartTest.php',
      worker,
    });
    const test = facts.find((f) => f.kind === 'test-def');
    expect(test).toBeDefined();
    expect((test?.payload as { framework: string }).framework).toBe('phpunit');
  });

  it('emits symbol-use for new / extends / static-call / class-const using use-aliased names', async () => {
    // Without symbol-use facts, PHP tests have nothing to bridge from —
    // all phpunit tests dangle. The use-alias case dominates real codebases.
    const root = getTmp();
    write(root, 'tests/CartTest.php', `<?php
namespace App\\Tests;
use App\\Cart;
use App\\Base\\BaseTest;
class CartTest extends BaseTest {
  public function testAdds(): void {
    $c = new Cart();
    Cart::staticDo();
    $n = Cart::NAME;
  }
}`);
    const facts = await extractPhpFile({
      projectRoot: root,
      relPath: 'tests/CartTest.php',
      worker,
    });
    const uses = facts.filter((f) => f.kind === 'symbol-use');
    const names = uses
      .map((u) => (u.payload as { name: string }).name)
      .sort();
    expect(names).toContain('App\\Cart');
    expect(names).toContain('App\\Base\\BaseTest');
    // Anchor key uses php-symbol: so derive's BFS can bridge to symbol-defs.
    const cartUse = uses.find(
      (u) => (u.payload as { name: string }).name === 'App\\Cart',
    );
    expect(cartUse?.anchors[0]?.key).toBe('php-symbol:App\\Cart');
  });

  it('emits symbol-use for fully-qualified names (leading backslash)', async () => {
    const root = getTmp();
    write(root, 'tests/Foo.php', `<?php
namespace App\\Tests;
class Foo {
  public function bar() {
    $x = new \\App\\Cart();
  }
}`);
    const facts = await extractPhpFile({
      projectRoot: root,
      relPath: 'tests/Foo.php',
      worker,
    });
    const names = facts
      .filter((f) => f.kind === 'symbol-use')
      .map((u) => (u.payload as { name: string }).name);
    expect(names).toContain('App\\Cart');
  });

  it('emits symbol-use prepending current namespace for unqualified names', async () => {
    // PHP semantics: inside namespace App, `new Foo()` is `App\Foo` unless
    // a use-statement says otherwise. Our extractor must match.
    const root = getTmp();
    write(root, 'src/A.php', `<?php
namespace App;
class A {
  public function go() { $x = new Helper(); }
}`);
    const facts = await extractPhpFile({
      projectRoot: root,
      relPath: 'src/A.php',
      worker,
    });
    const names = facts
      .filter((f) => f.kind === 'symbol-use')
      .map((u) => (u.payload as { name: string }).name);
    expect(names).toContain('App\\Helper');
  });

  it('test-def uses project-relative paths (not absolute) in testId + anchors', async () => {
    // JS tests use relative paths in their test_id (e.g. `jest:src/foo.test.ts::...`).
    // PHP must match so queries are symmetric and stable across machines.
    const root = getTmp();
    write(root, 'tests/CartTest.php', `<?php
namespace MyPkg\\Tests;
use PHPUnit\\Framework\\TestCase;
class CartTest extends TestCase {
  public function testAdds(): void {}
}`);
    const facts = await extractPhpFile({
      projectRoot: root,
      relPath: 'tests/CartTest.php',
      worker,
    });
    const test = facts.find((f) => f.kind === 'test-def');
    if (!test) throw new Error('no test-def');
    const testId = (test.payload as { testId: string }).testId;
    expect(testId.startsWith('phpunit:tests/CartTest.php::')).toBe(true);
    expect(testId).not.toMatch(/^phpunit:\//);
    const anchor = test.anchors[0];
    expect(anchor?.key.startsWith('test:phpunit:tests/CartTest.php::')).toBe(true);
  });
});
