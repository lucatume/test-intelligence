import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { TiError } from '../errors.js';

export type ResolvedProjectRoot = {
  readonly projectRoot: string;
  readonly configFile: string;
};

// Preference order matters: a user with both .ts and .js gets .ts loaded.
export const CONFIG_CANDIDATES: readonly string[] = [
  'ti.config.ts',
  'ti.config.mts',
  'ti.config.mjs',
  'ti.config.js',
  'ti.config.cjs',
];

export async function resolveProjectRoot(
  startDir: string,
): Promise<Result<ResolvedProjectRoot, TiError>> {
  let dir = path.resolve(startDir);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    for (const candidate of CONFIG_CANDIDATES) {
      const full = path.join(dir, candidate);
      try {
        const stat = await fs.stat(full);
        if (stat.isFile()) {
          return ok({ projectRoot: dir, configFile: full });
        }
      } catch {
        // File doesn't exist at this candidate — try next.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return err<TiError>({
        kind: 'ConfigError',
        message: `No ti.config.{ts,mts,mjs,js,cjs} found walking up from ${startDir}. Run 'ti init' to create one.`,
      });
    }
    dir = parent;
  }
}
