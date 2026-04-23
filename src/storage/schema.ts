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

async function fsyncFile(absolutePath: string): Promise<void> {
  const fh = await fs.open(absolutePath, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function fsyncDir(dirPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const fh = await fs.open(dirPath, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export async function writeSchemaVersion(
  tiDir: string,
  version: number,
): Promise<Result<void, TiError>> {
  if (!Number.isInteger(version)) {
    throw new Error(`writeSchemaVersion: version must be an integer, got ${String(version)}`);
  }
  const tmpDir = path.join(tiDir, '.tmp');
  const finalFile = path.join(tiDir, 'schema-version');
  const tempFile = path.join(tmpDir, `schema-version.${String(process.pid)}.tmp`);
  try {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(tempFile, `${String(version)}\n`, 'utf8');
    await fsyncFile(tempFile);
    await fs.rename(tempFile, finalFile);
    await fsyncDir(tiDir);
    return ok(undefined);
  } catch (e) {
    try { await fs.unlink(tempFile); } catch { /* ignore */ }
    return err<TiError>({
      kind: 'StorageWriteError',
      message: `Failed to write schema-version: ${e instanceof Error ? e.message : String(e)}`,
      path: finalFile,
    });
  }
}
