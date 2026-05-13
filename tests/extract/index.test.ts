import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { extractFile } from '../../src/extract/index.js';
import { synthesizeCompilerOptions } from '../../src/extract/ts/compiler.js';
import { useTmpDir } from '../helpers/tmpDir.js';
import { unsafeCoerce } from '../helpers/unsafeCoerce.js';
import type { ProjectRelativePath } from '../../src/types.js';

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

describe('extractFile', () => {
  const getTmp = useTmpDir('ti-extract-');

  it('dispatches to TS extractor', async () => {
    const root = getTmp();
    write(root, 'src/a.ts', "import './b';\n");
    write(root, 'src/b.ts', 'export const x = 1;');
    const opts = synthesizeCompilerOptions(root);
    const r = await extractFile({
      projectRoot: root,
      path: unsafeCoerce<ProjectRelativePath>('src/a.ts'),
      language: 'ts',
      framework: null,
      compilerOptions: opts,
      patterns: [],
    });
    expect(r.kind).toBe('ok');
  });

  it('returns ok([]) for PHP in Plan B', async () => {
    const root = getTmp();
    write(root, 'src/a.php', '<?php');
    const opts = synthesizeCompilerOptions(root);
    const r = await extractFile({
      projectRoot: root,
      path: unsafeCoerce<ProjectRelativePath>('src/a.php'),
      language: 'php',
      framework: null,
      compilerOptions: opts,
      patterns: [],
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value).toEqual([]);
  });
});
