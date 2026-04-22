import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { parseTestId, formatTestId } from '../src/ids.js';

describe('parseTestId — well-formed ids', () => {
  let tmpRoot: string;
  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ids-'));
    await fs.mkdir(path.join(tmpRoot, 'tests', 'Shop'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'tests', 'Shop', 'CartTest.php'), '');
  });

  it('parses phpunit id with filter', () => {
    const r = parseTestId('phpunit:tests/Shop/CartTest.php::testAdd', tmpRoot);
    expect(r).toMatchObject({
      kind: 'ok',
      value: { framework: 'phpunit', filter: 'testAdd' },
    });
  });

  it('parses id without filter', () => {
    const r = parseTestId('jest:tests/cart.test.ts', tmpRoot);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.value.framework).toBe('jest');
      expect(r.value.filter).toBeUndefined();
    }
  });
});

describe('parseTestId — malformed', () => {
  it('rejects missing framework prefix', () => {
    const r = parseTestId('tests/CartTest.php::foo', '/tmp');
    expect(r).toMatchObject({ kind: 'err', error: { reason: 'malformed' } });
  });

  it('rejects unknown framework', () => {
    const r = parseTestId('mocha:tests/x.ts::foo', '/tmp');
    expect(r).toMatchObject({ kind: 'err', error: { reason: 'unknown-framework' } });
  });

  it('rejects empty path component', () => {
    const r = parseTestId('phpunit:::testAdd', '/tmp');
    expect(r).toMatchObject({ kind: 'err' });
  });

  it('propagates path-parser errors for absolute paths', () => {
    const r = parseTestId('phpunit:/etc/passwd::x', '/tmp');
    expect(r).toMatchObject({
      kind: 'err',
      error: { reason: 'path-invalid' },
    });
  });

  it('rejects framework prefix containing slashes (treated as malformed, not unknown)', () => {
    const r = parseTestId('src/CartTest.php::foo', '/tmp');
    expect(r).toMatchObject({ kind: 'err', error: { reason: 'malformed' } });
  });
});

describe('formatTestId — round-trip with parseTestId', () => {
  let tmpRoot: string;
  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ids-rt-'));
    await fs.mkdir(path.join(tmpRoot, 'tests'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'tests', 'x.test.ts'), '');
  });

  it('parses then formats back to the same id (with filter)', () => {
    const raw = 'jest:tests/x.test.ts::adds item';
    const parsed = parseTestId(raw, tmpRoot);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind === 'ok') expect(formatTestId(parsed.value)).toBe(raw);
  });
});
