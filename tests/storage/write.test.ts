import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { writeShard, writeIndex } from '../../src/storage/write.js';
import { useTmpDir } from '../helpers/tmpDir.js';

describe('writeShard — durable write sequence', () => {
  const tmp = useTmpDir('ti-write-');

  it('writes the shard content atomically to the final location', async () => {
    const root = tmp();
    const tiDir = path.join(root, '.test-intelligence');
    await fs.mkdir(path.join(tiDir, 'shards'), { recursive: true });
    await fs.mkdir(path.join(tiDir, '.tmp'), { recursive: true });

    const content = { source: 'src/x.ts', source_hash: 'sha1:y', tests: [], views: [] };
    const finalPath = path.join(tiDir, 'shards', 'deadbeef.json');

    const r = await writeShard({ tiDir, shardFilename: 'deadbeef.json', content });
    expect(r.kind).toBe('ok');

    const onDisk: unknown = JSON.parse(await fs.readFile(finalPath, 'utf8'));
    expect(onDisk).toEqual(content);
  });

  it('leaves no temp files behind after success', async () => {
    const root = tmp();
    const tiDir = path.join(root, '.test-intelligence');
    await fs.mkdir(path.join(tiDir, 'shards'), { recursive: true });
    await fs.mkdir(path.join(tiDir, '.tmp'), { recursive: true });

    await writeShard({
      tiDir,
      shardFilename: 'a.json',
      content: { source: 's', source_hash: 'h', tests: [], views: [] },
    });
    const tmpContents = await fs.readdir(path.join(tiDir, '.tmp'));
    expect(tmpContents).toEqual([]);
  });
});

describe('writeIndex — durable write sequence', () => {
  const tmp = useTmpDir('ti-writeidx-');

  it('writes index.json atomically', async () => {
    const root = tmp();
    const tiDir = path.join(root, '.test-intelligence');
    await fs.mkdir(path.join(tiDir, '.tmp'), { recursive: true });

    const idx = { by_test: {}, by_view: {}, by_path: { 'src/x.ts': 'deadbeef' } };
    const r = await writeIndex(tiDir, idx);
    expect(r.kind).toBe('ok');

    const onDisk: unknown = JSON.parse(await fs.readFile(path.join(tiDir, 'index.json'), 'utf8'));
    expect(onDisk).toEqual(idx);
  });
});
