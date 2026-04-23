import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {
  SUPPORTED_SCHEMA,
  readSchemaVersion,
  checkSchemaRange,
  writeSchemaVersion,
} from '../../src/storage/schema.js';
import { useTmpDir } from '../helpers/tmpDir.js';

describe('SUPPORTED_SCHEMA', () => {
  it('pins min and max to the current supported version', () => {
    expect(SUPPORTED_SCHEMA).toStrictEqual({ min: 1, max: 1 });
  });
});

describe('checkSchemaRange', () => {
  it('returns ok when on-disk version is in range', () => {
    const r = checkSchemaRange(SUPPORTED_SCHEMA.min);
    expect(r.kind).toBe('ok');
  });

  it('returns SchemaOutOfRangeError when below min', () => {
    const r = checkSchemaRange(SUPPORTED_SCHEMA.min - 1);
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    expect(r.error.kind).toBe('SchemaOutOfRangeError');
    if (r.error.kind !== 'SchemaOutOfRangeError') return;
    expect(r.error.onDisk).toBe(SUPPORTED_SCHEMA.min - 1);
    expect(r.error.message).toMatch(/ti migrate/);
  });

  it('returns SchemaOutOfRangeError when above max', () => {
    const r = checkSchemaRange(SUPPORTED_SCHEMA.max + 1);
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    expect(r.error.kind).toBe('SchemaOutOfRangeError');
    if (r.error.kind !== 'SchemaOutOfRangeError') return;
    expect(r.error.message).toMatch(/upgrade/i);
  });
});

describe('readSchemaVersion', () => {
  const tmp = useTmpDir('ti-schema-');

  it('reads and parses an integer schema-version file', async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    await fs.mkdir(tiDir, { recursive: true });
    await fs.writeFile(path.join(tiDir, 'schema-version'), '1\n');
    const r = await readSchemaVersion(tiDir);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value).toBe(1);
  });

  it('returns MapNotFoundError when the file is missing', async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    await fs.mkdir(tiDir, { recursive: true });
    const r = await readSchemaVersion(tiDir);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.kind).toBe('MapNotFoundError');
  });

  it('returns SchemaOutOfRangeError when content is not an integer', async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    await fs.mkdir(tiDir, { recursive: true });
    await fs.writeFile(path.join(tiDir, 'schema-version'), 'not-a-number');
    const r = await readSchemaVersion(tiDir);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.kind).toBe('SchemaOutOfRangeError');
  });

  it("returns ok for any integer content, even one outside SUPPORTED_SCHEMA (range-checking is checkSchemaRange's job)", async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    await fs.mkdir(tiDir, { recursive: true });
    await fs.writeFile(path.join(tiDir, 'schema-version'), '999');
    const r = await readSchemaVersion(tiDir);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value).toBe(999);
  });
});

describe('writeSchemaVersion', () => {
  const tmp = useTmpDir('ti-schema-write-');

  it('writes the version and reads it back', async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    await fs.mkdir(tiDir, { recursive: true });
    const w = await writeSchemaVersion(tiDir, 1);
    expect(w.kind).toBe('ok');
    const r = await readSchemaVersion(tiDir);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value).toBe(1);
  });

  it('leaves no temp files behind after success', async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    await fs.mkdir(tiDir, { recursive: true });
    await writeSchemaVersion(tiDir, 1);
    const tmpDir = path.join(tiDir, '.tmp');
    const entries = await fs.readdir(tmpDir).catch(() => [] as string[]);
    expect(entries).toEqual([]);
  });

  it('rejects non-integer values with a programmer-error throw', async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    await expect(writeSchemaVersion(tiDir, 1.5)).rejects.toThrow();
  });
});
