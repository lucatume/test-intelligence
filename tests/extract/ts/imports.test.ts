import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { extractImports } from '../../../src/extract/ts/imports.js';
import { synthesizeCompilerOptions } from '../../../src/extract/ts/compiler.js';
import { useTmpDir } from '../../helpers/tmpDir.js';

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function parseFile(root: string, rel: string): ts.SourceFile {
  const src = readFileSync(join(root, rel), 'utf8');
  return ts.createSourceFile(join(root, rel), src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

describe('extractImports', () => {
  const getTmp = useTmpDir('ti-imports-');

  it('emits resolved import-edge for relative imports', () => {
    const root = getTmp();
    write(root, 'src/a.ts', "import { x } from './helpers';\n");
    write(root, 'src/helpers.ts', 'export const x = 1;\n');
    const sf = parseFile(root, 'src/a.ts');
    const opts = synthesizeCompilerOptions(root);
    const facts = extractImports(sf, 'src/a.ts', root, opts);
    expect(facts).toHaveLength(1);
    const [f] = facts;
    if (!f) throw new Error('no fact');
    expect(f.kind).toBe('import-edge');
    expect(f.resolved).toBe(true);
    const [anchor] = f.anchors;
    if (!anchor) throw new Error('no anchor');
    expect(anchor.key).toBe('js-module:src/helpers.ts');
    expect((f.payload as { resolvedPath?: string }).resolvedPath).toBe('src/helpers.ts');
  });

  it('emits resolved=false for unresolvable specifiers', () => {
    const root = getTmp();
    write(root, 'src/a.ts', "import x from 'some-npm-pkg';\n");
    const sf = parseFile(root, 'src/a.ts');
    const opts = synthesizeCompilerOptions(root);
    const facts = extractImports(sf, 'src/a.ts', root, opts);
    expect(facts).toHaveLength(1);
    const [f] = facts;
    if (!f) throw new Error('no fact');
    expect(f.resolved).toBe(false);
    const [anchor] = f.anchors;
    if (!anchor) throw new Error('no anchor');
    expect(anchor.key).toBe('js-module:some-npm-pkg');
  });

  it('handles dynamic import() and require() (cjs)', () => {
    const root = getTmp();
    write(root, 'src/dyn.ts', "const x = import('./helpers'); const y = require('./helpers');\n");
    write(root, 'src/helpers.ts', 'export const x = 1;\n');
    const sf = parseFile(root, 'src/dyn.ts');
    const opts = synthesizeCompilerOptions(root);
    const facts = extractImports(sf, 'src/dyn.ts', root, opts);
    expect(facts).toHaveLength(2);
    expect(facts.every((f) => f.resolved)).toBe(true);
  });
});
