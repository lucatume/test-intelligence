import { describe, it, expect } from 'vitest';
import { traverseTest } from '../../src/derive/traverse.js';
import { buildAnchorIndex } from '../../src/derive/anchor-index.js';
import { unsafeCoerce } from '../helpers/unsafeCoerce.js';
import type { Graph, FactRow, FileRow } from '../../src/derive/types.js';
import type { AnchorKey } from '../../src/types.js';

const k = (s: string): AnchorKey => unsafeCoerce<AnchorKey>(s);

function tinyGraph(): Graph {
  // test (file 1) → imports file 2 (a.php) → fires hook 'thing' (file 2)
  // file 3 (b.php) listens for 'thing'
  const f1: FileRow = { id: 1, path: 'tests/cart.test.ts', language: 'ts', vendor: false, framework: 'jest', frameworkClass: 'unit' };
  const f2: FileRow = { id: 2, path: 'a.php', language: 'php', vendor: false, framework: null, frameworkClass: null };
  const f3: FileRow = { id: 3, path: 'b.php', language: 'php', vendor: false, framework: null, frameworkClass: null };

  const testDef: FactRow = {
    id: 100, fileId: 1, kind: 'test-def', resolved: true, startLine: 1, endLine: 1,
    payload: { kind: 'test-def', framework: 'jest', testId: 't1' },
  };
  const importToA: FactRow = {
    id: 101, fileId: 1, kind: 'import-edge', resolved: true, startLine: 1, endLine: 1,
    payload: { kind: 'import-edge', specifier: './a', resolved: true, resolvedPath: 'a.php' },
  };
  const fire: FactRow = {
    id: 200, fileId: 2, kind: 'hook-fire', resolved: true, startLine: 1, endLine: 1,
    payload: { kind: 'hook-fire', hook: 'thing' },
  };
  const listener: FactRow = {
    id: 300, fileId: 3, kind: 'hook-listener', resolved: true, startLine: 1, endLine: 1,
    payload: { kind: 'hook-listener', hook: 'thing' },
  };

  const facts = new Map<number, FactRow>([
    [100, testDef], [101, importToA], [200, fire], [300, listener],
  ]);
  const factsByFile = new Map<number, FactRow[]>([
    [1, [testDef, importToA]],
    [2, [fire]],
    [3, [listener]],
  ]);
  const anchorLinks = [
    { factId: 101, anchorKey: k('js-module:a.php'), role: 'module' as const },
    { factId: 200, anchorKey: k('hook:thing'), role: 'target' as const },
    { factId: 300, anchorKey: k('hook:thing'), role: 'subject' as const },
  ];
  return {
    files: new Map([[1, f1], [2, f2], [3, f3]]),
    facts,
    factsByFile,
    anchorLinks,
    tests: [{ testId: 't1', fileId: 1, framework: 'jest', frameworkClass: 'unit', factId: 100 }],
  };
}

describe('traverseTest', () => {
  it('reaches imported and hook-listener files', () => {
    const g = tinyGraph();
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', 'unit', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
    });
    const sources = r.edges.map((e) => e.source).sort();
    expect(sources).toEqual(['a.php', 'b.php']);
    expect(r.bounded).toBe(false);
  });

  it('respects hook stop-list', () => {
    const g = tinyGraph();
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', 'unit', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(['thing']), now: () => 0,
    });
    const sources = r.edges.map((e) => e.source).sort();
    expect(sources).toEqual(['a.php']);
  });

  it('drops edges below threshold', () => {
    const g = tinyGraph();
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', 'unit', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0.9,
      hookStopList: new Set(), now: () => 0,
    });
    const sources = r.edges.map((e) => e.source);
    expect(sources).not.toContain('b.php');
  });

  it('e2e tests walk REST edges; unit tests do not', () => {
    const f1: FileRow = { id: 1, path: 'tests/e2e.spec.ts', language: 'ts', vendor: false, framework: 'playwright', frameworkClass: 'e2e' };
    const f2: FileRow = { id: 2, path: 'src/endpoint.php', language: 'php', vendor: false, framework: null, frameworkClass: null };
    const td: FactRow = { id: 1, fileId: 1, kind: 'test-def', resolved: true, startLine: 1, endLine: 1, payload: {} };
    const rcj: FactRow = { id: 2, fileId: 1, kind: 'rest-call-js', resolved: true, startLine: 1, endLine: 1, payload: {} };
    const endpoint: FactRow = { id: 3, fileId: 2, kind: 'rest-endpoint', resolved: true, startLine: 1, endLine: 1, payload: {} };
    const g: Graph = {
      files: new Map([[1, f1], [2, f2]]),
      facts: new Map([[1, td], [2, rcj], [3, endpoint]]),
      factsByFile: new Map([[1, [td, rcj]], [2, [endpoint]]]),
      anchorLinks: [
        { factId: 2, anchorKey: k('rest:GET /x'), role: 'target' },
        { factId: 3, anchorKey: k('rest:GET /x'), role: 'subject' },
      ],
      tests: [],
    };
    const idx = buildAnchorIndex(g);

    const e2e = traverseTest(g, idx, 1, 't1', 'e2e', { maxDepth: 25, maxMillisPerTest: 5000, threshold: 0, hookStopList: new Set(), now: () => 0 });
    expect(e2e.edges.some((e) => e.source === 'src/endpoint.php')).toBe(true);

    const unit = traverseTest(g, idx, 1, 't2', 'unit', { maxDepth: 25, maxMillisPerTest: 5000, threshold: 0, hookStopList: new Set(), now: () => 0 });
    expect(unit.edges.some((e) => e.source === 'src/endpoint.php')).toBe(false);
  });
});
