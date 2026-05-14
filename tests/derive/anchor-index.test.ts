import { describe, it, expect } from 'vitest';
import { buildAnchorIndex } from '../../src/derive/anchor-index.js';
import type { WildcardAnchorEntry } from '../../src/derive/anchor-index.js';
import type { Graph, FactRow, FileRow } from '../../src/derive/types.js';
import { unsafeCoerce } from '../helpers/unsafeCoerce.js';
import type { AnchorKey } from '../../src/types.js';

const k = (s: string): AnchorKey => unsafeCoerce<AnchorKey>(s);

const fire: FactRow = {
  id: 10, fileId: 1, kind: 'hook-fire', resolved: true,
  startLine: 1, endLine: 1, payload: { kind: 'hook-fire', hook: 'thing' },
};
const listener: FactRow = {
  id: 11, fileId: 2, kind: 'hook-listener', resolved: true,
  startLine: 1, endLine: 1, payload: { kind: 'hook-listener', hook: 'thing' },
};

const fileA: FileRow = { id: 1, path: 'a.php', language: 'php', vendor: false, framework: null, frameworkClass: null };
const fileB: FileRow = { id: 2, path: 'b.php', language: 'php', vendor: false, framework: null, frameworkClass: null };

const graph: Graph = {
  files: new Map([[1, fileA], [2, fileB]]),
  facts: new Map([[10, fire], [11, listener]]),
  factsByFile: new Map([[1, [fire]], [2, [listener]]]),
  anchorLinks: [
    { factId: 10, anchorKey: k('hook:my_action'), role: 'target' },
    { factId: 11, anchorKey: k('hook:my_action'), role: 'subject' },
  ],
  tests: [],
};

describe('buildAnchorIndex', () => {
  it('groups facts by anchor + role', () => {
    const idx = buildAnchorIndex(graph);
    expect(idx.subjectsByAnchor.get(k('hook:my_action'))?.map((f) => f.id)).toEqual([11]);
    expect(idx.targetsByAnchor.get(k('hook:my_action'))?.map((f) => f.id)).toEqual([10]);
  });

  it('exposes links by fact', () => {
    const idx = buildAnchorIndex(graph);
    expect(idx.linksByFact.get(10)?.map((l) => l.role)).toEqual(['target']);
    expect(idx.linksByFact.get(11)?.map((l) => l.role)).toEqual(['subject']);
  });
});

describe('buildAnchorIndex — wildcard', () => {
  const wildFire: FactRow = {
    id: 20, fileId: 1, kind: 'hook-fire', resolved: false,
    startLine: 1, endLine: 1, payload: { kind: 'hook-fire', hook: 'wp_ajax_{*}' },
  };
  const literalListener: FactRow = {
    id: 21, fileId: 2, kind: 'hook-listener', resolved: true,
    startLine: 1, endLine: 1, payload: { kind: 'hook-listener', hook: 'wp_ajax_save' },
  };
  const wildcardGraph: Graph = {
    files: new Map([[1, fileA], [2, fileB]]),
    facts: new Map([[20, wildFire], [21, literalListener]]),
    factsByFile: new Map([[1, [wildFire]], [2, [literalListener]]]),
    anchorLinks: [
      { factId: 20, anchorKey: k('hook:wp_ajax_{*}'), role: 'target' },
      { factId: 21, anchorKey: k('hook:wp_ajax_save'), role: 'subject' },
    ],
    tests: [],
  };

  it('separates wildcard anchors into the wildcard table', () => {
    const idx = buildAnchorIndex(wildcardGraph);
    expect(idx.wildcardTargets.length).toBe(1);
    expect(idx.wildcardTargets[0]?.originalKey).toBe('hook:wp_ajax_{*}');
    expect(idx.wildcardTargets[0]?.facts.map((f) => f.id)).toEqual([20]);
    // Wildcard anchors are NOT also stored in the exact-key map.
    expect(idx.targetsByAnchor.get(k('hook:wp_ajax_{*}'))).toBeUndefined();
  });

  it('produces a regex that matches literal anchors with the same prefix', () => {
    const idx = buildAnchorIndex(wildcardGraph);
    const [entry] = idx.wildcardTargets;
    if (!entry) throw new Error('expected entry');
    const checked: WildcardAnchorEntry = entry;
    expect(checked.regex.test('hook:wp_ajax_save')).toBe(true);
    expect(checked.regex.test('hook:wp_ajax_save_order')).toBe(true);
    expect(checked.regex.test('hook:other_hook')).toBe(false);
  });

  it('still records linksByFact for wildcard-anchored facts', () => {
    const idx = buildAnchorIndex(wildcardGraph);
    expect(idx.linksByFact.get(20)?.map((l) => l.role)).toEqual(['target']);
  });

  it('exposes empty wildcard arrays when no wildcard anchors exist', () => {
    const idx = buildAnchorIndex(graph);
    expect(idx.wildcardSubjects).toEqual([]);
    expect(idx.wildcardTargets).toEqual([]);
    expect(idx.wildcardModules).toEqual([]);
    expect(idx.wildcardCallbacks).toEqual([]);
  });
});
