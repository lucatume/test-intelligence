import { describe, expect, it } from 'vitest';
import { buildAnchorIndex } from '../../src/derive/anchor-index.js';
import { directDependenciesFromSources } from '../../src/derive/traverse.js';
import type { FactRow, FileRow, Graph } from '../../src/derive/types.js';
import type { AnchorKey } from '../../src/types.js';
import { unsafeCoerce } from '../helpers/unsafeCoerce.js';

const key = (value: string): AnchorKey => unsafeCoerce<AnchorKey>(value);
const options = {
  maxDepth: 1,
  maxMillisPerTest: 5000,
  threshold: 0,
  hookStopList: new Set<string>(),
  now: () => 0,
  maxWildcardMatchesPerAnchor: 32,
};

describe('directDependenciesFromSources', () => {
  it('reports outgoing direct dependencies with aggregated kinds only', () => {
    const file = (id: number, path: string): FileRow => ({ id, path, language: path.endsWith('.php') ? 'php' : 'js', vendor: false, framework: null, frameworkClass: null });
    const fact = (id: number, fileId: number, kind: FactRow['kind'], payload: FactRow['payload']): FactRow =>
      ({ id, fileId, kind, resolved: true, startLine: 1, endLine: 1, payload });
    const importB = fact(1, 1, 'import-edge', { kind: 'import-edge', specifier: './b', resolved: true, resolvedPath: 'b.js' });
    const globalUse = fact(2, 1, 'symbol-use', { kind: 'symbol-use', name: 'wp.foo' });
    const bDef = fact(3, 2, 'symbol-def', { kind: 'symbol-def', name: 'b', exported: true });
    const globalDef = fact(4, 2, 'symbol-def', { kind: 'symbol-def', name: 'wp.foo', exported: true });
    const importC = fact(5, 2, 'import-edge', { kind: 'import-edge', specifier: './c', resolved: true, resolvedPath: 'c.js' });
    const cDef = fact(6, 3, 'symbol-def', { kind: 'symbol-def', name: 'c', exported: true });
    const graph: Graph = {
      files: new Map([[1, file(1, 'a.js')], [2, file(2, 'b.js')], [3, file(3, 'c.js')]]),
      facts: new Map([importB, globalUse, bDef, globalDef, importC, cDef].map((f) => [f.id, f])),
      factsByFile: new Map([[1, [importB, globalUse]], [2, [bDef, globalDef, importC]], [3, [cDef]]]),
      anchorLinks: [
        { factId: 2, anchorKey: key('js-global:wp.foo'), role: 'subject' },
        { factId: 4, anchorKey: key('js-global:wp.foo'), role: 'target' },
      ],
      tests: [],
    };
    const result = directDependenciesFromSources(graph, buildAnchorIndex(graph), ['a.js'], options);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ source: 'a.js', target: 'b.js', kinds: ['js-import', 'symbol-call'] });
    expect(result.rows.map((row) => row.target)).not.toContain('c.js');
  });

  it('deduplicates unknown paths and filters confidence', () => {
    const graph: Graph = { files: new Map(), facts: new Map(), factsByFile: new Map(), anchorLinks: [], tests: [] };
    expect(directDependenciesFromSources(graph, buildAnchorIndex(graph), ['missing.php', 'missing.php'], { ...options, threshold: 1 }).unknownPaths)
      .toEqual(['missing.php']);
  });
});
