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
});
