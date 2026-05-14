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

describe('runBuild timing breakdown', () => {
  const getTmp = useTmpDir('ti-build-timings-');

  it('always populates BuildSummary.timings with per-phase counters', async () => {
    const root = getTmp();
    for (let i = 0; i < 4; i++) {
      write(root, `src/a${String(i)}.ts`, 'export const a = 1;');
    }
    write(root, 'tests/a.test.ts', `
import { describe, it } from 'vitest';
import { a } from '../src/a0';
describe('a', () => { it('works', () => { void a; }); });
`);
    const cfg = parseConfig({ confidence: { threshold: 0 } });
    if (cfg.kind === 'err') throw new Error('cfg');

    const r = await runBuild({
      projectRoot: root,
      config: cfg.value,
      clock: systemClock,
      stderr: { write: () => {} },
      repoRoot,
    });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const t = r.value.timings;
    expect(t.totalMs).toBeGreaterThanOrEqual(0);
    expect(t.lockMs).toBeGreaterThanOrEqual(0);
    expect(t.setupMs).toBeGreaterThanOrEqual(0);
    expect(t.extractPhaseMs).toBeGreaterThanOrEqual(0);
    expect(t.extractTsFiles).toBeGreaterThan(0);
    expect(t.extractTsMs).toBeGreaterThanOrEqual(0);
    expect(t.extractPhpFiles).toBe(0);
    expect(t.extractPhpMs).toBe(0);
    expect(t.derivePhaseMs).toBeGreaterThanOrEqual(0);
    expect(t.deriveLoadGraphMs).toBeGreaterThanOrEqual(0);
    expect(t.deriveBuildIndexMs).toBeGreaterThanOrEqual(0);
    expect(t.deriveTraverseMs).toBeGreaterThanOrEqual(0);
    expect(t.deriveWriteMs).toBeGreaterThanOrEqual(0);
    expect(t.slowestFiles).toEqual([]);
  });

  it('emits a "timings" line only when timing.emit is true', async () => {
    const root = getTmp();
    write(root, 'src/a.ts', 'export const a = 1;');
    write(root, 'tests/a.test.ts', `
import { describe, it } from 'vitest';
describe('a', () => { it('works', () => {}); });
`);
    const cfg = parseConfig({ confidence: { threshold: 0 } });
    if (cfg.kind === 'err') throw new Error('cfg');

    const off: string[] = [];
    await runBuild({
      projectRoot: root,
      config: cfg.value,
      clock: systemClock,
      stderr: { write: (s) => { off.push(s); } },
      repoRoot,
    });
    expect(off.join('')).toMatch(/build complete/);
    expect(off.join('')).not.toMatch(/timings/);

    const on: string[] = [];
    await runBuild({
      projectRoot: root,
      config: cfg.value,
      clock: systemClock,
      stderr: { write: (s) => { on.push(s); } },
      timing: { emit: true },
      repoRoot,
    });
    const out = on.join('');
    expect(out).toMatch(/build complete/);
    expect(out).toMatch(/ti: timings/);
    expect(out).toMatch(/extract/);
    expect(out).toMatch(/derive/);
  });

  it('collects slowest files when timing.topN > 0 and emits them when emit is true', async () => {
    const root = getTmp();
    for (let i = 0; i < 6; i++) {
      write(root, `src/m${String(i)}.ts`, 'export const x = 1;');
    }
    write(root, 'tests/x.test.ts', `
import { describe, it } from 'vitest';
describe('x', () => { it('works', () => {}); });
`);
    const cfg = parseConfig({ confidence: { threshold: 0 } });
    if (cfg.kind === 'err') throw new Error('cfg');

    const lines: string[] = [];
    const r = await runBuild({
      projectRoot: root,
      config: cfg.value,
      clock: systemClock,
      stderr: { write: (s) => { lines.push(s); } },
      timing: { emit: true, topN: 3 },
      repoRoot,
    });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const slow = r.value.timings.slowestFiles;
    expect(slow.length).toBeGreaterThan(0);
    expect(slow.length).toBeLessThanOrEqual(3);
    expect(slow[0]?.path).toBeTypeOf('string');
    expect(slow[0]?.language).toBeTypeOf('string');
    expect(slow[0]?.millis).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < slow.length; i++) {
      const prev = slow[i - 1];
      const cur = slow[i];
      if (prev !== undefined && cur !== undefined) {
        expect(prev.millis).toBeGreaterThanOrEqual(cur.millis);
      }
    }
    expect(lines.join('')).toMatch(/slowest extracts/);
  });
});
