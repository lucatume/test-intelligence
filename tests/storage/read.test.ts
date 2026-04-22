import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { readShard, readIndex } from '../../src/storage/read.js';
import { useTmpDir } from '../helpers/tmpDir.js';

describe('readShard', () => {
  const tmp = useTmpDir('ti-readshard-');

  it('returns the parsed shard for a valid file', async () => {
    const root = tmp();
    await fs.mkdir(path.join(root, '.test-intelligence', 'shards'), { recursive: true });
    const shardPath = path.join(root, '.test-intelligence', 'shards', 'abc123.json');
    await fs.writeFile(shardPath, JSON.stringify({
      source: 'src/x.ts',
      source_hash: 'sha1:y',
      tests: [],
      views: [],
    }));
    const r = await readShard(shardPath);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.source).toBe('src/x.ts');
  });

  it('returns ShardCorruptError on malformed JSON', async () => {
    const root = tmp();
    const shardPath = path.join(root, 'bad.json');
    await fs.writeFile(shardPath, 'not json');
    const r = await readShard(shardPath);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.kind).toBe('ShardCorruptError');
  });

  it('returns ShardCorruptError for a file failing schema validation', async () => {
    const root = tmp();
    const shardPath = path.join(root, 'wrong.json');
    await fs.writeFile(shardPath, JSON.stringify({ source: 'x' })); // missing fields
    const r = await readShard(shardPath);
    expect(r.kind).toBe('err');
  });

  it('returns ShardCorruptError when the shard file does not exist', async () => {
    const root = tmp();
    const r = await readShard(path.join(root, 'nope.json'));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.kind).toBe('ShardCorruptError');
  });
});

describe('readIndex', () => {
  const tmp = useTmpDir('ti-readindex-');

  it('returns a parsed index', async () => {
    const root = tmp();
    await fs.mkdir(path.join(root, '.test-intelligence'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.test-intelligence', 'index.json'),
      JSON.stringify({ by_test: {}, by_view: {}, by_path: {} }),
    );
    const r = await readIndex(path.join(root, '.test-intelligence'));
    expect(r.kind).toBe('ok');
  });

  it('returns MapNotFoundError when the index is missing', async () => {
    const r = await readIndex(path.join(tmp(), '.test-intelligence'));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.kind).toBe('MapNotFoundError');
  });

  it('returns ShardCorruptError on malformed JSON in index.json', async () => {
    const root = tmp();
    await fs.mkdir(path.join(root, '.test-intelligence'), { recursive: true });
    await fs.writeFile(path.join(root, '.test-intelligence', 'index.json'), 'not json');
    const r = await readIndex(path.join(root, '.test-intelligence'));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.kind).toBe('ShardCorruptError');
  });
});
