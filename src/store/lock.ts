import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '../clock.js';
import type { Result } from '../result.js';
import { err, ok } from '../result.js';

export interface LockPayload {
  readonly pid: number;
  readonly hostname: string;
  readonly command: string;
  readonly startedAt: string;
}

export type LockError =
  | { kind: 'LockHeldError'; holder: LockPayload }
  | { kind: 'LockHostMismatchError'; holder: LockPayload };

export interface AcquireOpts {
  readonly command: string;
  readonly clock: Clock;
}

const LOCK_PATH_SEGMENT = '.ti/.lock';

function readExistingLock(lockPath: string): LockPayload | undefined {
  let content: string;
  try {
    content = readFileSync(lockPath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(content) as LockPayload;
  } catch {
    return undefined;
  }
}

export function acquireLock(
  projectRoot: string,
  opts: AcquireOpts,
): Result<undefined, LockError> {
  const lockPath = join(projectRoot, LOCK_PATH_SEGMENT);

  if (existsSync(lockPath)) {
    const existing = readExistingLock(lockPath);
    if (existing) {
      if (existing.hostname !== hostname()) {
        return err({ kind: 'LockHostMismatchError', holder: existing });
      }
      if (isPidAlive(existing.pid)) {
        return err({ kind: 'LockHeldError', holder: existing });
      }
    }
    // Stale, missing-on-read, or corrupt — reclaim by overwrite below.
    try {
      unlinkSync(lockPath);
    } catch {
      // already gone or never existed
    }
  }

  const payload: LockPayload = {
    pid: process.pid,
    hostname: hostname(),
    command: opts.command,
    startedAt: opts.clock.now(),
  };

  // O_EXCL ensures we don't race another writer.
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = readExistingLock(lockPath);
      if (existing && existing.hostname !== hostname()) {
        return err({ kind: 'LockHostMismatchError', holder: existing });
      }
      if (existing) {
        return err({ kind: 'LockHeldError', holder: existing });
      }
      // Race window: file appeared but is unreadable/corrupt. Treat as held by
      // an unknown holder; safer to refuse than to clobber a peer's in-flight write.
      return err({
        kind: 'LockHeldError',
        holder: {
          pid: 0,
          hostname: hostname(),
          command: '<unknown>',
          startedAt: opts.clock.now(),
        },
      });
    }
    throw e;
  }
  writeSync(fd, JSON.stringify(payload));
  closeSync(fd);
  return ok(undefined);
}

export function releaseLock(projectRoot: string): void {
  const lockPath = join(projectRoot, LOCK_PATH_SEGMENT);
  try {
    unlinkSync(lockPath);
  } catch {
    // already gone
  }
}

function isPidAlive(pid: number): boolean {
  try {
    // signal 0 — does not deliver a signal; returns true if the process exists
    // and the caller has permission to signal it.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
    // EPERM: process exists but we can't signal it. Treat as alive.
    return true;
  }
}
