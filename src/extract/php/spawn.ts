import { existsSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { err, ok, type Result } from '../../result.js';
import { Protocol } from './protocol.js';

export interface PhpWorker {
  ping(): Promise<boolean>;
  registerPatterns(patterns: readonly unknown[]): Promise<number>;
  extract(absFile: string, phpUnitBaseClasses?: readonly string[]): Promise<unknown>;
  shutdown(): Promise<void>;
}

export interface SpawnError {
  readonly kind: 'PhpSpawnError';
  readonly message: string;
}

export interface SpawnOptions {
  readonly repoRoot: string;
  readonly php?: string;
}

export function hasPhpAvailable(): boolean {
  const r = spawnSync('php', ['--version'], { stdio: 'ignore', shell: false });
  return r.status === 0;
}

export function startPhpWorker(opts: SpawnOptions): Result<PhpWorker, SpawnError> {
  const bin = opts.php ?? 'php';
  const worker = resolve(opts.repoRoot, 'vendor-php/bin/ti-php-extract.php');
  const autoload = resolve(opts.repoRoot, 'vendor-php/vendor/autoload.php');
  if (!existsSync(worker)) return err({ kind: 'PhpSpawnError', message: `worker not found at ${worker}` });
  if (!existsSync(autoload)) return err({ kind: 'PhpSpawnError', message: 'vendor-php/vendor missing - run `composer install` in vendor-php/' });
  if (!hasPhpAvailable()) return err({ kind: 'PhpSpawnError', message: 'php not on PATH' });

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(bin, [worker], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  } catch (e) {
    return err({ kind: 'PhpSpawnError', message: `spawn failed: ${(e as Error).message}` });
  }
  const proto = new Protocol(child);

  const workerApi: PhpWorker = {
    async ping(): Promise<boolean> {
      const r = await proto.request({ op: 'ping' });
      return (r as { op?: string }).op === 'pong';
    },
    async registerPatterns(patterns): Promise<number> {
      const r = await proto.request({ op: 'register-patterns', patterns });
      return (r as { count?: number }).count ?? 0;
    },
    async extract(absFile, phpUnitBaseClasses): Promise<unknown> {
      return await proto.request({
        op: 'extract',
        file: absFile,
        ...(phpUnitBaseClasses !== undefined ? { phpUnitBaseClasses } : {}),
      });
    },
    async shutdown(): Promise<void> {
      await proto.shutdown();
    },
  };
  return ok(workerApi);
}
