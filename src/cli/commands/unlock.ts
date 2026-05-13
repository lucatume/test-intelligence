import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Io } from '../io.js';
import { releaseLock } from '../../store/lock.js';

export interface UnlockCommandArgs {
  readonly projectRoot: string;
  readonly io: Io;
  readonly force: boolean;
}

export function unlockCommand(args: UnlockCommandArgs): number {
  const lockPath = join(args.projectRoot, '.ti/.lock');
  if (!existsSync(lockPath)) {
    args.io.stderr.write('ti: no lock to release\n');
    return 0;
  }
  if (!args.force) {
    try {
      const raw = readFileSync(lockPath, 'utf8');
      const parsed = JSON.parse(raw) as { pid?: number; hostname?: string };
      if (
        typeof parsed.pid === 'number' &&
        parsed.hostname === hostname() &&
        isPidAlive(parsed.pid)
      ) {
        args.io.stderr.write(
          `ti: lock held by live process (pid ${String(parsed.pid)}); re-run with --force\n`,
        );
        return 1;
      }
    } catch {
      // Unreadable lock — fall through and unlink anyway.
    }
  }
  releaseLock(args.projectRoot);
  args.io.stderr.write('ti: lock released\n');
  return 0;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true;
  }
}
