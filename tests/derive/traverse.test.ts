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
      maxWildcardMatchesPerAnchor: 32,
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
      maxWildcardMatchesPerAnchor: 32,
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
      maxWildcardMatchesPerAnchor: 32,
    });
    const sources = r.edges.map((e) => e.source);
    expect(sources).not.toContain('b.php');
  });

  it('edge.partial is false when every evidence kind is a resolved variant', () => {
    // a.php is reached via a resolved js-import; one of a.php's own facts is
    // resolved=false but never feeds a bridge kind. The js-import edge to
    // a.php must NOT be marked partial — partial reflects evidence kinds only.
    const base = tinyGraph();
    const fire = base.facts.get(200);
    if (!fire) throw new Error('fixture');
    const patchedFire: FactRow = { ...fire, resolved: false };
    const facts = new Map(base.facts);
    facts.set(200, patchedFire);
    const factsByFile = new Map(base.factsByFile);
    factsByFile.set(2, [patchedFire]);
    const g: Graph = { ...base, facts, factsByFile };
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', 'unit', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(['thing']), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    const aEdge = r.edges.find((e) => e.source === 'a.php');
    expect(aEdge).toBeDefined();
    expect(aEdge?.evidence.every((e) => e.kind === 'js-import')).toBe(true);
    expect(aEdge?.partial).toBe(false);
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

    const e2e = traverseTest(g, idx, 1, 't1', 'e2e', { maxDepth: 25, maxMillisPerTest: 5000, threshold: 0, hookStopList: new Set(), now: () => 0, maxWildcardMatchesPerAnchor: 32 });
    expect(e2e.edges.some((e) => e.source === 'src/endpoint.php')).toBe(true);

    const unit = traverseTest(g, idx, 1, 't2', 'unit', { maxDepth: 25, maxMillisPerTest: 5000, threshold: 0, hookStopList: new Set(), now: () => 0, maxWildcardMatchesPerAnchor: 32 });
    expect(unit.edges.some((e) => e.source === 'src/endpoint.php')).toBe(false);
  });

  it('rest-endpoint resolved flag does not change the REST edge kind', () => {
    // Regression lock for Item 1: flipping a route-param rest-endpoint fact's
    // `resolved` false→true must NOT upgrade the edge. The REST edge kind is
    // chosen from the bridging rest-call-js fact's `resolved` (bridgeKindFor
    // has no rest-endpoint case); the rest-endpoint is only a wildcard-matched
    // partner. The endpoint anchor carries {*} (a route param). The edge kind
    // must be identical regardless of the endpoint fact's resolved flag.
    const build = (endpointResolved: boolean): Graph => {
      const f1: FileRow = { id: 1, path: 'tests/e2e.spec.ts', language: 'ts', vendor: false, framework: 'playwright', frameworkClass: 'e2e' };
      const f2: FileRow = { id: 2, path: 'src/endpoint.php', language: 'php', vendor: false, framework: null, frameworkClass: null };
      const td: FactRow = { id: 1, fileId: 1, kind: 'test-def', resolved: true, startLine: 1, endLine: 1, payload: {} };
      // rest-call-js: a literal apiFetch path — resolved=true.
      const rcj: FactRow = { id: 2, fileId: 1, kind: 'rest-call-js', resolved: true, startLine: 1, endLine: 1, payload: {} };
      // rest-endpoint: a parameterized route — anchor carries {*}.
      const endpoint: FactRow = { id: 3, fileId: 2, kind: 'rest-endpoint', resolved: endpointResolved, startLine: 1, endLine: 1, payload: {} };
      return {
        files: new Map([[1, f1], [2, f2]]),
        facts: new Map([[1, td], [2, rcj], [3, endpoint]]),
        factsByFile: new Map([[1, [td, rcj]], [2, [endpoint]]]),
        anchorLinks: [
          { factId: 2, anchorKey: k('rest:GET /wp/v2/comments/123'), role: 'target' },
          { factId: 3, anchorKey: k('rest:GET /wp/v2/comments/{*}'), role: 'subject' },
        ],
        tests: [],
      };
    };
    const opts = { maxDepth: 25, maxMillisPerTest: 5000, threshold: 0, hookStopList: new Set<string>(), now: (): number => 0, maxWildcardMatchesPerAnchor: 32 };

    const gUnresolved = build(false);
    const rUnresolved = traverseTest(gUnresolved, buildAnchorIndex(gUnresolved), 1, 't1', 'e2e', opts);
    const gResolved = build(true);
    const rResolved = traverseTest(gResolved, buildAnchorIndex(gResolved), 1, 't1', 'e2e', opts);

    const kindsOf = (r: ReturnType<typeof traverseTest>): string[] =>
      (r.edges.find((e) => e.source === 'src/endpoint.php')?.evidence.map((e) => e.kind) ?? []).sort();

    // The edge exists in both, and the evidence kinds are identical.
    expect(kindsOf(rResolved)).toEqual(kindsOf(rUnresolved));
    // The bridging rest-call-js is resolved → the kind is rest-mediated.
    expect(kindsOf(rResolved)).toContain('rest-mediated');
  });
});

