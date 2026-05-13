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
});
