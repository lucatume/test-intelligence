import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildResolutionProgram } from '../../src/jsresolve/program.js';
import { useTmpDir } from '../helpers/tmpDir.js';

describe('buildResolutionProgram', () => {
  const getTmp = useTmpDir('ti-jsresolve-program-');

  it('includes a seed file and the module it imports, excludes node_modules', () => {
    const root = getTmp();
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(root, 'src/caller.js'), "import { A } from './consts.js';\napiFetch(A);\n");
    writeFileSync(join(root, 'src/consts.js'), "export const A = { path: '/x' };\n");
    writeFileSync(join(root, 'node_modules/pkg/index.js'), "export const Z = 1;\n");

    const { program } = buildResolutionProgram([join(root, 'src/caller.js')], root);
    const files = program.getSourceFiles().map((sf) => sf.fileName);
    expect(files.some((f) => f.endsWith('src/caller.js'))).toBe(true);
    expect(files.some((f) => f.endsWith('src/consts.js'))).toBe(true);
    expect(files.some((f) => f.includes('/node_modules/'))).toBe(false);
  });
});
