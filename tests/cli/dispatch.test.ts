import { describe, expect, it } from 'vitest';
import { run } from '../../src/cli.js';
import { makeIo } from './_helpers/makeIo.js';

describe('cli.run', () => {
  it('--help prints HELP_TEXT and exits 0', async () => {
    const t = makeIo();
    const code = await run(['--help'], t.io);
    expect(code).toBe(0);
    expect(t.out).toContain('ti - test intelligence');
  });

  it('--version prints versionString and exits 0', async () => {
    const t = makeIo();
    const code = await run(['--version'], t.io);
    expect(code).toBe(0);
    expect(t.out.trim().length).toBeGreaterThan(0);
  });

  it('unknown command exits 1 with stderr message', async () => {
    const t = makeIo();
    const code = await run(['frobnicate'], t.io);
    expect(code).toBe(1);
    expect(t.err).toContain('frobnicate');
  });

  it('removed stateful command exits 1 as unknown', async () => {
    const t = makeIo();
    const code = await run(['build'], t.io);
    expect(code).toBe(1);
    expect(t.err).toContain('unknown command');
  });
});
