import { describe, it, expect } from 'vitest';
import { parsePattern } from '../../../src/extract/declarative/pattern.js';

describe('pattern parser accepts wp-frontend-or-admin-url', () => {
  it('parses a pattern declaring this transform', () => {
    const r = parsePattern({
      match: { lang: 'ts', nodeKind: 'method-call', name: 'goto', receiver: 'page' },
      bind: { url: { arg: 0, type: 'string' } },
      emit: 'admin-page-nav',
      anchor: { template: '{anchor}', role: 'target' },
      transform: 'wp-frontend-or-admin-url',
    });
    expect(r.kind).toBe('ok');
  });
});
