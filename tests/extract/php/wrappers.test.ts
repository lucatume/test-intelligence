import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPhpWorker, hasPhpAvailable, type PhpWorker } from '../../../src/extract/php/spawn.js';
import { extractPhpFile, flushDeferredPhpFacts } from '../../../src/extract/php/extract.js';
import { WP_PHP_PATTERNS } from '../../../src/extract/declarative/wp-php-patterns.js';
import { useTmpDir } from '../../helpers/tmpDir.js';
import type { WpPatternWrapper } from '../../../src/types.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function write(root: string, rel: string, src: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, src);
}

describe.skipIf(!hasPhpAvailable())('PHP pattern wrappers', () => {
  const getTmp = useTmpDir('ti-php-wrappers-');
  let worker: PhpWorker;

  beforeAll(async () => {
    const r = startPhpWorker({ repoRoot });
    if (r.kind !== 'ok') throw new Error(r.error.message);
    worker = r.value;
    await worker.registerPatterns(WP_PHP_PATTERNS);
  });
  beforeEach(async () => {
    // Reset cross-file wrapper state between tests so accumulated wrapperIndex
    // entries from prior tests don't cause duplicate synthesis.
    await worker.resetState();
    await worker.registerPatterns(WP_PHP_PATTERNS);
  });
  afterAll(async () => { await worker.shutdown(); });

  it('synthesizes a rest-endpoint at the call site of a direct-call wrapper (same file)', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
function register_my_route( $route ) {
    register_rest_route( 'my-plugin/v1', $route, array( 'methods' => 'GET' ) );
}
register_my_route( '/items' );
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.filter((f) => f.kind === 'rest-endpoint');
    expect(rest).toHaveLength(1);
    expect(rest[0]?.anchors[0]?.key).toBe('rest:GET /my-plugin/v1/items');
    expect(rest[0]?.location.startLine).toBe(5); // line of register_my_route(...) call, not register_rest_route inside the wrapper
    const meta = (rest[0]?.payload as { meta?: { resolvedBy?: string; wrapperDef?: { file?: string; startLine?: number } } }).meta;
    expect(meta?.resolvedBy).toBe('wrapper-auto');
    expect(meta?.wrapperDef?.file).toBe('plugin.php');
    expect(meta?.wrapperDef?.startLine).toBe(2); // line of `function register_my_route( $route ) {`
  });

  it('synthesizes a fact when the wrapper call appears lexically before the wrapper definition', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
register_my_route( '/items' );
function register_my_route( $route ) {
    register_rest_route( 'my-plugin/v1', $route, array( 'methods' => 'GET' ) );
}
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.filter((f) => f.kind === 'rest-endpoint');
    expect(rest).toHaveLength(1);
    expect(rest[0]?.anchors[0]?.key).toBe('rest:GET /my-plugin/v1/items');
    expect(rest[0]?.location.startLine).toBe(2);
  });

  it('synthesizes a fact via end-of-input flush when the caller file is processed before the wrapper-def file', async () => {
    const root = getTmp();
    write(root, 'caller.php', `<?php
register_my_route( '/items' );
`);
    write(root, 'wrapper.php', `<?php
function register_my_route( $route ) {
    register_rest_route( 'my-plugin/v1', $route, array( 'methods' => 'GET' ) );
}
`);
    // Process the caller first (the call has no known callee), then the wrapper-def.
    // The synthesis must happen in the end-of-input flush.
    const callerFacts = await extractPhpFile({ projectRoot: root, relPath: 'caller.php', worker });
    const wrapperFacts = await extractPhpFile({ projectRoot: root, relPath: 'wrapper.php', worker });
    const flushResult = await flushDeferredPhpFacts({ projectRoot: root, worker });

    // The synthesized fact must come from the flush, not from per-file extraction.
    expect(callerFacts.filter((f) => f.kind === 'rest-endpoint')).toHaveLength(0);
    expect(wrapperFacts.filter((f) => f.kind === 'rest-endpoint')).toHaveLength(0);
    const rest = flushResult.facts.filter((f) => f.kind === 'rest-endpoint');
    expect(rest).toHaveLength(1);
    expect(rest[0]?.anchors[0]?.key).toBe('rest:GET /my-plugin/v1/items');
    expect(rest[0]?.location.file).toBe('caller.php');
    expect(rest[0]?.location.startLine).toBe(2);
  });

  it('synthesizes immediately during file processing when the wrapper-def file was processed first', async () => {
    // Regression guard for the cheap path (wrapper-def precedes caller).
    const root = getTmp();
    write(root, 'wrapper.php', `<?php
function register_my_route( $route ) {
    register_rest_route( 'my-plugin/v1', $route, array( 'methods' => 'GET' ) );
}
`);
    write(root, 'caller.php', `<?php
register_my_route( '/items' );
`);
    const wrapperFacts = await extractPhpFile({ projectRoot: root, relPath: 'wrapper.php', worker });
    const callerFacts = await extractPhpFile({ projectRoot: root, relPath: 'caller.php', worker });
    const flushResult = await flushDeferredPhpFacts({ projectRoot: root, worker });

    // Synthesis happens during caller.php's processing; flush returns nothing new.
    expect(flushResult.facts.filter((f) => f.kind === 'rest-endpoint')).toHaveLength(0);
    const rest = [...wrapperFacts, ...callerFacts].filter((f) => f.kind === 'rest-endpoint');
    expect(rest).toHaveLength(1);
    expect(rest[0]?.anchors[0]?.key).toBe('rest:GET /my-plugin/v1/items');
    expect(rest[0]?.location.file).toBe('caller.php');
  });

  it('detects a wrapper whose register_rest_route lives inside an add_action closure', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
function register_my_route( $route ) {
    add_action( 'rest_api_init', function () use ( $route ) {
        register_rest_route( 'my-plugin/v1', $route, array( 'methods' => 'GET' ) );
    });
}
register_my_route( '/items' );
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.filter((f) => f.kind === 'rest-endpoint');
    expect(rest).toHaveLength(1);
    expect(rest[0]?.anchors[0]?.key).toBe('rest:GET /my-plugin/v1/items');
    expect(rest[0]?.location.startLine).toBe(7); // line of register_my_route('/items') call
  });

  it('correctly maps closure use($name) to the outer function param of the same name', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
function register_with_meta( $route, $version ) {
    add_action( 'rest_api_init', function () use ( $route, $version ) {
        register_rest_route( 'my-plugin/' . $version, $route, array( 'methods' => 'GET' ) );
    });
}
register_with_meta( '/items', 'v2' );
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.filter((f) => f.kind === 'rest-endpoint');
    // Non-literal namespace (string concat with a variable) disqualifies the
    // wrapper entry. The inner register_rest_route call still emits an unresolved
    // fact (namespace skeleton has {*}, route unresolvable in closure scope).
    // Documents the v1 limitation: no resolved anchor is synthesized.
    expect(rest).toHaveLength(1);
    expect((rest[0] as { resolved: boolean }).resolved).toBe(false);
    expect(rest[0]?.anchors).toHaveLength(0);
  });

  it('handles multi-param wrappers where every wrapped arg is param-fed', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
function register_two( $ns, $route ) {
    add_action( 'rest_api_init', function () use ( $ns, $route ) {
        register_rest_route( $ns, $route, array( 'methods' => 'POST' ) );
    });
}
register_two( 'p/v1', '/x' );
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.filter((f) => f.kind === 'rest-endpoint');
    expect(rest).toHaveLength(1);
    expect(rest[0]?.anchors[0]?.key).toBe('rest:POST /p/v1/x');
  });

  it('one wrapper body with two register_rest_route calls produces two facts per call site', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
function register_pair( $route ) {
    register_rest_route( 'p/v1', $route, array( 'methods' => 'GET' ) );
    register_rest_route( 'p/v1', $route, array( 'methods' => 'POST' ) );
}
register_pair( '/items' );
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const keys = facts.filter((f) => f.kind === 'rest-endpoint').map((f) => f.anchors[0]?.key).sort();
    expect(keys).toEqual(['rest:GET /p/v1/items', 'rest:POST /p/v1/items']);
  });

  it('synthesizes via array_merge defaults when caller omits the merged key', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
function register_my_route( $route, $callback, $extras = array() ) {
    $defaults = array( 'methods' => 'POST', 'callback' => $callback );
    $opts     = array_merge( $defaults, $extras );
    register_rest_route( 'my-plugin/v1', $route, $opts );
}
register_my_route( '/items', 'cb' );
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.filter((f) => f.kind === 'rest-endpoint');
    expect(rest).toHaveLength(1);
    expect(rest[0]?.anchors[0]?.key).toBe('rest:POST /my-plugin/v1/items');
  });

  it('caller override wins over wrapper defaults via array_merge semantics', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
function register_my_route( $route, $extras = array() ) {
    $opts = array_merge( array( 'methods' => 'POST' ), $extras );
    register_rest_route( 'my-plugin/v1', $route, $opts );
}
register_my_route( '/items', array( 'methods' => 'DELETE' ) );
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const rest = facts.filter((f) => f.kind === 'rest-endpoint');
    expect(rest).toHaveLength(1);
    expect(rest[0]?.anchors[0]?.key).toBe('rest:DELETE /my-plugin/v1/items');
  });

  it('uses a user-configured wrapper before any file defines one', async () => {
    const userWrapper: WpPatternWrapper = {
      name: 'my_external_wrapper',
      wraps: 'register_rest_route',
      argSpecs: [
        { kind: 'fixed', value: 'external/v1' },
        { kind: 'param', wrapperParamIdx: 0 },
        { kind: 'fixed', value: { methods: 'POST' } },
      ],
    };
    const startRes = startPhpWorker({ repoRoot, wpPatternWrappers: [userWrapper] });
    if (startRes.kind !== 'ok') throw new Error(startRes.error.message);
    const localWorker = startRes.value;
    try {
      await localWorker.registerPatterns(WP_PHP_PATTERNS);
      const root = getTmp();
      write(root, 'caller.php', "<?php my_external_wrapper( '/items' );");
      const facts = await extractPhpFile({ projectRoot: root, relPath: 'caller.php', worker: localWorker });
      const finalFacts = await localWorker.flushDeferred();
      const all = [...facts, ...(finalFacts as { facts?: { kind: string; anchors: { key: string }[] }[] }).facts ?? []];
      const rest = all.filter((f) => (f as { kind: string }).kind === 'rest-endpoint');
      expect(rest).toHaveLength(1);
      expect((rest[0] as { anchors: { key: string }[] }).anchors[0]?.key).toBe('rest:POST /external/v1/items');
    } finally {
      await localWorker.shutdown();
    }
  });

  it('user config wins over auto-detect when names collide', async () => {
    const userWrapper: WpPatternWrapper = {
      name: 'register_my_route',
      wraps: 'register_rest_route',
      argSpecs: [
        { kind: 'fixed', value: 'user-overridden/v1' },
        { kind: 'param', wrapperParamIdx: 0 },
        { kind: 'fixed', value: { methods: 'GET' } },
      ],
    };
    const startRes = startPhpWorker({ repoRoot, wpPatternWrappers: [userWrapper] });
    if (startRes.kind !== 'ok') throw new Error(startRes.error.message);
    const localWorker = startRes.value;
    try {
      await localWorker.registerPatterns(WP_PHP_PATTERNS);
      const root = getTmp();
      write(root, 'plugin.php', `<?php
function register_my_route( $route ) {
    register_rest_route( 'auto-detected/v1', $route, array( 'methods' => 'POST' ) );
}
register_my_route( '/items' );
`);
      const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker: localWorker });
      const flushResult = await flushDeferredPhpFacts({ projectRoot: root, worker: localWorker });
      const rest = [...facts, ...flushResult.facts].filter((f) => f.kind === 'rest-endpoint');
      // Exactly one fact, with the user-config namespace and method.
      expect(rest).toHaveLength(1);
      expect(rest[0]?.anchors[0]?.key).toBe('rest:GET /user-overridden/v1/items');
    } finally {
      await localWorker.shutdown();
    }
  });

  it('flows WP_REST_Server::EDITABLE through the merged options to multi-fact fan-out', async () => {
    const root = getTmp();
    write(root, 'plugin.php', `<?php
function register_my_route( $route, $extras = array() ) {
    $opts = array_merge( array( 'methods' => 'POST' ), $extras );
    register_rest_route( 'my-plugin/v1', $route, $opts );
}
register_my_route( '/items', array( 'methods' => WP_REST_Server::EDITABLE ) );
`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'plugin.php', worker });
    const keys = facts.filter((f) => f.kind === 'rest-endpoint').map((f) => f.anchors[0]?.key).sort();
    expect(keys).toEqual([
      'rest:PATCH /my-plugin/v1/items',
      'rest:POST /my-plugin/v1/items',
      'rest:PUT /my-plugin/v1/items',
    ]);
  });
});
