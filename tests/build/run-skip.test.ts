import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuild } from '../../src/build/run.js';
import { parseConfig } from '../../src/config/parse.js';
import { systemClock } from '../../src/clock.js';
import { openStore } from '../../src/store/open.js';
import { useTmpDir } from '../helpers/tmpDir.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function write(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function counts(root: string): { facts: number; edges: number } {
  const s = openStore(root);
  if (s.kind !== 'ok') throw new Error('open failed');
  try {
    const f = s.value.db.prepare('SELECT COUNT(*) AS n FROM fact').get() as { n: number };
    const e = s.value.db.prepare('SELECT COUNT(*) AS n FROM edge').get() as { n: number };
    return { facts: f.n, edges: e.n };
  } finally {
    s.value.close();
  }
}

describe('runBuild incremental skip', () => {
  const getTmp = useTmpDir('ti-build-skip-');

  function cfg() {
    const r = parseConfig({ confidence: { threshold: 0 } });
    if (r.kind === 'err') throw new Error('cfg');
    return r.value;
  }

  it('skips every file on a no-op rebuild; facts and edges unchanged', async () => {
    const root = getTmp();
    write(root, 'src/a.ts', 'export const a = 1;');
    write(root, 'src/b.ts', 'export const b = 2;');

    const first = await runBuild({
      projectRoot: root, config: cfg(), clock: systemClock,
      stderr: { write: () => undefined }, repoRoot,
    });
    if (first.kind !== 'ok') throw new Error('first build failed');
    expect(first.value.filesExtracted).toBe(2);
    const before = counts(root);

    const second = await runBuild({
      projectRoot: root, config: cfg(), clock: systemClock,
      stderr: { write: () => undefined }, repoRoot, skipUnchanged: true,
    });
    if (second.kind !== 'ok') throw new Error('second build failed');
    expect(second.value.filesExtracted).toBe(0);
    expect(second.value.filesSkipped).toBe(2);
    expect(counts(root)).toEqual(before);
  });

  it('re-extracts only the changed file', async () => {
    const root = getTmp();
    write(root, 'src/a.ts', 'export const a = 1;');
    write(root, 'src/b.ts', 'export const b = 2;');

    const first = await runBuild({
      projectRoot: root, config: cfg(), clock: systemClock,
      stderr: { write: () => undefined }, repoRoot,
    });
    if (first.kind !== 'ok') throw new Error('first build failed');

    write(root, 'src/b.ts', 'export const b = 99;');
    const second = await runBuild({
      projectRoot: root, config: cfg(), clock: systemClock,
      stderr: { write: () => undefined }, repoRoot, skipUnchanged: true,
    });
    if (second.kind !== 'ok') throw new Error('second build failed');
    expect(second.value.filesExtracted).toBe(1);
    expect(second.value.filesSkipped).toBe(1);
  });

  it('re-extracts a file whose hash matches but has zero facts', async () => {
    const root = getTmp();
    write(root, 'src/a.ts', 'export const a = 1;');
    write(root, 'src/b.ts', 'export const b = 2;');

    const first = await runBuild({
      projectRoot: root, config: cfg(), clock: systemClock,
      stderr: { write: () => undefined }, repoRoot,
    });
    if (first.kind !== 'ok') throw new Error('first build failed');

    // Strip src/a.ts's facts directly, leaving the file row + content_hash.
    const s = openStore(root);
    if (s.kind !== 'ok') throw new Error('open failed');
    try {
      const row = s.value.db.prepare('SELECT id FROM file WHERE path = ?').get('src/a.ts') as { id: number };
      s.value.db.prepare('DELETE FROM fact WHERE file_id = ?').run(row.id);
    } finally {
      s.value.close();
    }

    const second = await runBuild({
      projectRoot: root, config: cfg(), clock: systemClock,
      stderr: { write: () => undefined }, repoRoot, skipUnchanged: true,
    });
    if (second.kind !== 'ok') throw new Error('second build failed');
    // src/a.ts (no facts) re-extracts; src/b.ts (intact) skips.
    expect(second.value.filesExtracted).toBe(1);
    expect(second.value.filesSkipped).toBe(1);
  });
});
