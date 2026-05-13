import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuild } from '../../src/build/run.js';
import { parseConfig } from '../../src/config/parse.js';
import { systemClock } from '../../src/clock.js';
import { useTmpDir } from '../helpers/tmpDir.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function write(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

describe('runBuild update path', () => {
  const getTmp = useTmpDir('ti-build-update-');

  it('re-extracts only listed paths', async () => {
    const root = getTmp();
    write(root, 'src/a.ts', 'export const a = 1;');
    write(root, 'src/b.ts', 'export const b = 2;');
    const cfgRes = parseConfig({ confidence: { threshold: 0 } });
    if (cfgRes.kind === 'err') throw new Error('cfg');

    const first = await runBuild({
      projectRoot: root,
      config: cfgRes.value,
      clock: systemClock,
      stderr: { write: () => undefined },
      repoRoot,
    });
    if (first.kind !== 'ok') throw new Error('first build failed');
    expect(first.value.filesExtracted).toBe(2);

    write(root, 'src/b.ts', 'export const b = 99;');
    const second = await runBuild({
      projectRoot: root,
      config: cfgRes.value,
      clock: systemClock,
      stderr: { write: () => undefined },
      onlyPaths: ['src/b.ts'],
      repoRoot,
    });
    if (second.kind !== 'ok') throw new Error('update failed');
    expect(second.value.filesExtracted).toBe(1);
  });
});
