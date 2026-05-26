import { describe, it, expect } from 'vitest';
import { parsePattern } from '../../../src/extract/declarative/pattern.js';

describe('pattern parser accepts admin-page-slug-from-url-or-slug', () => {
  it('parses a pattern with this transform', () => {
    const r = parsePattern({
      match: { lang: 'ts', nodeKind: 'method-call', name: 'visitAdminPage', receiver: 'admin' },
      bind: { adminPath: { arg: 0, type: 'string' } },
      emit: 'admin-page-nav',
      anchor: { template: 'wp-admin-page:{slug}', role: 'target' },
      transform: 'admin-page-slug-from-url-or-slug',
    });
    expect(r.kind).toBe('ok');
  });
});
