import { describe, it, expect } from 'vitest';
import { buildAnchorIndex } from '../../src/derive/anchor-index.js';
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
