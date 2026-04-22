import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { acquireLock, releaseLock, registerLockCleanupOnExit } from '../../src/storage/lock.js';
import type { LockPayload } from '../../src/storage/lock.js';
import { fixedClock } from '../../src/clock.js';
import { useTmpDir } from '../helpers/tmpDir.js';
import type { ISODate } from '../../src/types.js';

const at = '2026-04-21T10:00:00Z' as ISODate;

describe('acquireLock — fresh lock', () => {
  const tmp = useTmpDir('ti-lock-');

  it('creates .test-intelligence/.lock with structured payload', async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    await fs.mkdir(tiDir, { recursive: true });
    const r = await acquireLock({ tiDir, command: 'ti build', clock: fixedClock(at) });
    expect(r.kind).toBe('ok');
    const payload = JSON.parse(await fs.readFile(path.join(tiDir, '.lock'), 'utf8')) as LockPayload;
    expect(payload).toEqual({
      pid: process.pid,
      hostname: os.hostname(),
      command: 'ti build',
      startedAt: at,
    });
  });

  it('returns LockHeldError when same-host PID is alive', async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    await fs.mkdir(tiDir, { recursive: true });
    const first = await acquireLock({ tiDir, command: 'A', clock: fixedClock(at) });
    expect(first.kind).toBe('ok');
    const second = await acquireLock({ tiDir, command: 'B', clock: fixedClock(at) });
    expect(second.kind).toBe('err');
    if (second.kind === 'err') expect(second.error.kind).toBe('LockHeldError');
  });

  it('returns LockHostMismatchError when lock records a different hostname', async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    await fs.mkdir(tiDir, { recursive: true });
    await fs.writeFile(path.join(tiDir, '.lock'), JSON.stringify({
      pid: 12345,
      hostname: 'some-other-host',
      command: 'ti build',
      startedAt: at,
    }));
    const r = await acquireLock({ tiDir, command: 'try', clock: fixedClock(at) });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.kind).toBe('LockHostMismatchError');
  });

  it('reclaims a stale lock with a dead PID on the same host', async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    await fs.mkdir(tiDir, { recursive: true });
    await fs.writeFile(path.join(tiDir, '.lock'), JSON.stringify({
      pid: 999_999_999, // very unlikely to be alive
      hostname: os.hostname(),
      command: 'dead-process',
      startedAt: at,
    }));
    const r = await acquireLock({ tiDir, command: 'reclaim', clock: fixedClock(at) });
    expect(r.kind).toBe('ok');
    const payload = JSON.parse(await fs.readFile(path.join(tiDir, '.lock'), 'utf8')) as LockPayload;
    expect(payload.command).toBe('reclaim');
  });
});

describe('releaseLock', () => {
  const tmp = useTmpDir('ti-release-');

  it('removes the lock file', async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    await fs.mkdir(tiDir, { recursive: true });
    await acquireLock({ tiDir, command: 'x', clock: fixedClock(at) });
    await releaseLock(tiDir);
    await expect(fs.access(path.join(tiDir, '.lock'))).rejects.toThrow();
  });

  it('is a no-op when no lock file exists', async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    await fs.mkdir(tiDir, { recursive: true });
    await expect(releaseLock(tiDir)).resolves.toBeUndefined();
  });
});

describe('registerLockCleanupOnExit', () => {
  it('registers handlers for SIGINT, SIGTERM, and exit', () => {
    const priorSigint = process.listenerCount('SIGINT');
    const priorSigterm = process.listenerCount('SIGTERM');
    const priorExit = process.listenerCount('exit');
    const unregister = registerLockCleanupOnExit('/nonexistent/tmp-dir');
    try {
      expect(process.listenerCount('SIGINT')).toBe(priorSigint + 1);
      expect(process.listenerCount('SIGTERM')).toBe(priorSigterm + 1);
      expect(process.listenerCount('exit')).toBe(priorExit + 1);
    } finally {
      unregister();
    }
    expect(process.listenerCount('SIGINT')).toBe(priorSigint);
    expect(process.listenerCount('SIGTERM')).toBe(priorSigterm);
    expect(process.listenerCount('exit')).toBe(priorExit);
  });
});
