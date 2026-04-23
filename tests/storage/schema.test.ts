import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {
  SUPPORTED_SCHEMA,
  readSchemaVersion,
  checkSchemaRange,
} from '../../src/storage/schema.js';
import { useTmpDir } from '../helpers/tmpDir.js';

describe('SUPPORTED_SCHEMA', () => {
  it('declares integer min and max', () => {
    expect(Number.isInteger(SUPPORTED_SCHEMA.min)).toBe(true);
    expect(Number.isInteger(SUPPORTED_SCHEMA.max)).toBe(true);
    expect(SUPPORTED_SCHEMA.min).toBeLessThanOrEqual(SUPPORTED_SCHEMA.max);
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
    if (r.kind === 'err' && r.error.kind === 'SchemaOutOfRangeError') {
      expect(r.error.onDisk).toBe(SUPPORTED_SCHEMA.min - 1);
      expect(r.error.message).toMatch(/ti migrate/);
    }
  });

  it('returns SchemaOutOfRangeError when above max', () => {
    const r = checkSchemaRange(SUPPORTED_SCHEMA.max + 1);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.kind).toBe('SchemaOutOfRangeError');
      expect(r.error.message).toMatch(/upgrade/i);
    }
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
});
