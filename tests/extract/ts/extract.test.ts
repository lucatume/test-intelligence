import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { extractTsFile } from '../../../src/extract/ts/extract.js';
import { synthesizeCompilerOptions } from '../../../src/extract/ts/compiler.js';
import { useTmpDir } from '../../helpers/tmpDir.js';

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

describe('extractTsFile', () => {
  const getTmp = useTmpDir('ti-extract-ts-');

  it('emits import-edge + symbol-def for a typical source file', async () => {
    const root = getTmp();
    write(root, 'src/cart.ts', "import { x } from './helpers';\nexport function addItem() {}\n");
    write(root, 'src/helpers.ts', 'export const x = 1;\n');
    const opts = synthesizeCompilerOptions(root);
    const facts = await extractTsFile({
      projectRoot: root,
      relPath: 'src/cart.ts',
      language: 'ts',
      framework: null,
      compilerOptions: opts,
      patterns: [],
    });
    const kinds = facts.map((f) => f.kind).sort();
    expect(kinds).toEqual(['import-edge', 'symbol-def']);
  });

  it('emits symbol-use facts for imported call sites', async () => {
    const root = getTmp();
    write(root, 'src/bar.ts', 'export function foo() {}\n');
    write(root, 'src/a.ts', "import { foo } from './bar';\nfoo();\n");
    const opts = synthesizeCompilerOptions(root);
    const facts = await extractTsFile({
      projectRoot: root,
      relPath: 'src/a.ts',
      language: 'ts',
      framework: null,
      compilerOptions: opts,
      patterns: [],
    });
    const su = facts.filter((f) => f.kind === 'symbol-use');
    expect(su.map((f) => f.anchors[0]?.key)).toContain('js-symbol:src/bar.ts:foo');
  });

  it('emits test-def when framework is set', async () => {
    const root = getTmp();
    write(root, 'tests/a.test.ts', "it('x', () => {});");
    const opts = synthesizeCompilerOptions(root);
    const facts = await extractTsFile({
      projectRoot: root,
      relPath: 'tests/a.test.ts',
      language: 'ts',
      framework: 'jest',
      compilerOptions: opts,
      patterns: [],
    });
    expect(facts.some((f) => f.kind === 'test-def')).toBe(true);
  });
});
