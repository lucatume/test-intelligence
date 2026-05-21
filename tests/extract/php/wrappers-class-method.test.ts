import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPhpWorker, hasPhpAvailable, type PhpWorker } from '../../../src/extract/php/spawn.js';
import { extractPhpFile, flushDeferredPhpFacts } from '../../../src/extract/php/extract.js';
import { WP_PHP_PATTERNS } from '../../../src/extract/declarative/wp-php-patterns.js';
import { useTmpDir } from '../../helpers/tmpDir.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function write(root: string, rel: string, src: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, src);
}

describe.skipIf(!hasPhpAvailable())('PHP class-method wrappers', () => {
  const getTmp = useTmpDir('ti-php-class-wrappers-');
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

  it('synthesizes at $this->method() inside the same class (same file)', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
class Controller {
    public function register_route( $route ) {
        register_rest_route( 'my-plugin/v1', $route, array( 'methods' => 'GET' ) );
    }
    public function init() {
        $this->register_route( '/items' );
    }
}
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.filter((f) => f.kind === 'rest-endpoint');
    expect(rest).toHaveLength(1);
    expect(rest[0]?.anchors[0]?.key).toBe('rest:GET /my-plugin/v1/items');
    expect(rest[0]?.location.startLine).toBe(7); // line of $this->register_route('/items')
    const meta = (rest[0]?.payload as { meta?: { resolvedBy?: string; wrapperName?: string } }).meta;
    expect(meta?.resolvedBy).toBe('wrapper-auto');
    expect(meta?.wrapperName).toBe('register_route');
  });

  it('synthesizes at Class::method() static call (same file)', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
class Controller {
    public static function register_route( $route ) {
        register_rest_route( 'my-plugin/v1', $route, array( 'methods' => 'GET' ) );
    }
}
Controller::register_route( '/items' );
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.filter((f) => f.kind === 'rest-endpoint');
    expect(rest).toHaveLength(1);
    expect(rest[0]?.anchors[0]?.key).toBe('rest:GET /my-plugin/v1/items');
    expect(rest[0]?.location.startLine).toBe(7); // line of Controller::register_route('/items')
  });

  it('synthesizes at self::method() inside the declaring class', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
class Controller {
    public static function register_route( $route ) {
        register_rest_route( 'my-plugin/v1', $route, array( 'methods' => 'GET' ) );
    }
    public static function init() {
        self::register_route( '/items' );
    }
}
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.filter((f) => f.kind === 'rest-endpoint');
    expect(rest).toHaveLength(1);
    expect(rest[0]?.anchors[0]?.key).toBe('rest:GET /my-plugin/v1/items');
    expect(rest[0]?.location.startLine).toBe(7); // line of self::register_route('/items')
  });

  it('synthesizes at $instance->method() across files via deferred replay', async () => {
    const root = getTmp();
    write(root, 'caller.php', `<?php
(new Controller())->register_route( '/items' );
`);
    write(root, 'wrapper.php', `<?php
class Controller {
    public function register_route( $route ) {
        register_rest_route( 'my-plugin/v1', $route, array( 'methods' => 'GET' ) );
    }
}
`);
    // Caller first — at that point Controller::register_route is unknown.
    // The call is a method call on a non-$this receiver; record it as a
    // deferred stub. Then process the wrapper-def file. Synthesis happens
    // in the end-of-input flush.
    const callerFacts = await extractPhpFile({ projectRoot: root, relPath: 'caller.php', worker });
    const wrapperFacts = await extractPhpFile({ projectRoot: root, relPath: 'wrapper.php', worker });
    const flushResult = await flushDeferredPhpFacts({ projectRoot: root, worker });

    expect(callerFacts.filter((f) => f.kind === 'rest-endpoint')).toHaveLength(0);
    expect(wrapperFacts.filter((f) => f.kind === 'rest-endpoint')).toHaveLength(0);
    const rest = flushResult.facts.filter((f) => f.kind === 'rest-endpoint');
    expect(rest).toHaveLength(1);
    expect(rest[0]?.anchors[0]?.key).toBe('rest:GET /my-plugin/v1/items');
    expect(rest[0]?.location.file).toBe('caller.php');
    expect(rest[0]?.location.startLine).toBe(2);
  });

  it('broadcasts $instance->method() across all classes that define a method with that name', async () => {
    const root = getTmp();
    // Two classes both declare register_route wrapping register_rest_route
    // with different namespaces. An $instance->register_route() call cannot
    // know the receiver's class without flow inference (out of scope for v1),
    // so it must synthesize for BOTH entries. Accepted false-positive: a real
    // call only hits one namespace; the broadcast over-emits but the bridge
    // join self-validates (no listener exists for the wrong namespace).
    write(root, 'plugin.php', `<?php
class ControllerA {
    public function register_route( $route ) {
        register_rest_route( 'plugin-a/v1', $route, array( 'methods' => 'GET' ) );
    }
}
class ControllerB {
    public function register_route( $route ) {
        register_rest_route( 'plugin-b/v1', $route, array( 'methods' => 'GET' ) );
    }
}
function use_some_controller( $c ) {
    $c->register_route( '/items' );
}
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.filter((f) => f.kind === 'rest-endpoint');
    const keys = rest.map((f) => f.anchors[0]?.key).sort();
    expect(keys).toEqual([
      'rest:GET /plugin-a/v1/items',
      'rest:GET /plugin-b/v1/items',
    ]);
  });

  it('does not classify a class method as a wrapper when all inner args are literal (discriminator regression)', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
class Controller {
    public function init() {
        register_rest_route( 'my-plugin/v1', '/items', array( 'methods' => 'GET' ) );
    }
}
class Other {
    public function go() {
        Controller::init();
    }
}
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.filter((f) => f.kind === 'rest-endpoint');
    // Exactly one fact at the register_rest_route call line inside init().
    // No second synthesized fact at Controller::init() — init is not a
    // wrapper because none of register_rest_route's args is param-fed.
    expect(rest).toHaveLength(1);
    expect(rest[0]?.location.startLine).toBe(4);
  });

  it('filters $this->method() to the current class on collision', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
class ControllerA {
    public function register_route( $route ) {
        register_rest_route( 'plugin-a/v1', $route, array( 'methods' => 'GET' ) );
    }
    public function init() {
        $this->register_route( '/items' );
    }
}
class ControllerB {
    public function register_route( $route ) {
        register_rest_route( 'plugin-b/v1', $route, array( 'methods' => 'GET' ) );
    }
}
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.filter((f) => f.kind === 'rest-endpoint');
    // $this->register_route() inside ControllerA::init() must resolve only
    // to ControllerA's wrapper — not ControllerB's. No broadcast on $this.
    expect(rest).toHaveLength(1);
    expect(rest[0]?.anchors[0]?.key).toBe('rest:GET /plugin-a/v1/items');
  });
});
