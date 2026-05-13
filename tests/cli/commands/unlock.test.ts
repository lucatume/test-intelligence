import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { unlockCommand } from '../../../src/cli/commands/unlock.js';
import { useTmpDir } from '../../helpers/tmpDir.js';
import { makeIo } from '../_helpers/makeIo.js';

describe('unlockCommand', () => {
  const getTmp = useTmpDir('ti-unlock-');

  it('removes a stale lock (dead PID)', () => {
    const root = getTmp();
    mkdirSync(join(root, '.ti'));
    writeFileSync(join(root, '.ti/.lock'), JSON.stringify({
      pid: 999999, hostname: hostname(), command: 'build', startedAt: '2026-05-13T00:00:00Z',
    }));
    const t = makeIo();
    const code = unlockCommand({ projectRoot: root, io: t.io, force: false });
    expect(code).toBe(0);
    expect(existsSync(join(root, '.ti/.lock'))).toBe(false);
  });

  it('refuses to remove live lock without --force', () => {
    const root = getTmp();
    mkdirSync(join(root, '.ti'));
    writeFileSync(join(root, '.ti/.lock'), JSON.stringify({
      pid: process.pid, hostname: hostname(), command: 'build', startedAt: '2026-05-13T00:00:00Z',
    }));
    const t = makeIo();
    const code = unlockCommand({ projectRoot: root, io: t.io, force: false });
    expect(code).toBe(1);
    expect(existsSync(join(root, '.ti/.lock'))).toBe(true);
  });

  it('removes live lock with --force', () => {
    const root = getTmp();
    mkdirSync(join(root, '.ti'));
    writeFileSync(join(root, '.ti/.lock'), JSON.stringify({
      pid: process.pid, hostname: hostname(), command: 'build', startedAt: '2026-05-13T00:00:00Z',
    }));
    const t = makeIo();
    const code = unlockCommand({ projectRoot: root, io: t.io, force: true });
    expect(code).toBe(0);
    expect(existsSync(join(root, '.ti/.lock'))).toBe(false);
  });

  it('is a no-op when no lock exists', () => {
    const root = getTmp();
    const t = makeIo();
    const code = unlockCommand({ projectRoot: root, io: t.io, force: false });
    expect(code).toBe(0);
  });
});
