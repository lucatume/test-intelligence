import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { TiError } from '../errors.js';
import { parseShard, type Shard } from './shard.js';
import { parseIndex, type Index } from './index.js';

export async function readShard(absoluteShardPath: string): Promise<Result<Shard, TiError>> {
  let raw: string;
  try {
    raw = await fs.readFile(absoluteShardPath, 'utf8');
  } catch (e) {
    return err<TiError>({
      kind: 'ShardCorruptError',
      message: `Could not read shard ${absoluteShardPath}: ${e instanceof Error ? e.message : String(e)}`,
      shardPath: absoluteShardPath,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return err<TiError>({
      kind: 'ShardCorruptError',
      message: `Shard ${absoluteShardPath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      shardPath: absoluteShardPath,
    });
  }
  const schemaResult = parseShard(parsed);
  if (schemaResult.kind === 'err') {
    const summary = schemaResult.error.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    return err<TiError>({
      kind: 'ShardCorruptError',
      message: `Shard ${absoluteShardPath} failed schema validation: ${summary}`,
      shardPath: absoluteShardPath,
    });
  }
  return ok(schemaResult.value);
}

export async function readIndex(testIntelligenceDir: string): Promise<Result<Index, TiError>> {
  const indexPath = path.join(testIntelligenceDir, 'index.json');
  let raw: string;
  try {
    raw = await fs.readFile(indexPath, 'utf8');
  } catch {
    return err<TiError>({
      kind: 'MapNotFoundError',
      message: `No map found at ${testIntelligenceDir}. Run 'ti build' first.`,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return err<TiError>({
      kind: 'ShardCorruptError',
      message: `Index ${indexPath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      shardPath: indexPath,
    });
  }
  const schemaResult = parseIndex(parsed);
  if (schemaResult.kind === 'err') {
    const summary = schemaResult.error.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    return err<TiError>({
      kind: 'ShardCorruptError',
      message: `Index ${indexPath} failed schema validation: ${summary}`,
      shardPath: indexPath,
    });
  }
  return ok(schemaResult.value);
}
