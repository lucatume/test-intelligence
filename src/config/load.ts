import { createJiti } from 'jiti';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { TiError } from '../errors.js';

const CONFIG_KEYS = new Set([
  'default',
  'tests',
  'hooks',
  'extractors',
  'confidence',
  'traversal',
  'concurrency',
  'build',
  'ignore',
  'vendor',
  'allowSymlinkTargets',
  'wpPatternWrappers',
]);

function hasNoDefaultExport(mod: unknown): boolean {
  if (typeof mod !== 'object' || mod === null) return false;
  const keys = Object.keys(mod);
  return keys.length > 0 && keys.every((k) => !CONFIG_KEYS.has(k));
}

function resolveDefault(mod: unknown): unknown {
  if (typeof mod !== 'object' || mod === null) return mod;
  const rec = mod as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(rec, 'default') ? rec['default'] : mod;
}

export async function loadConfigFile(
  absolutePath: string,
): Promise<Result<unknown, TiError>> {
  try {
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    const mod: unknown = await jiti.import(absolutePath);
    if (mod === undefined || mod === null) {
      return err<TiError>({
        kind: 'ConfigError',
        message: `Config file ${absolutePath} exported no default`,
        path: absolutePath,
      });
    }
    if (hasNoDefaultExport(mod)) {
      return err<TiError>({
        kind: 'ConfigError',
        message: `Config file ${absolutePath} has no default export`,
        path: absolutePath,
      });
    }
    return ok(resolveDefault(mod));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err<TiError>({
      kind: 'ConfigError',
      message: `Failed to load config ${absolutePath}: ${message}`,
      path: absolutePath,
    });
  }
}
