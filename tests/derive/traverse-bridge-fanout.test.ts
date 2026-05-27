import { describe, it, expect } from 'vitest';
import { traverseTest } from '../../src/derive/traverse.js';
import { buildAnchorIndex } from '../../src/derive/anchor-index.js';
import { evidenceConfidence, combineConfidence } from '../../src/derive/confidence.js';
import { unsafeCoerce } from '../helpers/unsafeCoerce.js';
import type { Graph, FactRow, FileRow, FactAnchorLink } from '../../src/derive/types.js';
import type { AnchorKey } from '../../src/types.js';

const k = (s: string): AnchorKey => unsafeCoerce<AnchorKey>(s);

const DEFAULT_OPTS = {
  maxDepth: 25,
  maxMillisPerTest: 5000,
  threshold: 0,
  hookStopList: new Set<string>(),
  now: () => 0,
  maxWildcardMatchesPerAnchor: 32,
};

const testFile: FileRow = {
  id: 1, path: 'tests/products.test.ts', language: 'ts', vendor: false,
  framework: 'playwright', frameworkClass: 'e2e',
};
const phpFile: FileRow = {
  id: 2, path: 'src/font-faces.php', language: 'php', vendor: false,
  framework: null, frameworkClass: null,
};

function buildGraph(opts: {
  numSeeds: number;
  numDestSubjects: number;
}): Graph {
  const facts = new Map<number, FactRow>();
  const links: FactAnchorLink[] = [];
  const testFileFacts: FactRow[] = [];
  for (let i = 0; i < opts.numSeeds; i++) {
    const id = 100 + i;
    const f: FactRow = {
      id, fileId: 1, kind: 'rest-call-js', resolved: true,
      startLine: 1, endLine: 1,
      payload: { kind: 'rest-call-js', url: '/wc/v3/products' },
    };
    facts.set(id, f);
    testFileFacts.push(f);
    links.push({ factId: id, anchorKey: k('rest:GET /wc/v3/products'), role: 'target' });
  }
  const phpFacts: FactRow[] = [];
  for (let j = 0; j < opts.numDestSubjects; j++) {
    const id = 200 + j;
    const f: FactRow = {
      id, fileId: 2, kind: 'rest-endpoint', resolved: false,
      startLine: 10 + j, endLine: 10 + j,
      payload: { kind: 'rest-endpoint', method: 'GET', route: '/{*}', namespace: '{*}' },
    };
    facts.set(id, f);
    phpFacts.push(f);
    links.push({ factId: id, anchorKey: k('rest:GET /{*}/{*}'), role: 'subject' });
  }
  return {
    files: new Map([[1, testFile], [2, phpFile]]),
    facts,
    factsByFile: new Map([[1, testFileFacts], [2, phpFacts]]),
    anchorLinks: links,
    tests: [],
  };
}

describe('traverseTest — bridge-arrival evidence dedup by destination fact', () => {
  it('one seed → one broad-wildcard partner: combined confidence is one observation', () => {
    const g = buildGraph({ numSeeds: 1, numDestSubjects: 1 });
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', DEFAULT_OPTS);
    expect(r.edges).toHaveLength(1);
    const expected = evidenceConfidence('rest-mediated', 'wildcardBroad', 1, true);
    expect(r.edges[0]?.confidence).toBeCloseTo(combineConfidence([expected]));
  });

  it('many seeds → one broad-wildcard partner: still one observation, NOT saturated', () => {
    const g = buildGraph({ numSeeds: 50, numDestSubjects: 1 });
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', DEFAULT_OPTS);
    expect(r.edges).toHaveLength(1);
    // Same single destination fact reached 50 times must combine as ONE observation.
    const expected = evidenceConfidence('rest-mediated', 'wildcardBroad', 1, true);
    expect(r.edges[0]?.confidence).toBeCloseTo(combineConfidence([expected]));
    // Sanity check: saturation would push confidence above 0.9 — assert it does NOT.
    expect(r.edges[0]?.confidence).toBeLessThan(0.5);
  });

  it('one seed → two distinct broad-wildcard partners in same file: two observations', () => {
    const g = buildGraph({ numSeeds: 1, numDestSubjects: 2 });
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', DEFAULT_OPTS);
    expect(r.edges).toHaveLength(1);
    // Two distinct destFactIds are genuinely independent observations.
    const expected = evidenceConfidence('rest-mediated', 'wildcardBroad', 1, true);
    expect(r.edges[0]?.confidence).toBeCloseTo(combineConfidence([expected, expected]));
  });

  it('many seeds → two distinct broad-wildcard partners: two observations (not 2N)', () => {
    const g = buildGraph({ numSeeds: 50, numDestSubjects: 2 });
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', DEFAULT_OPTS);
    expect(r.edges).toHaveLength(1);
    const expected = evidenceConfidence('rest-mediated', 'wildcardBroad', 1, true);
    expect(r.edges[0]?.confidence).toBeCloseTo(combineConfidence([expected, expected]));
  });

  it('regression: distinct exact-match destinations still combine disjunctively', () => {
    // Two symbol-use facts in the test file each landing on a distinct symbol-def in
    // the SAME source file. They are two genuine observations, not one. Must combine
    // disjunctively, same as before the fix.
    const tFile: FileRow = {
      id: 1, path: 'tests/a.test.ts', language: 'ts', vendor: false,
      framework: 'jest', frameworkClass: 'unit',
    };
    const sFile: FileRow = {
      id: 2, path: 'src/lib.ts', language: 'ts', vendor: false,
      framework: null, frameworkClass: null,
    };
    const useFoo: FactRow = {
      id: 100, fileId: 1, kind: 'symbol-use', resolved: true,
      startLine: 1, endLine: 1, payload: { kind: 'symbol-use', name: 'foo' },
    };
    const useBar: FactRow = {
      id: 101, fileId: 1, kind: 'symbol-use', resolved: true,
      startLine: 2, endLine: 2, payload: { kind: 'symbol-use', name: 'bar' },
    };
    const defFoo: FactRow = {
      id: 200, fileId: 2, kind: 'symbol-def', resolved: true,
      startLine: 1, endLine: 1, payload: { kind: 'symbol-def', name: 'foo' },
    };
    const defBar: FactRow = {
      id: 201, fileId: 2, kind: 'symbol-def', resolved: true,
      startLine: 2, endLine: 2, payload: { kind: 'symbol-def', name: 'bar' },
    };
    const g: Graph = {
      files: new Map([[1, tFile], [2, sFile]]),
      facts: new Map([[100, useFoo], [101, useBar], [200, defFoo], [201, defBar]]),
      factsByFile: new Map([[1, [useFoo, useBar]], [2, [defFoo, defBar]]]),
      anchorLinks: [
        { factId: 100, anchorKey: k('php-symbol:foo'), role: 'target' },
        { factId: 101, anchorKey: k('php-symbol:bar'), role: 'target' },
        { factId: 200, anchorKey: k('php-symbol:foo'), role: 'subject' },
        { factId: 201, anchorKey: k('php-symbol:bar'), role: 'subject' },
      ],
      tests: [],
    };
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', DEFAULT_OPTS);
    expect(r.edges).toHaveLength(1);
    // Two distinct symbol-def destFactIds, each an exact-match bridge → two observations.
    const expected = evidenceConfidence('symbol-call', 'exact', 1, true);
    expect(r.edges[0]?.confidence).toBeCloseTo(combineConfidence([expected, expected]));
  });
});
