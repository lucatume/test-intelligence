import { describe, it, expect } from 'vitest';
import { parseIndex } from '../../src/storage/index.js';

describe('parseIndex', () => {
  it('accepts a well-formed index', () => {
    const r = parseIndex({
      by_test: { 'phpunit:tests/CartTest.php::testAdd': ['hash1'] },
      by_view: { 'rest:POST /api/v1/cart': ['hash2'] },
      by_path: { 'src/Cart.php': 'hash1' },
    });
    expect(r.kind).toBe('ok');
  });

  it('accepts an empty index', () => {
    const r = parseIndex({ by_test: {}, by_view: {}, by_path: {} });
    expect(r.kind).toBe('ok');
  });

  it('rejects missing sections', () => {
    const r = parseIndex({ by_test: {}, by_view: {} });
    expect(r.kind).toBe('err');
  });

  it('rejects non-array values in by_test', () => {
    const r = parseIndex({ by_test: { x: 'not-array' }, by_view: {}, by_path: {} });
    expect(r.kind).toBe('err');
  });
});
