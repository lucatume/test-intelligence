import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuild } from '../../../src/build/run.js';
import { parseConfig } from '../../../src/config/parse.js';
import { systemClock } from '../../../src/clock.js';
import { updateCommand } from '../../../src/cli/commands/update.js';
import { useTmpDir } from '../../helpers/tmpDir.js';
import { makeIo } from '../_helpers/makeIo.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function write(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

async function buildOnce(root: string): Promise<void> {
  const cfg = parseConfig({ confidence: { threshold: 0 } });
  if (cfg.kind === 'err') throw new Error('cfg');
  const r = await runBuild({
    projectRoot: root, config: cfg.value, clock: systemClock,
    stderr: { write: () => undefined }, repoRoot,
  });
  if (r.kind !== 'ok') throw new Error('build failed');
}

describe('updateCommand', () => {
  const getTmp = useTmpDir('ti-cli-update-');

  it('ti update <path> skips an unchanged listed file', async () => {
    const root = getTmp();
    write(root, 'src/a.ts', 'export const a = 1;');
    await buildOnce(root);

    const t = makeIo();
    const code = await updateCommand({
      projectRoot: root, io: t.io, verbosity: 'normal',
      paths: ['src/a.ts'], repoRoot,
    });
    expect(code).toBe(0);
    expect(t.err).toContain('1 skipped');
  });

  it('no-arg ti update runs a cheap full revalidate, not a no-op', async () => {
    const root = getTmp();
    write(root, 'src/a.ts', 'export const a = 1;');
    write(root, 'src/b.ts', 'export const b = 2;');
    await buildOnce(root);

    const t = makeIo();
    const code = await updateCommand({
      projectRoot: root, io: t.io, verbosity: 'normal',
      paths: [], repoRoot,
    });
    expect(code).toBe(0);
    expect(t.err).not.toContain('no paths given');
    // Clean tree: every discovered file is skipped, nothing re-extracted.
    expect(t.err).toContain('0 files');
    expect(t.err).toContain('2 skipped');
  });
});
