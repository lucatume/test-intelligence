import { describe, expect, it } from 'vitest';
import { run } from '../../src/cli.js';
import type { Io } from '../../src/cli/io.js';

function makeIo() {
  let out = '';
  let errStr = '';
  const io = {
    stdout: {
      write(s: string) {
        out += s;
        return true;
      },
    },
    stderr: {
      write(s: string) {
        errStr += s;
        return true;
      },
    },
  } as const;
  return {
    io,
    get out() {
      return out;
    },
    get err() {
      return errStr;
    },
  };
}

describe('cli.run', () => {
  it('--help prints HELP_TEXT and exits 0', async () => {
    const t = makeIo();
    const code = await run(['--help'], t.io as unknown as Io);
    expect(code).toBe(0);
    expect(t.out).toContain('ti — test intelligence');
  });

  it('--version prints versionString and exits 0', async () => {
    const t = makeIo();
    const code = await run(['--version'], t.io as unknown as Io);
    expect(code).toBe(0);
    expect(t.out.trim().length).toBeGreaterThan(0);
  });

  it('unknown command exits 1 with stderr message', async () => {
    const t = makeIo();
    const code = await run(['frobnicate'], t.io as unknown as Io);
    expect(code).toBe(1);
    expect(t.err).toContain('frobnicate');
  });

  it('not-implemented verb exits 1 with stderr message', async () => {
    const t = makeIo();
    const code = await run(['build'], t.io as unknown as Io);
    expect(code).toBe(1);
    expect(t.err).toContain('not yet implemented');
  });
});
