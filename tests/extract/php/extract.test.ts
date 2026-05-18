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

  it('returns facts when a string literal holds invalid UTF-8 bytes', async () => {
    // A class property default with a binary-marker escape (e.g. MaxMind's
    // "\xab\xcd\xefMaxMind.com") becomes an invalid-UTF-8 byte string in the
    // AST. The worker captures it into meta.props; json_encode of the facts
    // must not fail — a failed encode would emit a bare newline and hang the
    // protocol until the worker is reaped.
    const root = getTmp();
    write(root, 'src/Reader.php', `<?php
namespace App;
class Reader {
  private $marker = "\\xab\\xcd\\xefMaxMind.com";
  public function name() { return 'reader'; }
}`);
    const facts = await extractPhpFile({
      projectRoot: root,
      relPath: 'src/Reader.php',
      worker,
    });
    const def = facts.find(
      (f) => f.kind === 'symbol-def' && (f.payload as { name?: string }).name === 'App\\Reader',
    );
    expect(def).toBeDefined();
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
    // {*} came from a route param, not a skeleton → the fact is resolved.
    expect(rest?.resolved).toBe(true);
  });

  it('marks a route-param-only rest-endpoint resolved with routeParam set', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php register_rest_route('wp/v2', '/comments/(?P<id>\\\\d+)', []);");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest?.anchors[0]?.key).toBe('rest:GET /wp/v2/comments/{*}');
    expect(rest?.resolved).toBe(true);
    expect((rest?.payload as { routeParam?: boolean }).routeParam).toBe(true);
  });

  it('keeps a skeleton-namespace rest-endpoint unresolved without routeParam', async () => {
    const root = getTmp();
    // $x is not statically known → readStringSkeleton yields {*}.
    write(root, 'plugin.php', "<?php function f($x){ register_rest_route($x, '/items', []); }");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest?.resolved).toBe(false);
    expect((rest?.payload as { routeParam?: boolean }).routeParam).toBeUndefined();
  });

  it('keeps a fully-literal rest-endpoint resolved with no routeParam', async () => {
    const root = getTmp();
    write(root, 'plugin.php', "<?php register_rest_route('wp/v2', '/items', []);");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest?.resolved).toBe(true);
    expect((rest?.payload as { routeParam?: boolean }).routeParam).toBeUndefined();
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

  it('resolves a constructor-assigned property used in a REST route', async () => {
    const root = getTmp();
    write(
      root,
      'controller.php',
      "<?php\nclass Ti_Ctor {\n  protected $namespace;\n  protected $rest_base;\n  public function __construct() {\n    $this->namespace = 'ctor/v1';\n    $this->rest_base = 'widgets';\n  }\n  public function register() {\n    register_rest_route($this->namespace, '/' . $this->rest_base, []);\n  }\n}\n",
    );
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'controller.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest?.anchors[0]?.key).toBe('rest:GET /ctor/v1/widgets');
    expect(rest?.resolved).toBe(true);
  });

  it('lets a constructor assignment override a literal default', async () => {
    const root = getTmp();
    write(
      root,
      'controller.php',
      "<?php\nclass Ti_Override {\n  protected $namespace = 'old/v1';\n  public function __construct() {\n    $this->namespace = 'new/v2';\n  }\n  public function register() {\n    register_rest_route($this->namespace, '/items', []);\n  }\n}\n",
    );
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'controller.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest?.anchors[0]?.key).toBe('rest:GET /new/v2/items');
  });

  it('does not record a $this->prop assignment nested inside a conditional', async () => {
    const root = getTmp();
    write(
      root,
      'controller.php',
      "<?php\nclass Ti_Cond {\n  protected $namespace;\n  public function __construct() {\n    if (true) { $this->namespace = 'cond/v1'; }\n  }\n  public function register() {\n    register_rest_route($this->namespace, '/items', []);\n  }\n}\n",
    );
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'controller.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest?.anchors[0]?.key).toBe('rest:GET /{*}/items');
    expect(rest?.resolved).toBe(false);
  });

  it('leaves a property unresolved when two top-level assignments disagree', async () => {
    const root = getTmp();
    write(
      root,
      'controller.php',
      "<?php\nclass Ti_Ambig {\n  protected $namespace;\n  public function __construct() {\n    $this->namespace = 'a/v1';\n    $this->namespace = 'b/v2';\n  }\n  public function register() {\n    register_rest_route($this->namespace, '/items', []);\n  }\n}\n",
    );
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'controller.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest?.anchors[0]?.key).toBe('rest:GET /{*}/items');
    expect(rest?.resolved).toBe(false);
  });

  it('honors a property assigned in a non-constructor method', async () => {
    const root = getTmp();
    write(
      root,
      'controller.php',
      "<?php\nclass Ti_InitMethod {\n  protected $namespace;\n  public function init() {\n    $this->namespace = 'init/v1';\n  }\n  public function register() {\n    register_rest_route($this->namespace, '/items', []);\n  }\n}\n",
    );
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'controller.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest?.anchors[0]?.key).toBe('rest:GET /init/v1/items');
  });

  it('resolves a self::CONST property assignment via the class-const table', async () => {
    const root = getTmp();
    write(
      root,
      'controller.php',
      "<?php\nclass Ti_ConstRhs {\n  const NS = 'const/v3';\n  protected $namespace;\n  public function __construct() {\n    $this->namespace = self::NS;\n  }\n  public function register() {\n    register_rest_route($this->namespace, '/items', []);\n  }\n}\n",
    );
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'controller.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest?.anchors[0]?.key).toBe('rest:GET /const/v3/items');
  });

  it('keeps two same-file classes constructor-assigned tables separate', async () => {
    const root = getTmp();
    write(
      root,
      'controllers.php',
      "<?php\nclass Ti_CtorA {\n  protected $namespace;\n  public function __construct() { $this->namespace = 'ctor-a/v1'; }\n  public function r() { register_rest_route($this->namespace, '/x', []); }\n}\nclass Ti_CtorB {\n  protected $namespace;\n  public function __construct() { $this->namespace = 'ctor-b/v1'; }\n  public function r() { register_rest_route($this->namespace, '/y', []); }\n}\n",
    );
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'controllers.php', worker });
    const keys = facts.filter((f) => f.kind === 'rest-endpoint').map((f) => f.anchors[0]?.key).sort();
    expect(keys).toEqual(['rest:GET /ctor-a/v1/x', 'rest:GET /ctor-b/v1/y']);
  });

  it('emits class symbol-def with meta.props for string-literal properties', async () => {
    const root = getTmp();
    write(root, 'controller.php', "<?php class C { protected $namespace = 'wp/v2'; protected $rest_base = 'items'; }");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'controller.php', worker });
    const def = facts.find((f) => f.kind === 'symbol-def' && (f.payload as { name?: string }).name === 'C');
    expect(def).toBeDefined();
    const props = (def?.payload as { meta?: { props?: Record<string, string> } }).meta?.props;
    expect(props).toEqual({ namespace: 'wp/v2', rest_base: 'items' });
  });

  it('omits meta.props when a class has no string-literal properties', async () => {
    const root = getTmp();
    write(root, 'plain.php', '<?php class Plain { protected $count = 0; }');
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plain.php', worker });
    const def = facts.find((f) => f.kind === 'symbol-def' && (f.payload as { name?: string }).name === 'Plain');
    expect((def?.payload as { meta?: unknown }).meta).toBeUndefined();
  });

  it('tags the extends symbol-use with meta.rel=extends, untagged for implements', async () => {
    const root = getTmp();
    write(root, 'child.php', '<?php interface I {} class Base {} class Child extends Base implements I {}');
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'child.php', worker });
    const uses = facts.filter((f) => f.kind === 'symbol-use');
    const baseUse = uses.find((f) => (f.payload as { name?: string }).name === 'Base');
    const ifaceUse = uses.find((f) => (f.payload as { name?: string }).name === 'I');
    expect((baseUse?.payload as { meta?: { rel?: string } }).meta?.rel).toBe('extends');
    expect((ifaceUse?.payload as { meta?: unknown }).meta).toBeUndefined();
  });

  it('annotates rest-endpoint with the unresolved block when namespace is a $this->prop miss', async () => {
    const root = getTmp();
    write(root, 'ctl.php', "<?php class Ctl { public function reg(){ register_rest_route($this->namespace, '/items', []); } }");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'ctl.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest?.resolved).toBe(false);
    const u = (rest?.payload as { unresolved?: {
      scope?: string; fields?: { field: string; expression: string }[]; exprHash?: string;
    } }).unresolved;
    expect(u?.scope).toBe('Ctl::reg');
    expect(u?.fields).toEqual([{ field: 'namespace', expression: '$this->namespace' }]);
    expect(u?.exprHash?.length).toBe(64);
  });

  it('does not annotate unresolved for a non-property concat skeleton', async () => {
    const root = getTmp();
    write(root, 'ns.php', "<?php function f($x){ register_rest_route('wp/v2', '/' . $x, []); }");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'ns.php', worker });
    const rest = facts.find((f) => f.kind === 'rest-endpoint');
    expect(rest?.resolved).toBe(false);
    expect((rest?.payload as { unresolved?: unknown }).unresolved).toBeUndefined();
  });

  it('extracts an admin-page-register fact from a literal add_submenu_page slug', async () => {
    const root = getTmp();
    write(root, 'menus.php', "<?php add_submenu_page( 'woocommerce', 'Settings', 'Settings', 'manage_woocommerce', 'wc-settings', array( $this, 'settings_page' ) );");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'menus.php', worker });
    const reg = facts.filter((f) => f.kind === 'admin-page-register');
    expect(reg).toHaveLength(1);
    expect(reg[0]?.payload).toMatchObject({ kind: 'admin-page-register', slug: 'wc-settings', fn: 'add_submenu_page' });
    expect(reg[0]?.resolved).toBe(true);
    expect(reg[0]?.anchors).toContainEqual({ key: 'wp-admin-page:wc-settings', role: 'subject' });
  });

  it('extracts a concat-head slug from add_submenu_page as a wildcard-tail anchor', async () => {
    const root = getTmp();
    write(root, 'orders.php', "<?php add_submenu_page( 'woocommerce', 'Orders', 'Orders', 'edit_posts', 'wc-orders' . ( $x ? '' : '--' . $t ), array( $this, 'output' ) );");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'orders.php', worker });
    const reg = facts.filter((f) => f.kind === 'admin-page-register');
    expect(reg).toHaveLength(1);
    expect((reg[0]?.payload as { slug?: string }).slug).toBe('wc-orders{*}');
    expect(reg[0]?.resolved).toBe(false);
    expect(reg[0]?.anchors).toContainEqual({ key: 'wp-admin-page:wc-orders{*}', role: 'subject' });
  });

  it('extracts add_menu_page slug at the correct arg index', async () => {
    const root = getTmp();
    write(root, 'menu.php', "<?php add_menu_page( 'Sales reports', 'Sales reports', 'view_woocommerce_reports', 'wc-reports', array( $this, 'reports_page' ) );");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'menu.php', worker });
    const reg = facts.filter((f) => f.kind === 'admin-page-register');
    expect(reg).toHaveLength(1);
    expect(reg[0]?.payload).toMatchObject({ slug: 'wc-reports', fn: 'add_menu_page' });
  });

  it('emits no admin-page-register fact when the slug is fully dynamic', async () => {
    const root = getTmp();
    write(root, 'dyn.php', "<?php add_menu_page( $title, $title, $cap, $options['path'], array( __CLASS__, 'page_wrapper' ) );");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'dyn.php', worker });
    expect(facts.filter((f) => f.kind === 'admin-page-register')).toHaveLength(0);
  });

  // --- H1: PHP local-variable assignment tracking (depth-1, intra-function) ---

  it('resolves a do_action hook from a top-level local-variable assignment', async () => {
    const root = getTmp();
    write(root, 'h1.php', "<?php function ti_fire() { $hook = 'save_post'; do_action( $hook ); }");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'h1.php', worker });
    const hook = facts.find((f) => f.kind === 'hook-fire');
    expect(hook?.resolved).toBe(true);
    expect(hook?.anchors).toContainEqual({ key: 'hook:save_post', role: 'target' });
  });

  it('resolves a local variable inside an encapsed hook string', async () => {
    const root = getTmp();
    write(root, 'h1enc.php', "<?php function ti_fire() { $suffix = 'block-editor-assets'; do_action( \"admin_print_styles-{$suffix}\" ); }");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'h1enc.php', worker });
    const hook = facts.find((f) => f.kind === 'hook-fire');
    expect(hook?.resolved).toBe(true);
    expect(hook?.anchors).toContainEqual({ key: 'hook:admin_print_styles-block-editor-assets', role: 'target' });
  });

  it('resolves __FUNCTION__ in a concatenated hook name (method scope)', async () => {
    const root = getTmp();
    write(root, 'h1fn.php', "<?php class WC_Cart { function get_cart() { do_action( 'woocommerce_cart_' . __FUNCTION__ ); } }");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'h1fn.php', worker });
    const hook = facts.find((f) => f.kind === 'hook-fire');
    expect(hook?.resolved).toBe(true);
    expect(hook?.anchors).toContainEqual({ key: 'hook:woocommerce_cart_get_cart', role: 'target' });
  });

  it('resolves __FUNCTION__ in a concatenated hook name (function scope)', async () => {
    const root = getTmp();
    write(root, 'h1fnf.php', "<?php function ti_fire() { do_action( 'ti_event_' . __FUNCTION__ ); }");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'h1fnf.php', worker });
    const hook = facts.find((f) => f.kind === 'hook-fire');
    expect(hook?.resolved).toBe(true);
    expect(hook?.anchors).toContainEqual({ key: 'hook:ti_event_ti_fire', role: 'target' });
  });

  it('resolves an add_action hook from a local-variable assignment', async () => {
    const root = getTmp();
    write(root, 'h1add.php', "<?php function ti_listen() { $h = 'wp_ajax_thing'; add_action( $h, 'cb' ); }");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'h1add.php', worker });
    const hook = facts.find((f) => f.kind === 'hook-listener');
    expect(hook?.resolved).toBe(true);
    expect(hook?.anchors).toContainEqual({ key: 'hook:wp_ajax_thing', role: 'subject' });
  });

  it('leaves a free variable (function parameter) unresolved', async () => {
    const root = getTmp();
    write(root, 'h1free.php', "<?php function ti_fire( $block_type ) { do_action( \"x_{$block_type}\" ); }");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'h1free.php', worker });
    const hook = facts.find((f) => f.kind === 'hook-fire');
    expect(hook?.resolved).toBe(false);
    expect((hook?.payload as { hook?: string }).hook).toBe('x_{*}');
  });

  it('ignores a branch re-assignment so the top-level value stands', async () => {
    const root = getTmp();
    write(root, 'h1cond.php', "<?php function ti_fire( $c ) { $h = 'a'; if ( $c ) { $h = 'b'; } do_action( $h ); }");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'h1cond.php', worker });
    const hook = facts.find((f) => f.kind === 'hook-fire');
    expect(hook?.resolved).toBe(true);
    expect(hook?.anchors).toContainEqual({ key: 'hook:a', role: 'target' });
  });

  it('poisons a variable assigned two differing top-level literals', async () => {
    const root = getTmp();
    write(root, 'h1poison.php', "<?php function ti_fire() { $h = 'a'; $h = 'b'; do_action( $h ); }");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'h1poison.php', worker });
    const hook = facts.find((f) => f.kind === 'hook-fire');
    // A poisoned bare $var resolves to nothing: no hook payload, no anchor —
    // never the single colliding hook:{*} anchor.
    expect(hook?.resolved).toBe(false);
    expect((hook?.payload as { hook?: string }).hook).toBeUndefined();
    expect(hook?.anchors).toEqual([]);
  });

  it('treats two identical top-level assignments as idempotent', async () => {
    const root = getTmp();
    write(root, 'h1idem.php', "<?php function ti_fire() { $h = 'a'; $h = 'a'; do_action( $h ); }");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'h1idem.php', worker });
    const hook = facts.find((f) => f.kind === 'hook-fire');
    expect(hook?.resolved).toBe(true);
    expect(hook?.anchors).toContainEqual({ key: 'hook:a', role: 'target' });
  });

  it('scopes local variables per function — no cross-contamination', async () => {
    const root = getTmp();
    write(root, 'h1scope.php', "<?php function ti_one() { $h = 'one'; do_action( $h ); } function ti_two() { $h = 'two'; do_action( $h ); }");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'h1scope.php', worker });
    const hooks = facts.filter((f) => f.kind === 'hook-fire');
    const keys = hooks.flatMap((h) => h.anchors.map((a) => a.key)).sort();
    expect(keys).toEqual(['hook:one', 'hook:two']);
  });

  it('resolves a const-backed local-variable assignment', async () => {
    const root = getTmp();
    write(root, 'h1const.php', "<?php const TI_HOOK = 'init'; function ti_fire() { $h = TI_HOOK; do_action( $h ); }");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'h1const.php', worker });
    const hook = facts.find((f) => f.kind === 'hook-fire');
    expect(hook?.resolved).toBe(true);
    expect(hook?.anchors).toContainEqual({ key: 'hook:init', role: 'target' });
  });

  it('does not resolve a variable assigned inside a closure body', async () => {
    const root = getTmp();
    write(root, 'h1closure.php', "<?php function ti_outer() { $h = 'outer'; add_action( 'init', function () { $h = 'inner'; do_action( $h ); } ); }");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'h1closure.php', worker });
    const fire = facts.find((f) => f.kind === 'hook-fire');
    // The closure body opens no scope; $h there resolves to nothing — no
    // anchor, never the outer 'outer' value and never a colliding hook:{*}.
    expect(fire?.resolved).toBe(false);
    expect((fire?.payload as { hook?: string }).hook).toBeUndefined();
    expect(fire?.anchors).toEqual([]);
  });

  // --- H6: callback-name-convention block names ---

  it('infers a block name from a render_block_core_ callback in register_block_type_from_metadata', async () => {
    const root = getTmp();
    write(root, 'h6meta.php', "<?php register_block_type_from_metadata( __DIR__ . '/social-link', array( 'render_callback' => 'render_block_core_social_link' ) );");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'h6meta.php', worker });
    const block = facts.find((f) => f.kind === 'block-render');
    expect(block?.resolved).toBe(true);
    expect(block?.anchors).toContainEqual({ key: 'block:core/social-link', role: 'subject' });
  });

  it('converts callback underscores to hyphens in the inferred block slug', async () => {
    const root = getTmp();
    write(root, 'h6slug.php', "<?php register_block_type_from_metadata( __DIR__ . '/post-terms', array( 'render_callback' => 'render_block_core_post_terms' ) );");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'h6slug.php', worker });
    const block = facts.find((f) => f.kind === 'block-render');
    expect(block?.anchors).toContainEqual({ key: 'block:core/post-terms', role: 'subject' });
  });

  it('leaves a block unresolved when the callback is not the core convention', async () => {
    const root = getTmp();
    write(root, 'h6miss.php', "<?php register_block_type_from_metadata( __DIR__ . '/x', array( 'render_callback' => 'my_plugin_render' ) );");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'h6miss.php', worker });
    const block = facts.find((f) => f.kind === 'block-render');
    expect(block?.resolved).toBe(false);
    expect(block?.anchors).toEqual([]);
  });

  it('leaves a block unresolved when the render_callback is a closure', async () => {
    const root = getTmp();
    write(root, 'h6closure.php', "<?php register_block_type_from_metadata( __DIR__ . '/x', array( 'render_callback' => function () {} ) );");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'h6closure.php', worker });
    const block = facts.find((f) => f.kind === 'block-render');
    expect(block?.resolved).toBe(false);
  });

  it('keeps a literal register_block_type name over the callback convention', async () => {
    const root = getTmp();
    write(root, 'h6lit.php', "<?php register_block_type( 'core/foo', array( 'render_callback' => 'render_block_core_bar' ) );");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'h6lit.php', worker });
    const block = facts.find((f) => f.kind === 'block-render');
    expect(block?.resolved).toBe(true);
    expect(block?.anchors).toContainEqual({ key: 'block:core/foo', role: 'subject' });
  });

  it('infers a block name for register_block_type with a dynamic name + convention callback', async () => {
    const root = getTmp();
    write(root, 'h6var.php', "<?php function ti_reg( $n ) { register_block_type( $n, array( 'render_callback' => 'render_block_core_quote' ) ); }");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'h6var.php', worker });
    const block = facts.find((f) => f.kind === 'block-render');
    expect(block?.resolved).toBe(true);
    expect(block?.anchors).toContainEqual({ key: 'block:core/quote', role: 'subject' });
  });

  // --- block.json reader: directory capture ---

  it('captures the resolved __DIR__ directory of register_block_type_from_metadata as payload.dir', async () => {
    const root = getTmp();
    write(root, 'sub/loader.php', "<?php register_block_type_from_metadata( __DIR__ . '/paragraph' );");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'sub/loader.php', worker });
    const block = facts.find((f) => f.kind === 'block-render');
    expect(block?.resolved).toBe(false);
    expect(block?.anchors).toEqual([]);
    expect((block?.payload as { dir?: string }).dir).toBe('sub/paragraph');
  });

  it('captures a bare __DIR__ directory argument', async () => {
    const root = getTmp();
    write(root, 'blocks/foo/index.php', "<?php register_block_type( __DIR__ );");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'blocks/foo/index.php', worker });
    const block = facts.find((f) => f.kind === 'block-render');
    expect((block?.payload as { dir?: string }).dir).toBe('blocks/foo');
  });

  it('omits dir when the metadata argument is a non-literal variable', async () => {
    const root = getTmp();
    write(root, 'var.php', "<?php function reg( $p ) { register_block_type_from_metadata( $p ); }");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'var.php', worker });
    const block = facts.find((f) => f.kind === 'block-render');
    expect((block?.payload as { dir?: string }).dir).toBeUndefined();
  });

  it('omits dir when arg-0 already resolves the block name', async () => {
    const root = getTmp();
    write(root, 'lit.php', "<?php register_block_type( 'core/foo', array() );");
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'lit.php', worker });
    const block = facts.find((f) => f.kind === 'block-render');
    expect(block?.resolved).toBe(true);
    expect((block?.payload as { dir?: string }).dir).toBeUndefined();
  });

  it('stamps the unresolved block on a dynamic do_action', async () => {
    const root = getTmp();
    write(root, 'h.php', `<?php
class Widget {
  public function run($hook) { do_action($hook); }
}
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'h.php', worker });
    const fire = facts.find((f) => f.kind === 'hook-fire');
    expect(fire?.resolved).toBe(false);
    const u = (fire?.payload as { unresolved?: {
      scope: string; fields: { field: string; expression: string }[]; exprHash: string;
    } }).unresolved;
    expect(u?.scope).toBe('Widget::run');
    expect(u?.fields[0]).toEqual({ field: 'hook', expression: '$hook' });
    expect(typeof u?.exprHash).toBe('string');
    expect(u?.exprHash.length).toBe(64);
  });

  it('emits no unresolved block on a literal do_action', async () => {
    const root = getTmp();
    write(root, 'h2.php', `<?php do_action('init');`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'h2.php', worker });
    const fire = facts.find((f) => f.kind === 'hook-fire');
    expect(fire?.resolved).toBe(true);
    expect((fire?.payload as { unresolved?: unknown }).unresolved).toBeUndefined();
  });

  it('captures a concat expression on add_action', async () => {
    const root = getTmp();
    write(root, 'h3.php', `<?php add_action('woo_' . $context, 'cb');`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'h3.php', worker });
    const listener = facts.find((f) => f.kind === 'hook-listener');
    const u = (listener?.payload as { unresolved?: {
      fields: { expression: string }[];
    } }).unresolved;
    expect(u?.fields[0]?.expression).toBe("'woo_' . $context");
  });

  it('stamps a multi-field unresolved block on a dynamic register_rest_route', async () => {
    const root = getTmp();
    write(root, 'r.php', `<?php
class Api {
  public function reg() {
    register_rest_route($this->ns, $this->route, array());
  }
}
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'r.php', worker });
    const ep = facts.find((f) => f.kind === 'rest-endpoint');
    expect(ep?.resolved).toBe(false);
    const u = (ep?.payload as { unresolved?: {
      scope: string; fields: { field: string }[];
    } }).unresolved;
    expect(u?.scope).toBe('Api::reg');
    expect(u?.fields.map((f) => f.field).sort()).toEqual(['ns', 'route']);
  });

  it('resolves scope for free function, file scope, and closure', async () => {
    const root = getTmp();
    write(root, 's.php', `<?php
function fire_it($h) { do_action($h); }
do_action($topLevel);
add_action('boot', function () use ($cb) { do_action($cb); });
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 's.php', worker });
    const fires = facts.filter((f) => f.kind === 'hook-fire' && !f.resolved);
    const scopes = fires.map(
      (f) => (f.payload as { unresolved?: { scope: string } }).unresolved?.scope,
    );
    expect(scopes.filter((s) => s === 'fire_it').length).toBe(1);
    expect(scopes.filter((s) => s === '(file)').length).toBe(2);
  });

  it('exprHash is stable across an unrelated edit, changes on an expression edit', async () => {
    const root = getTmp();
    const hashOf = async (src: string): Promise<string> => {
      write(root, 'st.php', src);
      const facts = await extractPhpFile({ projectRoot: root, relPath: 'st.php', worker });
      const u = (facts.find((f) => f.kind === 'hook-fire')?.payload as
        { unresolved?: { exprHash: string } }).unresolved;
      return u?.exprHash ?? '';
    };

    const base = await hashOf(`<?php
class W { function run($hook) { do_action($hook); } }
`);
    const afterUnrelated = await hashOf(`<?php
function brand_new_helper() { return 1; }
class W { function run($hook) { do_action($hook); } }
`);
    expect(afterUnrelated).toBe(base);

    const afterExprEdit = await hashOf(`<?php
class W { function run($h) { do_action($h); } }
`);
    expect(afterExprEdit).not.toBe(base);
  });

  // --- PHP dynamic-registration unrolling ---

  it('unrolls a foreach over an inline array literal into one hook-listener per element', async () => {
    const root = getTmp();
    write(root, 'ajax.php', `<?php
foreach ( array( 'add_to_cart', 'remove_from_cart' ) as $event ) {
  add_action( 'wp_ajax_' . $event, 'cb' );
}`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'ajax.php', worker });
    const listeners = facts.filter((f) => f.kind === 'hook-listener');
    const keys = listeners.flatMap((f) => f.anchors.map((a) => a.key)).sort();
    expect(keys).toEqual(['hook:wp_ajax_add_to_cart', 'hook:wp_ajax_remove_from_cart']);
    expect(listeners.every((f) => f.resolved)).toBe(true);
  });

  it('unrolls a foreach over an array-literal variable', async () => {
    const root = getTmp();
    write(root, 'ajax.php', `<?php
$events = array( 'apply_coupon', 'remove_coupon' );
foreach ( $events as $event ) {
  add_action( 'wp_ajax_' . $event, 'cb' );
}`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'ajax.php', worker });
    const listeners = facts.filter((f) => f.kind === 'hook-listener');
    const keys = listeners.flatMap((f) => f.anchors.map((a) => a.key)).sort();
    expect(keys).toEqual(['hook:wp_ajax_apply_coupon', 'hook:wp_ajax_remove_coupon']);
    expect(listeners.every((f) => f.resolved)).toBe(true);
  });

  it('unrolls an interpolated (encapsed) hook name', async () => {
    const root = getTmp();
    write(root, 'ajax.php', `<?php
foreach ( array( 'checkout', 'payment' ) as $event ) {
  do_action( "wp_ajax_{$event}_done" );
}`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'ajax.php', worker });
    const fires = facts.filter((f) => f.kind === 'hook-fire');
    const keys = fires.flatMap((f) => f.anchors.map((a) => a.key)).sort();
    expect(keys).toEqual(['hook:wp_ajax_checkout_done', 'hook:wp_ajax_payment_done']);
    expect(fires.every((f) => f.resolved)).toBe(true);
  });
});
