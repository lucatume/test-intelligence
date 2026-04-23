import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { dispatch } from '../../src/cli/dispatch.js';
import type { Io } from '../../src/cli/io.js';
import { fixedClock } from '../../src/clock.js';
import type { ISODate } from '../../src/types.js';
import { useTmpDir } from '../helpers/tmpDir.js';

function makeIo(opts?: { stdin?: string; isTty?: boolean }): Io & { outbuf: string; errbuf: string } {
  let outbuf = '', errbuf = '';
  const io: Io & { outbuf: string; errbuf: string } = {
    stdout: { write(c) { outbuf += c; (io as { outbuf: string }).outbuf = outbuf; } },
    stderr: { write(c) { errbuf += c; (io as { errbuf: string }).errbuf = errbuf; } },
    readStdin: () => Promise.resolve(opts?.stdin ?? ''),
    stdinIsTty: opts?.isTty ?? true,
    outbuf: '',
    errbuf: '',
  };
  return io;
}

describe('dispatch — help / version', () => {
  it('help command writes HELP_TEXT to stdout and exits 0', async () => {
    const io = makeIo();
    const code = await dispatch({
      argv: ['--help'],
      io,
      cwd: process.cwd(),
      clock: fixedClock('2026-04-23T00:00:00Z' as ISODate),
    });
    expect(code).toBe(0);
    expect(io.outbuf).toMatch(/USAGE/);
    expect(io.errbuf).toBe('');
  });

  it('version command writes semver to stdout and exits 0', async () => {
    const io = makeIo();
    const code = await dispatch({
      argv: ['--version'],
      io,
      cwd: process.cwd(),
      clock: fixedClock('2026-04-23T00:00:00Z' as ISODate),
    });
    expect(code).toBe(0);
    expect(io.outbuf.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('unknown command exits 1 with stderr notice', async () => {
    const io = makeIo();
    const code = await dispatch({
      argv: ['wat'],
      io,
      cwd: process.cwd(),
      clock: fixedClock('2026-04-23T00:00:00Z' as ISODate),
    });
    expect(code).toBe(1);
    expect(io.errbuf).toMatch(/ti: error:/);
  });
});

describe('dispatch — unlock', () => {
  const tmp = useTmpDir('ti-dispatch-unlock-');

  async function seedProject(pin: number | 'none'): Promise<string> {
    const root = tmp();
    await fs.writeFile(path.join(root, 'ti.config.ts'), 'export default {};');
    const tiDir = path.join(root, '.test-intelligence');
    await fs.mkdir(tiDir, { recursive: true });
    if (pin !== 'none') {
      await fs.writeFile(path.join(tiDir, '.lock'), JSON.stringify({
        pid: pin, hostname: os.hostname(), command: 'ti build', startedAt: '2026-04-23T00:00:00Z',
      }));
    }
    return root;
  }

  it('no-op when no lock exists: exit 0 with stderr notice', async () => {
    const root = await seedProject('none');
    const io = makeIo();
    const code = await dispatch({
      argv: ['unlock'],
      io,
      cwd: root,
      clock: fixedClock('2026-04-23T00:00:00Z' as ISODate),
    });
    expect(code).toBe(0);
    expect(io.errbuf).toMatch(/no lock/i);
  });

  it('releases a stale (dead-PID) lock: exit 0', async () => {
    const root = await seedProject(0);
    const io = makeIo();
    const code = await dispatch({
      argv: ['unlock'],
      io,
      cwd: root,
      clock: fixedClock('2026-04-23T00:00:00Z' as ISODate),
    });
    expect(code).toBe(0);
    await expect(fs.access(path.join(root, '.test-intelligence', '.lock'))).rejects.toThrow();
  });

  it('refuses a live-PID lock: exit 1 with LockHeldError message', async () => {
    const root = await seedProject(process.pid);
    const io = makeIo();
    const code = await dispatch({
      argv: ['unlock'],
      io,
      cwd: root,
      clock: fixedClock('2026-04-23T00:00:00Z' as ISODate),
    });
    expect(code).toBe(1);
    expect(io.errbuf).toMatch(/PID/);
  });
});
