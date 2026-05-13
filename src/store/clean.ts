import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Result } from '../result.js';
import { err, ok } from '../result.js';

export interface CleanOptions {
  readonly all: boolean;
  readonly force: boolean;
}

export interface CleanError {
  readonly kind: 'CleanError';
  readonly message: string;
}

const TI_DIR = '.ti';
const LOCK_FILE = '.lock';
const CONFIG_CANDIDATES = ['ti.config.ts', 'ti.config.mts', 'ti.config.mjs', 'ti.config.js', 'ti.config.cjs'];

export function removeStoreContents(
  projectRoot: string,
  options: CleanOptions,
): Result<undefined, CleanError> {
  const tiDir = join(projectRoot, TI_DIR);
  if (!existsSync(tiDir)) {
    if (options.all) deleteConfigFiles(projectRoot);
    return ok(undefined);
  }

  const lockPath = join(tiDir, LOCK_FILE);
  if (existsSync(lockPath) && !options.force) {
    try {
      const raw = readFileSync(lockPath, 'utf8');
      const parsed = JSON.parse(raw) as { pid?: number; hostname?: string };
      if (
        typeof parsed.pid === 'number' &&
        parsed.hostname === hostname() &&
        isPidAlive(parsed.pid)
      ) {
        return err({
          kind: 'CleanError',
          message: `lock held by live process (pid ${String(parsed.pid)}); re-run with --force`,
        });
      }
    } catch {
      // Unreadable lock — treat as stale.
    }
  }

  try {
    if (options.all) {
      rmSync(tiDir, { recursive: true, force: true });
      deleteConfigFiles(projectRoot);
    } else {
      for (const entry of readdirSync(tiDir)) {
        rmSync(join(tiDir, entry), { recursive: true, force: true });
      }
    }
    return ok(undefined);
  } catch (e) {
    return err({ kind: 'CleanError', message: (e as Error).message });
  }
}

function deleteConfigFiles(projectRoot: string): void {
  for (const candidate of CONFIG_CANDIDATES) {
    const p = join(projectRoot, candidate);
    if (existsSync(p)) {
      try {
        rmSync(p, { force: true });
      } catch {
        // tolerate
      }
    }
  }
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
