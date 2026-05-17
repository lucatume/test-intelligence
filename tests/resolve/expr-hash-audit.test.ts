// Phase-1 Task 1 — expressionHash availability audit (go/no-go gate).
//
// RESULT: PASS. Phase 0 shipped the partial-fact resolution context. The
// stable per-expression hash for an unresolved `hook-fire` / `hook-listener`
// fact lives at `payload.unresolved.exprHash` (sha256 hex). The companion
// fields are `payload.unresolved.scope` and `payload.unresolved.fields[]`
// (each `{ field, expression }`). The plan's pre-Phase-0 field names
// (`expressionHash`, `unresolvedExpression`, `enclosingScope`) map onto this
// `unresolved` block — every later task reads `<HASH_FIELD>` =
// `payload.unresolved.exprHash`.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPhpWorker, hasPhpAvailable, type PhpWorker } from '../../src/extract/php/spawn.js';
import { extractPhpFile } from '../../src/extract/php/extract.js';
import { WP_PHP_PATTERNS } from '../../src/extract/declarative/wp-php-patterns.js';
import { useTmpDir } from '../helpers/tmpDir.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function write(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

describe.skipIf(!hasPhpAvailable())('expressionHash audit — hook-fire / hook-listener', () => {
  const getTmp = useTmpDir('ti-expr-hash-audit-');
  let worker: PhpWorker;

  beforeAll(async () => {
    const r = startPhpWorker({ repoRoot });
    if (r.kind !== 'ok') throw new Error(r.error.message);
    worker = r.value;
    await worker.registerPatterns(WP_PHP_PATTERNS);
  });
  afterAll(async () => { await worker.shutdown(); });

  it('unresolved hook-fire facts carry a non-empty stable expression hash', async () => {
    const source = `<?php
function ti_fire() {
  $hook = something();
  do_action($hook);
}`;
    const root1 = getTmp();
    write(root1, 'a.php', source);
    const facts1 = await extractPhpFile({ projectRoot: root1, relPath: 'a.php', worker });
    const hook1 = facts1.find((f) => f.kind === 'hook-fire' && !f.resolved);
    expect(hook1).toBeDefined();
    const u1 = (hook1?.payload as { unresolved?: { exprHash?: string } }).unresolved;
    expect(u1?.exprHash).toBeTypeOf('string');
    expect(u1?.exprHash).not.toBe('');

    // Byte-identical source extracted again must yield the same hash.
    const root2 = getTmp();
    write(root2, 'a.php', source);
    const facts2 = await extractPhpFile({ projectRoot: root2, relPath: 'a.php', worker });
    const hook2 = facts2.find((f) => f.kind === 'hook-fire' && !f.resolved);
    const u2 = (hook2?.payload as { unresolved?: { exprHash?: string } }).unresolved;
    expect(u2?.exprHash).toBe(u1?.exprHash);
  });

  it('unresolved hook-listener facts carry the same unresolved block shape', async () => {
    const root = getTmp();
    write(root, 'b.php', `<?php
function ti_listen() {
  $x = ctx();
  add_action('woo_' . $x, 'cb');
}`);
    const facts = await extractPhpFile({ projectRoot: root, relPath: 'b.php', worker });
    const listener = facts.find((f) => f.kind === 'hook-listener' && !f.resolved);
    expect(listener).toBeDefined();
    const u = (listener?.payload as {
      unresolved?: { exprHash?: string; scope?: string; fields?: unknown[] };
    }).unresolved;
    expect(u?.exprHash).toBeTypeOf('string');
    expect(u?.exprHash).not.toBe('');
    expect(u?.scope).toBeTypeOf('string');
    expect(Array.isArray(u?.fields)).toBe(true);
  });
});
