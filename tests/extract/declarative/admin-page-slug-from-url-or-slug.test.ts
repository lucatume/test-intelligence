import { describe, it, expect } from 'vitest';
import { parsePattern } from '../../../src/extract/declarative/pattern.js';
import { __testAdminPageSlugFromUrlOrSlug as slugFor } from '../../../src/extract/declarative/engine.js';

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

describe('admin-page-slug-from-url-or-slug URL handling', () => {
  it.each([
    ['admin.php?page=themes',  'themes'],
    ['admin.php?page=wc-orders&action=edit', 'wc-orders'],
    ['index.php',              'index.php'],
    ['edit.php',               'edit.php'],
    ['post-new.php',           'post-new.php'],
    ['options-general.php',    'options-general.php'],
    ['/wp-admin/edit.php',     'edit.php'],
    ['',                       null],
    ['some-non-admin-thing',   null],
  ])('slug for %s = %s', (input, expected) => {
    expect(slugFor(input)).toBe(expected);
  });
});
