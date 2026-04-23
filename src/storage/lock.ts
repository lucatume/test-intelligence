import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { TiError } from '../errors.js';
import type { Clock } from '../clock.js';

export type LockPayload = {
  readonly pid: number;
  readonly hostname: string;
  readonly command: string;
  readonly startedAt: string;
};

export type AcquireLockArgs = {
  readonly tiDir: string;
  readonly command: string;
  readonly clock: Clock;
};

function lockPath(tiDir: string): string {
  return path.join(tiDir, '.lock');
}

function isPidAlive(pid: number): boolean {
  // PID 0 is not a valid lock-holder PID; process.kill(0, 0) sends to the
  // current process group (always succeeds), so we must special-case it.
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

async function readExistingLock(lockFile: string): Promise<LockPayload | null> {
  try {
    const raw = await fs.readFile(lockFile, 'utf8');
    const payload = JSON.parse(raw) as LockPayload;
    if (
      typeof payload.pid === 'number' &&
      typeof payload.hostname === 'string' &&
      typeof payload.command === 'string' &&
      typeof payload.startedAt === 'string'
    ) {
      return payload;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeLockAtomically(
  lockFile: string,
  payload: LockPayload,
): Promise<void> {
  const fh = await fs.open(lockFile, fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL, 0o644);
  try {
    await fh.writeFile(JSON.stringify(payload, null, 2));
  } finally {
    await fh.close();
  }
}

export async function acquireLock(args: AcquireLockArgs): Promise<Result<void, TiError>> {
  const { tiDir, command, clock } = args;
  const lockFile = lockPath(tiDir);
  const myPayload: LockPayload = {
    pid: process.pid,
    hostname: os.hostname(),
    command,
    startedAt: clock.now(),
  };
  try {
    await writeLockAtomically(lockFile, myPayload);
    return ok(undefined);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') {
      return err<TiError>({
        kind: 'StorageWriteError',
        message: `Failed to acquire lock at ${lockFile}: ${e instanceof Error ? e.message : String(e)}`,
        path: lockFile,
      });
    }
  }
  const existing = await readExistingLock(lockFile);
  if (existing === null) {
    await fs.unlink(lockFile);
    try {
      await writeLockAtomically(lockFile, myPayload);
      return ok(undefined);
    } catch (e) {
      return err<TiError>({
        kind: 'StorageWriteError',
        message: `Failed to reclaim corrupt lock: ${e instanceof Error ? e.message : String(e)}`,
        path: lockFile,
      });
    }
  }
  if (existing.hostname !== os.hostname()) {
    return err<TiError>({
      kind: 'LockHostMismatchError',
      message: `Lock at ${lockFile} is held by host '${existing.hostname}' (pid ${String(existing.pid)}, command '${existing.command}', started ${existing.startedAt}). Local hostname is '${os.hostname()}'. Run 'ti unlock --force' to override.`,
      holderHostname: existing.hostname,
      localHostname: os.hostname(),
    });
  }
  if (isPidAlive(existing.pid)) {
    return err<TiError>({
      kind: 'LockHeldError',
      message: `Lock held by pid ${String(existing.pid)} (command '${existing.command}', started ${existing.startedAt}).`,
      holderPid: existing.pid,
      command: existing.command,
      startedAt: existing.startedAt,
    });
  }
  await fs.unlink(lockFile);
  try {
    await writeLockAtomically(lockFile, myPayload);
    return ok(undefined);
  } catch (e) {
    return err<TiError>({
      kind: 'StorageWriteError',
      message: `Failed to reclaim stale lock: ${e instanceof Error ? e.message : String(e)}`,
      path: lockFile,
    });
  }
}

export async function releaseLock(tiDir: string): Promise<void> {
  try {
    await fs.unlink(lockPath(tiDir));
  } catch {
    // Ignore — nothing to release.
  }
}

export type UnlockOutcome =
  | { readonly kind: 'no-lock' }
  | { readonly kind: 'released'; readonly previous: LockPayload | null };

export async function unlockManaged(args: {
  readonly tiDir: string;
  readonly force: boolean;
}): Promise<Result<UnlockOutcome, TiError>> {
  const lockFile = lockPath(args.tiDir);
  let existed: boolean;
  try {
    await fs.access(lockFile);
    existed = true;
  } catch {
    existed = false;
  }
  if (!existed) {
    return ok({ kind: 'no-lock' });
  }
  const payload = await readExistingLock(lockFile);
  // Unparseable payload: treat as orphaned garbage — remove unconditionally.
  if (payload === null) {
    await fs.unlink(lockFile).catch(() => { /* ignore */ });
    return ok({ kind: 'released', previous: null });
  }
  const localHostname = os.hostname();
  if (payload.hostname !== localHostname) {
    if (!args.force) {
      return err<TiError>({
        kind: 'LockHostMismatchError',
        message: `Lock at ${lockFile} was recorded by hostname '${payload.hostname}' (this host is '${localHostname}'). Re-run with 'ti unlock --force' to override after confirming the remote process is gone.`,
        holderHostname: payload.hostname,
        localHostname,
      });
    }
    await fs.unlink(lockFile).catch(() => { /* ignore */ });
    return ok({ kind: 'released', previous: payload });
  }
  if (isPidAlive(payload.pid)) {
    return err<TiError>({
      kind: 'LockHeldError',
      message: `Lock is held by PID ${String(payload.pid)} running '${payload.command}' since ${payload.startedAt}. Wait for it or kill the process.`,
      holderPid: payload.pid,
      command: payload.command,
      startedAt: payload.startedAt,
    });
  }
  await fs.unlink(lockFile).catch(() => { /* ignore */ });
  return ok({ kind: 'released', previous: payload });
}

// Returns a function that unregisters all handlers. Callers use this when
// they want to detach cleanup (e.g., after releaseLock has already run).
export function registerLockCleanupOnExit(tiDir: string): () => void {
  const lockFile = lockPath(tiDir);
  const cleanup = (): void => {
    try {
      fsSync.unlinkSync(lockFile);
    } catch {
      // Ignore — nothing to clean up.
    }
  };
  const onSigint = (): void => {
    cleanup();
    process.exit(130);
  };
  const onSigterm = (): void => {
    cleanup();
    process.exit(143);
  };
  const onExit = (): void => {
    cleanup();
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('exit', onExit);
  return () => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('exit', onExit);
  };
}
