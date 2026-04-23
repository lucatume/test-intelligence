import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { TiError } from '../errors.js';

// v1 ships at schema version 1. The range widens in Plan C when `ti migrate`
// introduces a second supported version; until then, min === max.
export const SUPPORTED_SCHEMA = { min: 1, max: 1 } as const;

export function checkSchemaRange(onDisk: number): Result<number, TiError> {
  if (!Number.isInteger(onDisk)) {
    return err<TiError>({
      kind: 'SchemaOutOfRangeError',
      message: `schema-version must be an integer, got ${String(onDisk)}`,
      onDisk,
      supported: { min: SUPPORTED_SCHEMA.min, max: SUPPORTED_SCHEMA.max },
    });
  }
  if (onDisk < SUPPORTED_SCHEMA.min) {
    return err<TiError>({
      kind: 'SchemaOutOfRangeError',
      message: `schema-version ${String(onDisk)} is below supported range [${String(SUPPORTED_SCHEMA.min)}, ${String(SUPPORTED_SCHEMA.max)}]. Run 'ti migrate' to upgrade.`,
      onDisk,
      supported: { min: SUPPORTED_SCHEMA.min, max: SUPPORTED_SCHEMA.max },
    });
  }
  if (onDisk > SUPPORTED_SCHEMA.max) {
    return err<TiError>({
      kind: 'SchemaOutOfRangeError',
      message: `schema-version ${String(onDisk)} is above supported range [${String(SUPPORTED_SCHEMA.min)}, ${String(SUPPORTED_SCHEMA.max)}]. Upgrade the 'ti' package.`,
      onDisk,
      supported: { min: SUPPORTED_SCHEMA.min, max: SUPPORTED_SCHEMA.max },
    });
  }
  return ok(onDisk);
}

export async function readSchemaVersion(
  tiDir: string,
): Promise<Result<number, TiError>> {
  const file = path.join(tiDir, 'schema-version');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return err<TiError>({
      kind: 'MapNotFoundError',
      message: `No schema-version at ${file}. Run 'ti build' first.`,
    });
  }
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (trimmed === '' || !Number.isInteger(parsed)) {
    return err<TiError>({
      kind: 'SchemaOutOfRangeError',
      message: `schema-version file at ${file} is not a valid integer (got "${trimmed}")`,
      onDisk: parsed,
      supported: { min: SUPPORTED_SCHEMA.min, max: SUPPORTED_SCHEMA.max },
    });
  }
  return ok(parsed);
}