describe('traverseTest — wildcard bridge', () => {
  const testFile: FileRow = {
    id: 1, path: 'tests/x.php', language: 'php', vendor: false,
    framework: 'phpunit', frameworkClass: 'unit',
  };
  const sourceFile: FileRow = {
    id: 2, path: 'src/listener.php', language: 'php', vendor: false,
    framework: null, frameworkClass: null,
  };

  it('emits hook-mediated-uncertain via wildcard fact → literal listener', () => {
    const wildFire: FactRow = {
      id: 100, fileId: 1, kind: 'hook-fire', resolved: false,
      startLine: 1, endLine: 1, payload: { kind: 'hook-fire', hook: 'wp_ajax_{*}' },
    };
    const literalListener: FactRow = {
      id: 101, fileId: 2, kind: 'hook-listener', resolved: true,
      startLine: 1, endLine: 1, payload: { kind: 'hook-listener', hook: 'wp_ajax_save' },
    };
    const graph: Graph = {
      files: new Map([[1, testFile], [2, sourceFile]]),
      facts: new Map([[100, wildFire], [101, literalListener]]),
      factsByFile: new Map([[1, [wildFire]], [2, [literalListener]]]),
      anchorLinks: [
        { factId: 100, anchorKey: k('hook:wp_ajax_{*}'), role: 'target' },
        { factId: 101, anchorKey: k('hook:wp_ajax_save'), role: 'subject' },
      ],
      tests: [],
    };
    const idx = buildAnchorIndex(graph);
    const r = traverseTest(graph, idx, 100, 'phpunit:tests/x.php::Foo::testIt', 'unit', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    expect(r.edges.map((e) => e.source)).toEqual(['src/listener.php']);
    const kinds = r.edges[0]?.evidence.map((e) => e.kind) ?? [];
    expect(kinds).toContain('hook-mediated-uncertain');
    // An edge carrying an *-uncertain evidence kind is partial.
    expect(r.edges[0]?.partial).toBe(true);
  });

  it('emits hook-mediated-uncertain via literal fact → wildcard listener', () => {
    const literalFire: FactRow = {
      id: 200, fileId: 1, kind: 'hook-fire', resolved: true,
      startLine: 1, endLine: 1, payload: { kind: 'hook-fire', hook: 'my_event' },
    };
    const wildListener: FactRow = {
      id: 201, fileId: 2, kind: 'hook-listener', resolved: false,
      startLine: 1, endLine: 1, payload: { kind: 'hook-listener', hook: 'my_{*}' },
    };
    const graph: Graph = {
      files: new Map([[1, testFile], [2, sourceFile]]),
      facts: new Map([[200, literalFire], [201, wildListener]]),
      factsByFile: new Map([[1, [literalFire]], [2, [wildListener]]]),
      anchorLinks: [
        { factId: 200, anchorKey: k('hook:my_event'), role: 'target' },
        { factId: 201, anchorKey: k('hook:my_{*}'), role: 'subject' },
      ],
      tests: [],
    };
    const idx = buildAnchorIndex(graph);
    const r = traverseTest(graph, idx, 200, 'phpunit:tests/x.php::Foo::testIt', 'unit', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    expect(r.edges.map((e) => e.source)).toEqual(['src/listener.php']);
  });

  it('caps wildcard matches at maxWildcardMatchesPerAnchor', () => {
    const tFile: FileRow = { id: 1, path: 'tests/x.php', language: 'php', vendor: false, framework: 'phpunit', frameworkClass: 'unit' };
    const wildFire: FactRow = {
      id: 9000, fileId: 1, kind: 'hook-fire', resolved: false,
      startLine: 1, endLine: 1, payload: { kind: 'hook-fire', hook: 'hook_{*}' },
    };
    // Create 100 literal listeners across 100 distinct source files
    const files = new Map<number, FileRow>();
    files.set(1, tFile);
    const facts = new Map<number, FactRow>();
    facts.set(9000, wildFire);
    const factsByFile = new Map<number, readonly FactRow[]>();
    factsByFile.set(1, [wildFire]);
    const anchorLinks: Array<{ factId: number; anchorKey: AnchorKey; role: 'subject' | 'target' | 'module' | 'callback' }> = [
      { factId: 9000, anchorKey: k('hook:hook_{*}'), role: 'target' },
    ];
    for (let i = 0; i < 100; i++) {
      const fid = 10000 + i;
      const fileId = 1000 + i;
      const suffix = String(i);
      const file: FileRow = { id: fileId, path: `src/listener_${suffix}.php`, language: 'php', vendor: false, framework: null, frameworkClass: null };
      files.set(fileId, file);
      const fact: FactRow = {
        id: fid, fileId, kind: 'hook-listener', resolved: true,
        startLine: 1, endLine: 1, payload: { kind: 'hook-listener', hook: `hook_${suffix}` },
      };
      facts.set(fid, fact);
      factsByFile.set(fileId, [fact]);
      anchorLinks.push({ factId: fid, anchorKey: k(`hook:hook_${suffix}`), role: 'subject' });
    }
    const graph: Graph = { files, facts, factsByFile, anchorLinks, tests: [] };
    const idx = buildAnchorIndex(graph);

    const r = traverseTest(graph, idx, 9000, 'phpunit:tests/x.php::Foo::testIt', 'unit', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 7,
    });
    // The cap is per-fact: 7 wildcard-side matches → at most 7 source files
    expect(r.edges.length).toBe(7);
  });
});
