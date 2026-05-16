import { describe, it, expect } from 'vitest';
import { parseFact } from '../../src/facts/parse.js';

describe('parseFact', () => {
  it('accepts a minimal symbol-def', () => {
    const r = parseFact({
      kind: 'symbol-def',
      resolved: true,
      location: { file: 'src/cart.ts', startLine: 4, endLine: 4 },
      anchors: [{ key: 'js-symbol:src/cart.ts:addItem', role: 'subject' }],
      payload: { kind: 'symbol-def', name: 'addItem', exported: true },
    });
    expect(r.kind).toBe('ok');
  });

  it('rejects mismatched outer/payload kind', () => {
    const r = parseFact({
      kind: 'symbol-def',
      resolved: true,
      location: { file: 'src/cart.ts', startLine: 1, endLine: 1 },
      anchors: [],
      payload: { kind: 'import-edge', specifier: './x', resolved: true },
    });
    expect(r.kind).toBe('err');
  });

  it('rejects bad anchor role', () => {
    const r = parseFact({
      kind: 'symbol-def',
      resolved: true,
      location: { file: 'src/cart.ts', startLine: 1, endLine: 1 },
      anchors: [{ key: 'js-symbol:src/cart.ts:x', role: 'whatever' }],
      payload: { kind: 'symbol-def', name: 'x', exported: false },
    });
    expect(r.kind).toBe('err');
  });

  it('rejects unparseable anchor key', () => {
    const r = parseFact({
      kind: 'import-edge',
      resolved: false,
      location: { file: 'src/a.ts', startLine: 1, endLine: 1 },
      anchors: [{ key: 'not-a-real-anchor-key', role: 'module' }],
      payload: { kind: 'import-edge', specifier: './x', resolved: false },
    });
    expect(r.kind).toBe('err');
  });

  it('accepts an import-edge with a js-module anchor', () => {
    const r = parseFact({
      kind: 'import-edge',
      resolved: true,
      location: { file: 'src/a.ts', startLine: 2, endLine: 2 },
      anchors: [{ key: 'js-module:src/helpers.ts', role: 'module' }],
      payload: {
        kind: 'import-edge',
        specifier: './helpers',
        resolved: true,
        resolvedPath: 'src/helpers.ts',
      },
    });
    expect(r.kind).toBe('ok');
  });

  it('accepts a test-def with a test anchor', () => {
    const r = parseFact({
      kind: 'test-def',
      resolved: true,
      location: { file: 'tests/cart.test.ts', startLine: 5, endLine: 5 },
      anchors: [{ key: 'test:jest:tests/cart.test.ts::adds items', role: 'subject' }],
      payload: {
        kind: 'test-def',
        framework: 'jest',
        testId: 'jest:tests/cart.test.ts::adds items',
        title: 'adds items',
      },
    });
    expect(r.kind).toBe('ok');
  });

  it('rejects negative line numbers', () => {
    const r = parseFact({
      kind: 'symbol-def',
      resolved: true,
      location: { file: 'src/a.ts', startLine: -1, endLine: 1 },
      anchors: [],
      payload: { kind: 'symbol-def', name: 'a', exported: false },
    });
    expect(r.kind).toBe('err');
  });

  it('parses an admin-page-nav fact', () => {
    const r = parseFact({
      kind: 'admin-page-nav',
      resolved: true,
      location: { file: 'tests/e2e-pw/settings.spec.ts', startLine: 3, endLine: 3 },
      anchors: [{ key: 'wp-admin-page:wc-settings', role: 'target' }],
      payload: {
        kind: 'admin-page-nav',
        url: 'wp-admin/admin.php?page=wc-settings',
        slug: 'wc-settings',
        method: 'goto',
      },
    });
    expect(r.kind).toBe('ok');
  });

  it('parses an admin-page-register fact', () => {
    const r = parseFact({
      kind: 'admin-page-register',
      resolved: true,
      location: { file: 'includes/admin/class-wc-admin-menus.php', startLine: 123, endLine: 130 },
      anchors: [{ key: 'wp-admin-page:wc-settings', role: 'subject' }],
      payload: { kind: 'admin-page-register', slug: 'wc-settings', fn: 'add_submenu_page' },
    });
    expect(r.kind).toBe('ok');
  });

  it('parses a store-register fact', () => {
    const r = parseFact({
      kind: 'store-register',
      resolved: true,
      location: { file: 'client/data/plugins/index.js', startLine: 10, endLine: 14 },
      anchors: [{ key: 'wp-store:wc/admin/plugins', role: 'subject' }],
      payload: { kind: 'store-register', key: 'wc/admin/plugins' },
    });
    expect(r.kind).toBe('ok');
  });

  it('parses a store-access fact', () => {
    const r = parseFact({
      kind: 'store-access',
      resolved: true,
      location: { file: 'client/components/Foo.js', startLine: 5, endLine: 5 },
      anchors: [{ key: 'wp-store:core/editor', role: 'target' }],
      payload: { kind: 'store-access', key: 'core/editor' },
    });
    expect(r.kind).toBe('ok');
  });
});
