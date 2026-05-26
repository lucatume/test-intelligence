import { describe, it, expect } from 'vitest';
import { parsePattern } from '../../../src/extract/declarative/pattern.js';
import { __testWpFrontendOrAdminUrl as resolve } from '../../../src/extract/declarative/engine.js';

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

describe('wp-frontend-or-admin-url catalogue', () => {
  it.each([
    ['/',                          'wp-frontend:home'],
    ['/wp-admin',                  'wp-admin-page:index.php'],
    ['/wp-admin/',                 'wp-admin-page:index.php'],
    ['/wp-admin/edit.php',         'wp-admin-page:edit.php'],
    ['/wp-admin/post-new.php',     'wp-admin-page:post-new.php'],
    ['/wp-admin/themes.php',       'wp-admin-page:themes.php'],
    ['/wp-admin/plugins.php',      'wp-admin-page:plugins.php'],
    ['/wp-admin/users.php',        'wp-admin-page:users.php'],
    ['/wp-admin/options-general.php', 'wp-admin-page:options-general.php'],
    ['/wp-login.php',              'wp-frontend:login'],
    ['/wp-admin/admin.php?page=x', null],   // handled by the older transform
    ['/hello-world/',              null],   // pretty permalink, no static target
    ['',                           null],
  ])('resolves %s → %s', (input, expected) => {
    expect(resolve(input)).toBe(expected);
  });
});
