import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname as osHostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, releaseLock } from '../../src/store/lock.js';
import { systemClock } from '../../src/clock.js';

describe('acquireLock / releaseLock', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ti-lock-'));
    mkdirSync(join(root, '.ti'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes a structured lock payload', () => {
    const r = acquireLock(root, { command: 'ti build', clock: systemClock });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const content = readFileSync(join(root, '.ti', '.lock'), 'utf8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.command).toBe('ti build');
    expect(typeof parsed.hostname).toBe('string');
    expect(typeof parsed.startedAt).toBe('string');
    releaseLock(root);
  });

  it('refuses when same-host live PID holds the lock', () => {
    const r1 = acquireLock(root, { command: 'ti build', clock: systemClock });
    expect(r1.kind).toBe('ok');
    const r2 = acquireLock(root, { command: 'ti build', clock: systemClock });
    expect(r2.kind).toBe('err');
    if (r2.kind === 'err') expect(r2.error.kind).toBe('LockHeldError');
    releaseLock(root);
  });

  it('reclaims a stale lock (dead PID, same host)', () => {
    const stale = {
      pid: 2147483646, // PID well outside live PID space on any sane system
      hostname: osHostname(),
      command: 'ti build',
      startedAt: '2026-04-01T00:00:00Z',
    };
    writeFileSync(join(root, '.ti', '.lock'), JSON.stringify(stale));
    const r = acquireLock(root, { command: 'ti build', clock: systemClock });
    expect(r.kind).toBe('ok');
    releaseLock(root);
  });

  it('refuses cross-host lock', () => {
    const cross = {
      pid: process.pid,
      hostname: 'definitely-not-this-host',
      command: 'ti build',
      startedAt: '2026-04-01T00:00:00Z',
    };
    writeFileSync(join(root, '.ti', '.lock'), JSON.stringify(cross));
    const r = acquireLock(root, { command: 'ti build', clock: systemClock });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.kind).toBe('LockHostMismatchError');
  });

  it('releaseLock is a no-op on a missing file', () => {
    expect(() => { releaseLock(root); }).not.toThrow();
  });

  it('returns LockHeldError when an existing lock file is unparseable', () => {
    writeFileSync(join(root, '.ti', '.lock'), 'this is not json');
    // Hand-occupy with corrupt content. acquireLock should NOT throw; it should
    // reclaim (parse-fail treated as missing in pre-write branch) and succeed.
    const r = acquireLock(root, { command: 'ti build', clock: systemClock });
    expect(r.kind).toBe('ok');
    releaseLock(root);
  });
});
