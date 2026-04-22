import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { TiError } from '../errors.js';
import type { Shard } from './shard.js';
import type { Index } from './index.js';

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

export type WriteShardArgs = {
  readonly tiDir: string;
  readonly shardFilename: string;
  readonly content: Shard;
};

export async function writeShard(args: WriteShardArgs): Promise<Result<void, TiError>> {
  const { tiDir, shardFilename, content } = args;
  const tmpDir = path.join(tiDir, '.tmp');
  const shardsDir = path.join(tiDir, 'shards');
  const tempFile = path.join(tmpDir, `${shardFilename}.${String(process.pid)}.tmp`);
  const finalFile = path.join(shardsDir, shardFilename);
  try {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.mkdir(shardsDir, { recursive: true });
    await fs.writeFile(tempFile, JSON.stringify(content, null, 2), 'utf8');
    await fsyncFile(tempFile);
    await fs.rename(tempFile, finalFile);
    await fsyncDir(shardsDir);
    return ok(undefined);
  } catch (e) {
    try { await fs.unlink(tempFile); } catch { /* ignore */ }
    return err<TiError>({
      kind: 'StorageWriteError',
      message: `Failed to write shard ${shardFilename}: ${e instanceof Error ? e.message : String(e)}`,
      path: finalFile,
    });
  }
}

export async function writeIndex(tiDir: string, index: Index): Promise<Result<void, TiError>> {
  const tmpDir = path.join(tiDir, '.tmp');
  const tempFile = path.join(tmpDir, `index.json.${String(process.pid)}.tmp`);
  const finalFile = path.join(tiDir, 'index.json');
  try {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(tempFile, JSON.stringify(index, null, 2), 'utf8');
    await fsyncFile(tempFile);
    await fs.rename(tempFile, finalFile);
    await fsyncDir(tiDir);
    return ok(undefined);
  } catch (e) {
    try { await fs.unlink(tempFile); } catch { /* ignore */ }
    return err<TiError>({
      kind: 'StorageWriteError',
      message: `Failed to write index: ${e instanceof Error ? e.message : String(e)}`,
      path: finalFile,
    });
  }
}
