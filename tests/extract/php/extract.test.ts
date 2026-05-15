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

  it('skips symbol-use for built-in functions, emits for project functions', async () => {
    const root = getTmp();
    write(root, 'helper.php', `<?php
function ti_helper() { return is_array([]); }
ti_helper();
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'helper.php', worker });
    const uses = facts.filter((f) => f.kind === 'symbol-use');
    const names = uses.map((f) => (f.payload as { name?: string }).name);
    expect(names).toContain('ti_helper');
    expect(names).not.toContain('is_array');
  });

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

  it('does not emit symbol-use for PHP built-in classes', async () => {
    // Exception/stdClass/DateTime/Reflection* etc. are PHP language built-ins.
    // Their "uses" never find a project symbol-def, so they only pollute the
    // anchor index (e.g. wordpress-develop: 161 uses of stdClass, 114 of
    // TypeError, 95 of InvalidArgumentException — all dead weight).
    const root = getTmp();
    write(root, 'src/A.php', `<?php
namespace App;
class A {
  public function go(): void {
    throw new \\Exception('x');
    $std = new \\stdClass();
    $r = new \\ReflectionClass(self::class);
    $dt = new \\DateTime();
    $iae = new \\InvalidArgumentException();
  }
}`);
    const facts = await extractPhpFile({
      projectRoot: root,
      relPath: 'src/A.php',
      worker,
    });
    const names = facts
      .filter((f) => f.kind === 'symbol-use')
      .map((u) => (u.payload as { name: string }).name);
    expect(names).not.toContain('Exception');
    expect(names).not.toContain('stdClass');
    expect(names).not.toContain('ReflectionClass');
    expect(names).not.toContain('DateTime');
    expect(names).not.toContain('InvalidArgumentException');
  });

  it('detects classes extending WP-style / WC-style test base classes as phpunit', async () => {
    // wordpress-develop / woocommerce define WP_UnitTestCase, WC_Unit_Test_Case
    // as the project-local phpunit base. Tests don't extend PHPUnit\\TestCase
    // directly. Match by parent-class name suffix so the common WP+WC chain
    // is detected without per-project config. ~1,000 WP test files +
    // hundreds of WC tests recovered by this single heuristic.
    const root = getTmp();
    write(root, 'tests/WPTest.php', `<?php
class Tests_Admin_Menu extends WP_UnitTestCase {
  public function test_something(): void {}
}`);
    write(root, 'tests/WCTest.php', `<?php
class WC_Cart_Test extends WC_Unit_Test_Case {
  public function test_add_item(): void {}
}`);
    const factsA = await extractPhpFile({
      projectRoot: root,
      relPath: 'tests/WPTest.php',
      worker,
    });
    const factsB = await extractPhpFile({
      projectRoot: root,
      relPath: 'tests/WCTest.php',
      worker,
    });
    expect(factsA.find((f) => f.kind === 'test-def')).toBeDefined();
    expect(factsB.find((f) => f.kind === 'test-def')).toBeDefined();
  });

  it('flattens concatenated hook names into a {*} skeleton', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php apply_filters('prefix_' . $context . '_suffix', null);");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const fire = facts.find((f) => f.kind === 'hook-fire');
    expect(fire).toBeDefined();
    expect((fire?.payload as { hook?: string }).hook).toBe('prefix_{*}_suffix');
    expect(fire?.anchors[0]?.key).toBe('hook:prefix_{*}_suffix');
    expect(fire?.resolved).toBe(false);
  });

  it('flattens encapsed (interpolated) hook names into a {*} skeleton', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php do_action(\"wp_ajax_{$action}_done\");");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const fire = facts.find((f) => f.kind === 'hook-fire');
    expect((fire?.payload as { hook?: string }).hook).toBe('wp_ajax_{*}_done');
    expect(fire?.anchors[0]?.key).toBe('hook:wp_ajax_{*}_done');
    expect(fire?.resolved).toBe(false);
  });

  it('resolves ConstFetch via per-file define() table', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
define('TI_HOOK_NAME', 'plugin_init');
do_action(TI_HOOK_NAME);
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const fire = facts.find((f) => f.kind === 'hook-fire');
    expect((fire?.payload as { hook?: string }).hook).toBe('plugin_init');
    expect(fire?.resolved).toBe(true);
    expect(fire?.anchors[0]?.key).toBe('hook:plugin_init');
  });

  it('resolves top-level const declarations', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
const TI_HOOK = 'plugin_boot';
apply_filters(TI_HOOK, null);
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const fire = facts.find((f) => f.kind === 'hook-fire');
    expect((fire?.payload as { hook?: string }).hook).toBe('plugin_boot');
    expect(fire?.resolved).toBe(true);
  });

  it('resolves const declared after use (pre-pass works in both directions)', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
do_action(TI_LATE_HOOK);
define('TI_LATE_HOOK', 'late_one');
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const fire = facts.find((f) => f.kind === 'hook-fire');
    expect((fire?.payload as { hook?: string }).hook).toBe('late_one');
  });

  it('resolves self::CONST inside a class body', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
class TiPluginA {
  const HOOK = 'plugin_init';
  public function boot(): void {
    add_action(self::HOOK, [$this, 'run']);
  }
  public function run(): void {}
}
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const listener = facts.find((f) => f.kind === 'hook-listener');
    expect((listener?.payload as { hook?: string }).hook).toBe('plugin_init');
    expect(listener?.resolved).toBe(true);
    expect(listener?.anchors[0]?.key).toBe('hook:plugin_init');
  });

  it('resolves Class::CONST when class is declared in the same file', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
namespace Acme;
class HookNames {
  const ORDER_SAVED = 'order_saved';
}
class PluginB {
  public function boot(): void {
    add_action(HookNames::ORDER_SAVED, [$this, 'onSaved']);
  }
  public function onSaved(): void {}
}
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const listener = facts.find((f) => f.kind === 'hook-listener');
    expect((listener?.payload as { hook?: string }).hook).toBe('order_saved');
    expect(listener?.resolved).toBe(true);
  });

  it('leaves the fact unresolved when class const cannot be found', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
class PluginC {
  public function boot(): void {
    add_action(External::HOOK, [$this, 'run']);
  }
  public function run(): void {}
}
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const listener = facts.find((f) => f.kind === 'hook-listener');
    // External::HOOK is unknown -> readStringSkeleton returns null -> field absent, resolved=false
    expect(listener?.resolved).toBe(false);
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

  it('emits php-include for require_once with __DIR__-relative literal', async () => {
    const root = getTmp();
    write(root, 'sub/parent.php', "<?php require_once __DIR__ . '/child.php';");
    write(root, 'sub/child.php', "<?php // child");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'sub/parent.php', worker });
    const inc = facts.find((f) => f.kind === 'php-include');
    expect(inc).toBeDefined();
    expect((inc?.payload as { target?: string }).target).toBe('sub/child.php');
    expect(inc?.resolved).toBe(true);
    expect(inc?.anchors[0]?.key).toBe('php-file:sub/child.php');
    expect(inc?.anchors[0]?.role).toBe('target');
  });

  it('emits resolved php-include for a literal relative path', async () => {
    const root = getTmp();
    write(root, 'a/main.php', "<?php require 'a/util.php';");
    write(root, 'a/util.php', "<?php // util");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'a/main.php', worker });
    const inc = facts.find((f) => f.kind === 'php-include');
    expect((inc?.payload as { target?: string }).target).toBe('a/util.php');
    expect(inc?.resolved).toBe(true);
  });

  it('emits unresolved php-include with {*} skeleton when path is dynamic', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php require_once ABSPATH . WPINC . '/version.php';");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const inc = facts.find((f) => f.kind === 'php-include');
    expect(inc).toBeDefined();
    expect((inc?.payload as { target?: string }).target).toMatch(/\{\*\}.*version\.php/);
    expect(inc?.resolved).toBe(false);
  });

  it('emits symbol-use for top-level FuncCall to a named function', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
function ti_deletemeelephant_helper() { return 1; }
ti_deletemeelephant_helper();
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const uses = facts
      .filter((f) => f.kind === 'symbol-use')
      .map((f) => (f.payload as { name?: string }).name);
    expect(uses).toContain('ti_deletemeelephant_helper');
    const use = facts.find(
      (f) => f.kind === 'symbol-use' && (f.payload as { name?: string }).name === 'ti_deletemeelephant_helper',
    );
    expect(use?.anchors[0]?.key).toBe('php-symbol:ti_deletemeelephant_helper');
    expect(use?.anchors[0]?.role).toBe('target');
  });

  it('still emits symbol-use for FuncCall when a declarative pattern also matched', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php add_action('init', 'cb');");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const listenerCount = facts.filter((f) => f.kind === 'hook-listener').length;
    expect(listenerCount).toBe(1);
    const symUseAddAction = facts.find(
      (f) => f.kind === 'symbol-use' && (f.payload as { name?: string }).name === 'add_action',
    );
    // add_action is a built-in; emitting symbol-use is fine — anchor will have no symbol-def partner.
    expect(symUseAddAction).toBeDefined();
  });

  it('does not emit symbol-use for variable callable like $cb()', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php $cb = 'foo'; $cb();");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const uses = facts.filter((f) => f.kind === 'symbol-use');
    // Only class-related uses (none here) — no top-level FuncCall symbol-use because callee isn't a Node\Name
    expect(uses).toEqual([]);
  });

  it('normalizes a REST regex route segment to {*}', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php register_rest_route('wc/v3', '/products/(?P<id>\\\\d+)', []);");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest).toBeDefined();
    expect(rest?.anchors[0]?.key).toBe('rest:GET /wc/v3/products/{*}');
    expect((rest?.payload as { route?: string }).route).toBe('/products/(?P<id>\\d+)');
    // anchor body contains {*} → partial fact
    expect(rest?.resolved).toBe(false);
  });

  it('emits one rest-endpoint per HTTP method when methods is an array', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php register_rest_route('wc/v3', '/items', ['methods' => ['GET', 'POST']]);");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.filter((f) => f.kind === 'rest-endpoint');
    const keys = rest.map((f) => f.anchors[0]?.key).sort();
    expect(keys).toEqual(['rest:GET /wc/v3/items', 'rest:POST /wc/v3/items']);
  });

  it('emits a single rest-endpoint with methods string (comma-separated)', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php register_rest_route('wc/v3', '/items', ['methods' => 'POST, DELETE']);");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.filter((f) => f.kind === 'rest-endpoint');
    const keys = rest.map((f) => f.anchors[0]?.key).sort();
    expect(keys).toEqual(['rest:DELETE /wc/v3/items', 'rest:POST /wc/v3/items']);
  });

  it('strips trailing namespace slash and leading route slash to avoid doubles', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php register_rest_route('wc/v3/', '/items/', []);");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest?.anchors[0]?.key).toBe('rest:GET /wc/v3/items');
  });

  it('defaults to GET when methods is omitted', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php register_rest_route('myplugin/v1', '/items', []);");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.filter((f) => f.kind === 'rest-endpoint');
    expect(rest).toHaveLength(1);
    expect(rest[0]?.anchors[0]?.key).toBe('rest:GET /myplugin/v1/items');
  });

  it('emits enqueue-script for wp_enqueue_style', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php wp_enqueue_style('my-style', '/css/x.css');");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const enq = facts.find((f) => f.kind === 'enqueue-script' && (f.payload as { handle?: string }).handle === 'my-style');
    expect(enq).toBeDefined();
    expect(enq?.anchors[0]?.key).toBe('script-handle:my-style');
  });

  it('emits enqueue-script for wp_register_style', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php wp_register_style('reg-style', '/css/r.css');");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const enq = facts.find((f) => f.kind === 'enqueue-script' && (f.payload as { handle?: string }).handle === 'reg-style');
    expect(enq).toBeDefined();
    expect(enq?.anchors[0]?.key).toBe('script-handle:reg-style');
  });

  it('emits shortcode (target role) for do_shortcode', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php echo do_shortcode('my_tag');");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const sc = facts.find((f) => f.kind === 'shortcode' && f.anchors[0]?.role === 'target');
    expect(sc).toBeDefined();
    expect(sc?.anchors[0]?.key).toBe('shortcode:my_tag');
    expect((sc?.payload as { tag?: string }).tag).toBe('my_tag');
  });

  it('collapses a char-class route param containing a literal paren', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php register_rest_route('wc/v3', '/products/(?P<id>[\\\\d)]+)', []);");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest?.anchors[0]?.key).toBe('rest:GET /wc/v3/products/{*}');
  });

  it('collapses a nested-group route param', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php register_rest_route('wc/v3', '/items/(?P<id>(\\\\d+))', []);");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest?.anchors[0]?.key).toBe('rest:GET /wc/v3/items/{*}');
  });

  it('collapses the unnamed-capture WP route-param form (?<name>...)', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php register_rest_route('wc/v3', '/posts/(?<slug>[a-z-]+)', []);");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest?.anchors[0]?.key).toBe('rest:GET /wc/v3/posts/{*}');
  });

  it('collapses two regex route segments in one route', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php register_rest_route('wc/v3', '/(?P<type>[a-z]+)/(?P<id>\\\\d+)', []);");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest?.anchors[0]?.key).toBe('rest:GET /wc/v3/{*}/{*}');
  });

  it('collapses double slash from an empty namespace', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php register_rest_route('', '/test-empty-namespace', []);");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest?.anchors[0]?.key).toBe('rest:GET /test-empty-namespace');
  });

  it('handles an empty route', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php register_rest_route('myplugin/v1', '', []);");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest?.anchors[0]?.key).toBe('rest:GET /myplugin/v1');
  });

  it('handles both namespace and route empty', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php register_rest_route('', '', []);");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest?.anchors[0]?.key).toBe('rest:GET /');
  });

  it('resolves $this->prop with a string-literal default in a REST route', async () => {
    const root = getTmp();
    write(
      root,
      'controller.php',
      "<?php\nclass Ti_Controller {\n  protected $namespace = 'wp-abilities/v1';\n  protected $rest_base = 'abilities';\n  public function register() {\n    register_rest_route($this->namespace, '/' . $this->rest_base, []);\n  }\n}\n",
    );
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'controller.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest?.anchors[0]?.key).toBe('rest:GET /wp-abilities/v1/abilities');
    expect(rest?.resolved).toBe(true);
  });

  it('resolves a typed property default', async () => {
    const root = getTmp();
    write(
      root,
      'controller.php',
      "<?php\nclass Ti_Typed {\n  protected string $namespace = 'typed/v2';\n  public function register() {\n    register_rest_route($this->namespace, '/items', []);\n  }\n}\n",
    );
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'controller.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest?.anchors[0]?.key).toBe('rest:GET /typed/v2/items');
  });

  it('leaves $this->prop unresolved when the property has no string-literal default', async () => {
    const root = getTmp();
    write(
      root,
      'controller.php',
      "<?php\nclass Ti_NoDefault {\n  protected $namespace;\n  public function register() {\n    register_rest_route($this->namespace, '/items', []);\n  }\n}\n",
    );
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'controller.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest?.anchors[0]?.key).toBe('rest:GET /{*}/items');
    expect(rest?.resolved).toBe(false);
  });

  it('keeps two same-file classes property tables separate', async () => {
    const root = getTmp();
    write(
      root,
      'controllers.php',
      "<?php\nclass Ti_A {\n  protected $namespace = 'ns-a/v1';\n  public function r() { register_rest_route($this->namespace, '/x', []); }\n}\nclass Ti_B {\n  protected $namespace = 'ns-b/v1';\n  public function r() { register_rest_route($this->namespace, '/y', []); }\n}\n",
    );
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'controllers.php', worker });
    const keys = facts.filter((f) => f.kind === 'rest-endpoint').map((f) => f.anchors[0]?.key).sort();
    expect(keys).toEqual(['rest:GET /ns-a/v1/x', 'rest:GET /ns-b/v1/y']);
  });
});
