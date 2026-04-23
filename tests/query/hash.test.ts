import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { computeSourceHash } from '../../src/query/hash.js';
import { useTmpDir } from '../helpers/tmpDir.js';

describe('computeSourceHash', () => {
  const tmp = useTmpDir('ti-hash-');

  it('returns sha1:<40-hex> for a readable file', async () => {
    const f = path.join(tmp(), 'x.txt');
    await fs.writeFile(f, 'hello');
    const r = await computeSourceHash(f);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      // sha1("hello") = "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d"
      expect(r.value).toBe('sha1:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
    }
  });

  it('is deterministic and byte-exact', async () => {
    const f1 = path.join(tmp(), 'a.txt');
    const f2 = path.join(tmp(), 'b.txt');
    await fs.writeFile(f1, 'same');
    await fs.writeFile(f2, 'same');
    const r1 = await computeSourceHash(f1);
    const r2 = await computeSourceHash(f2);
    expect(r1.kind).toBe('ok');
    expect(r2.kind).toBe('ok');
    if (r1.kind === 'ok' && r2.kind === 'ok') expect(r1.value).toBe(r2.value);
  });

  it('returns an error result when the file is missing (not a throw)', async () => {
    const r = await computeSourceHash(path.join(tmp(), 'nope'));
    expect(r.kind).toBe('err');
  });
});
