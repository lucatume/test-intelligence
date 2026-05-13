import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { synthesizeCompilerOptions } from '../../../src/extract/ts/compiler.js';
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
