import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, symlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { walk } from '../../src/discover/walk.js';
import { parseConfig } from '../../src/config/parse.js';
import { useTmpDir } from '../helpers/tmpDir.js';
import type { ValidatedConfig } from '../../src/config/parse.js';
import type { DiscoveredFile } from '../../src/discover/types.js';

const cfg = (() => {
  const r = parseConfig({});
  if (r.kind === 'err') throw new Error('default config');
  return r.value;
})();

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

async function collect(root: string, c: ValidatedConfig = cfg): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  for await (const f of walk(root, c)) out.push(f);
  return out;
}

describe('walk', () => {
  const getTmp = useTmpDir('ti-walk-');

  it('discovers ts and php files; classifies tests', async () => {
    const root = getTmp();
    write(root, 'src/cart.ts', 'export const x = 1;');
    write(root, 'src/cart.php', '<?php class Cart {}');
    write(root, 'tests/cart.test.ts', 'it("x", () => {});');
    write(root, 'tests/CartTest.php', '<?php class CartTest {}');
    const files = await collect(root);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual([
      'src/cart.php',
      'src/cart.ts',
      'tests/CartTest.php',
      'tests/cart.test.ts',
    ]);
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get('tests/cart.test.ts' as never)?.framework).toBe('jest');
    expect(byPath.get('tests/CartTest.php' as never)?.framework).toBe('phpunit');
    expect(byPath.get('src/cart.ts' as never)?.framework).toBeNull();
  });

  it('skips ignore globs entirely', async () => {
    const root = getTmp();
    write(root, 'src/a.ts', '');
    write(root, 'node_modules/foo/index.js', '');
    write(root, 'dist/cli.js', '');
    write(root, 'build/x.js', '');
    const files = await collect(root);
    expect(files.map((f) => f.path).sort()).toEqual(['src/a.ts']);
  });

  it('skips nested node_modules / dist / build in monorepo layouts', async () => {
    // pnpm/Yarn workspaces place node_modules under every package — the
    // default ignore patterns must match those, not just the top-level dir.
    const root = getTmp();
    write(root, 'packages/a/src/x.ts', '');
    write(root, 'packages/a/node_modules/lib/index.js', '');
    write(root, 'plugins/b/src/y.ts', '');
    write(root, 'plugins/b/dist/y.js', '');
    write(root, 'tools/c/build/c.js', '');
    write(root, 'deep/very/deep/node_modules/.pnpm/pkg/index.js', '');
    const files = await collect(root);
    expect(files.map((f) => f.path).sort()).toEqual([
      'packages/a/src/x.ts',
      'plugins/b/src/y.ts',
    ]);
  });

  it('marks vendor files', async () => {
    const root = getTmp();
    write(root, 'vendor/acme/cart.php', '<?php');
    write(root, 'src/cart.php', '<?php');
    const files = await collect(root);
    const vendorMap = new Map(files.map((f) => [f.path, f.vendor]));
    expect(vendorMap.get('vendor/acme/cart.php' as never)).toBe(true);
    expect(vendorMap.get('src/cart.php' as never)).toBe(false);
  });

  it('does not classify vendor files as tests', async () => {
    // Vendor packages ship their own test suites (e.g. PHPCSUtils' tests).
    // Treating those as "your project's tests" pollutes the test table and
    // produces noise like 3,000 dangling phpunit tests on woocommerce.
    const root = getTmp();
    write(root, 'vendor/acme/tests/AcmeTest.php', '<?php class AcmeTest {}');
    write(root, 'tests/CartTest.php', '<?php class CartTest {}');
    const files = await collect(root);
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get('vendor/acme/tests/AcmeTest.php' as never)?.framework).toBeNull();
    expect(byPath.get('vendor/acme/tests/AcmeTest.php' as never)?.frameworkClass).toBeNull();
    expect(byPath.get('tests/CartTest.php' as never)?.framework).toBe('phpunit');
  });

  it('skips unsupported extensions', async () => {
    const root = getTmp();
    write(root, 'README.md', '');
    write(root, 'src/a.ts', '');
    write(root, 'package.json', '{}');
    const files = await collect(root);
    expect(files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('descends symlinks pointing inside the root', async () => {
    const root = getTmp();
    write(root, 'real/a.ts', 'export {};');
    symlinkSync('real', join(root, 'linked'));
    const files = await collect(root);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toContain('real/a.ts');
    expect(paths).toContain('linked/a.ts');
  });

  it('skips symlinks pointing outside the root', async () => {
    const root = getTmp();
    write(root, 'src/a.ts', '');
    const outside = mkdtempSync(join(tmpdir(), 'ti-outside-'));
    mkdirSync(join(outside, 'sub'));
    writeFileSync(join(outside, 'sub', 'leak.ts'), '');
    symlinkSync(join(outside, 'sub'), join(root, 'escape'));
    const files = await collect(root);
    expect(files.map((f) => f.path)).not.toContain('escape/leak.ts');
  });
});
