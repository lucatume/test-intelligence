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

export function acquireLock(
  projectRoot: string,
  opts: AcquireOpts,
): Result<undefined, LockError> {
  const lockPath = join(projectRoot, LOCK_PATH_SEGMENT);

  if (existsSync(lockPath)) {
    let existing: LockPayload | undefined;
    try {
      existing = JSON.parse(readFileSync(lockPath, 'utf8')) as LockPayload;
    } catch {
      // Corrupt lock content — treat as stale and reclaim.
    }
    if (existing) {
      if (existing.hostname !== hostname()) {
        return err({ kind: 'LockHostMismatchError', holder: existing });
      }
      if (isPidAlive(existing.pid)) {
        return err({ kind: 'LockHeldError', holder: existing });
      }
      // Stale; reclaim by overwrite below.
      try {
        unlinkSync(lockPath);
      } catch {
        // ignore
      }
    } else {
      // Corrupt payload — remove so the exclusive open below can succeed.
      try {
        unlinkSync(lockPath);
      } catch {
        // ignore
      }
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
      const existing = JSON.parse(readFileSync(lockPath, 'utf8')) as LockPayload;
      if (existing.hostname !== hostname()) {
        return err({ kind: 'LockHostMismatchError', holder: existing });
      }
      return err({ kind: 'LockHeldError', holder: existing });
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
