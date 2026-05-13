import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import {
  synthesizeCompilerOptions,
  CompilerOptionsResolver,
} from '../../../src/extract/ts/compiler.js';
import { useTmpDir } from '../../helpers/tmpDir.js';

describe('synthesizeCompilerOptions', () => {
  const getTmp = useTmpDir('ti-compiler-opts-');

  it('returns defaults when no tsconfig is present', () => {
    const opts = synthesizeCompilerOptions(getTmp());
    expect(opts.allowJs).toBe(true);
    expect(opts.jsx).toBe(ts.JsxEmit.Preserve);
    expect(opts.module).toBe(ts.ModuleKind.ESNext);
    expect(opts.skipLibCheck).toBe(true);
    expect(opts.noEmit).toBe(true);
    expect(opts.paths).toBeUndefined();
    expect(opts.baseUrl).toBeUndefined();
  });

  it('merges paths and baseUrl from tsconfig.json', () => {
    const root = getTmp();
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES5',                // ignored
        baseUrl: '.',
        paths: { '@/*': ['src/*'] },
      },
    }));
    const opts = synthesizeCompilerOptions(root);
    expect(opts.target).toBe(ts.ScriptTarget.ES2022);
    expect(opts.baseUrl).toBeDefined();
    expect(opts.paths).toEqual({ '@/*': ['src/*'] });
  });

  it('falls back to jsconfig.json when tsconfig is absent', () => {
    const root = getTmp();
    writeFileSync(join(root, 'jsconfig.json'), JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '~/*': ['lib/*'] } },
    }));
    const opts = synthesizeCompilerOptions(root);
    expect(opts.paths).toEqual({ '~/*': ['lib/*'] });
  });
});

describe('CompilerOptionsResolver (hierarchical)', () => {
  const getTmp = useTmpDir('ti-compiler-resolver-');

  it('prefers the nearest tsconfig when walking up from the importing file', () => {
    // Monorepo case: root has a generic tsconfig, a nested package has its
    // own with project-specific path aliases. The nested config must win
    // for files inside that subtree.
    const root = getTmp();
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@root/*': ['root/*'] } } }),
    );
    mkdirSync(join(root, 'packages', 'admin', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'admin', 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '~/*': ['src/*'] } } }),
    );

    const resolver = new CompilerOptionsResolver(root);
    const optsRoot = resolver.forFile(join(root, 'src', 'rootFile.ts'));
    expect(optsRoot.paths).toEqual({ '@root/*': ['root/*'] });

    const optsNested = resolver.forFile(join(root, 'packages', 'admin', 'src', 'foo.ts'));
    expect(optsNested.paths).toEqual({ '~/*': ['src/*'] });
    // baseUrl must be relative to the nested tsconfig — not the project root.
    expect(optsNested.baseUrl).toBe(join(root, 'packages', 'admin'));
  });

  it('falls back to project-root options when no nested tsconfig exists', () => {
    const root = getTmp();
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
    );
    mkdirSync(join(root, 'deeply', 'nested'), { recursive: true });

    const resolver = new CompilerOptionsResolver(root);
    const opts = resolver.forFile(join(root, 'deeply', 'nested', 'foo.ts'));
    expect(opts.paths).toEqual({ '@/*': ['src/*'] });
  });

  it('caches per directory so adjacent files share work', () => {
    const root = getTmp();
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } }),
    );
    const resolver = new CompilerOptionsResolver(root);
    const a = resolver.forFile(join(root, 'src', 'a.ts'));
    const b = resolver.forFile(join(root, 'src', 'b.ts'));
    // Same options object - referential equality proves the cache hit.
    expect(a).toBe(b);
  });
});
