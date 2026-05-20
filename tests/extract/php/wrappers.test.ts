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
    const finalFacts = await flushDeferredPhpFacts({ projectRoot: root, worker });

    // The synthesized fact must come from the flush, not from per-file extraction.
    expect(callerFacts.filter((f) => f.kind === 'rest-endpoint')).toHaveLength(0);
    expect(wrapperFacts.filter((f) => f.kind === 'rest-endpoint')).toHaveLength(0);
    const rest = finalFacts.filter((f) => f.kind === 'rest-endpoint');
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
    const finalFacts = await flushDeferredPhpFacts({ projectRoot: root, worker });

    // Synthesis happens during caller.php's processing; flush returns nothing new.
    expect(finalFacts.filter((f) => f.kind === 'rest-endpoint')).toHaveLength(0);
    const rest = [...wrapperFacts, ...callerFacts].filter((f) => f.kind === 'rest-endpoint');
    expect(rest).toHaveLength(1);
    expect(rest[0]?.anchors[0]?.key).toBe('rest:GET /my-plugin/v1/items');
    expect(rest[0]?.location.file).toBe('caller.php');
  });
});
