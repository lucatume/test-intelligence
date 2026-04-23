import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { unlockManaged } from '../../src/storage/lock.js';
import { useTmpDir } from '../helpers/tmpDir.js';

async function writeLock(tiDir: string, payload: object): Promise<void> {
  await fs.mkdir(tiDir, { recursive: true });
  await fs.writeFile(path.join(tiDir, '.lock'), JSON.stringify(payload));
}

describe('unlockManaged', () => {
  const tmp = useTmpDir('ti-unlock-');

  it('returns no-lock when .lock does not exist', async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    await fs.mkdir(tiDir, { recursive: true });
    const r = await unlockManaged({ tiDir, force: false });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.kind).toBe('no-lock');
  });

  it('releases a lock whose PID is dead on the current host', async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    // PID 0 is never a live process on any OS.
    await writeLock(tiDir, {
      pid: 0, hostname: os.hostname(), command: 'ti build', startedAt: '2026-04-23T00:00:00Z',
    });
    const r = await unlockManaged({ tiDir, force: false });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.kind).toBe('released');
    await expect(fs.access(path.join(tiDir, '.lock'))).rejects.toThrow();
  });

  it('refuses when the lock is held by a live process on the same host', async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    await writeLock(tiDir, {
      pid: process.pid, hostname: os.hostname(), command: 'ti build', startedAt: '2026-04-23T00:00:00Z',
    });
    const r = await unlockManaged({ tiDir, force: false });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.kind).toBe('LockHeldError');
  });

  it('refuses hostname-mismatch without --force', async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    await writeLock(tiDir, {
      pid: 0, hostname: 'someone-elses-host.local', command: 'ti build', startedAt: '2026-04-23T00:00:00Z',
    });
    const r = await unlockManaged({ tiDir, force: false });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.kind).toBe('LockHostMismatchError');
  });

  it('with --force, releases a hostname-mismatched lock', async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    await writeLock(tiDir, {
      pid: 0, hostname: 'someone-elses-host.local', command: 'ti build', startedAt: '2026-04-23T00:00:00Z',
    });
    const r = await unlockManaged({ tiDir, force: true });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.kind).toBe('released');
    await expect(fs.access(path.join(tiDir, '.lock'))).rejects.toThrow();
  });

  it('with --force, still refuses a live lock on the current host', async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    await writeLock(tiDir, {
      pid: process.pid, hostname: os.hostname(), command: 'ti build', startedAt: '2026-04-23T00:00:00Z',
    });
    const r = await unlockManaged({ tiDir, force: true });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.kind).toBe('LockHeldError');
  });

  it('returns released when .lock content is unparseable (treated as orphaned garbage)', async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    await fs.mkdir(tiDir, { recursive: true });
    await fs.writeFile(path.join(tiDir, '.lock'), 'not-json');
    const r = await unlockManaged({ tiDir, force: false });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.kind).toBe('released');
  });
});
