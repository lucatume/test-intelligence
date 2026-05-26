import { describe, it, expect } from 'vitest';
import { parsePattern } from '../../../src/extract/declarative/pattern.js';
import { __testRestUrlNormalise as norm } from '../../../src/extract/declarative/engine.js';

describe('pattern parser accepts rest-url-normalise transform', () => {
  it('parses a pattern declaring transform: rest-url-normalise', () => {
    const r = parsePattern({
      match: { lang: 'ts', nodeKind: 'method-call', name: 'get', receiver: 'request' },
      bind: { url: { arg: 0, type: 'string' } },
      emit: 'rest-call-js',
      anchor: { template: 'rest:GET {url}', role: 'target' },
      transform: 'rest-url-normalise',
    });
    expect(r.kind).toBe('ok');
  });
});

describe('rest-url-normalise URL handling', () => {
  it.each([
    ['./wp-json/wc/v3/customers',                 '/wc/v3/customers'],
    ['/wp-json/wc/v3/customers',                  '/wc/v3/customers'],
    ['wp-json/wc/v3/customers',                   '/wc/v3/customers'],
    ['./wp-json/wc/v3/customers?per_page=10',     '/wc/v3/customers'],
    ['./wp-json/wc/v3/products/{*}/variations',   '/wc/v3/products/{*}/variations'],
    ['/wp-json/wc-admin/options?options=foo',     '/wc-admin/options'],
    ['/wc/v3/customers',                          '/wc/v3/customers'],   // already normalised
    ['https://example.test/wp-json/wc/v3/orders', '/wc/v3/orders'],
    ['',                                          null],                  // empty drops fact
    ['/wp-admin/admin.php?page=wc-settings',      null],                  // not a wp-json URL
  ])('normalises %s → %s', (input, expected) => {
    expect(norm(input)).toBe(expected);
  });
});
