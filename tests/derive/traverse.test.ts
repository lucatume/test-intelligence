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

function ajaxGraph(opts: {
  testFrameworkClass: 'unit' | 'e2e';
  callResolved: boolean;
}): Graph {
  // test (file 1) -> imports caller.ts (file 2) which $.post's action 'save_order'
  // file 3 (listener.php) registers add_action('wp_ajax_save_order', ...).
  const f1: FileRow = { id: 1, path: 'tests/order.test.ts', language: 'ts', vendor: false, framework: 'jest', frameworkClass: opts.testFrameworkClass };
  const f2: FileRow = { id: 2, path: 'src/caller.ts', language: 'ts', vendor: false, framework: null, frameworkClass: null };
  const f3: FileRow = { id: 3, path: 'src/listener.php', language: 'php', vendor: false, framework: null, frameworkClass: null };

  const testDef: FactRow = {
    id: 100, fileId: 1, kind: 'test-def', resolved: true, startLine: 1, endLine: 1,
    payload: { kind: 'test-def', framework: 'jest', testId: 't1' },
  };
  const importToCaller: FactRow = {
    id: 101, fileId: 1, kind: 'import-edge', resolved: true, startLine: 1, endLine: 1,
    payload: { kind: 'import-edge', specifier: './caller', resolved: true, resolvedPath: 'src/caller.ts' },
  };
  const ajaxCall: FactRow = {
    id: 200, fileId: 2, kind: 'ajax-call-js', resolved: opts.callResolved, startLine: 1, endLine: 1,
    payload: { kind: 'ajax-call-js', action: 'save_order' },
  };
  const ajaxListener: FactRow = {
    id: 300, fileId: 3, kind: 'ajax-listener', resolved: true, startLine: 1, endLine: 1,
    payload: { kind: 'ajax-listener', action: 'save_order' },
  };

  const facts = new Map<number, FactRow>([
    [100, testDef], [101, importToCaller], [200, ajaxCall], [300, ajaxListener],
  ]);
  const factsByFile = new Map<number, FactRow[]>([
    [1, [testDef, importToCaller]], [2, [ajaxCall]], [3, [ajaxListener]],
  ]);
  const anchorLinks = [
    { factId: 101, anchorKey: k('js-module:src/caller.ts'), role: 'module' as const },
    { factId: 200, anchorKey: k('ajax:save_order'), role: 'target' as const },
    { factId: 300, anchorKey: k('ajax:save_order'), role: 'subject' as const },
  ];
  return {
    files: new Map([[1, f1], [2, f2], [3, f3]]),
    facts, factsByFile, anchorLinks,
    tests: [{ testId: 't1', fileId: 1, framework: 'jest', frameworkClass: opts.testFrameworkClass, factId: 100 }],
  };
}

function enqueueGraph(opts: { testFrameworkClass: 'unit' | 'e2e' }): Graph {
  // test (file 1) -> imports admin.php (file 2) which wp_enqueue_script's a
  // classic admin script assets/js/admin/inline-edit.js (file 3). That JS file
  // carries an ajax-call-js fact; listener.php (file 4) registers the action.
  const f1: FileRow = { id: 1, path: 'tests/admin.test.ts', language: 'ts', vendor: false, framework: 'jest', frameworkClass: opts.testFrameworkClass };
  const f2: FileRow = { id: 2, path: 'admin.php', language: 'php', vendor: false, framework: null, frameworkClass: null };
  const f3: FileRow = { id: 3, path: 'assets/js/admin/inline-edit.js', language: 'js', vendor: false, framework: null, frameworkClass: null };
  const f4: FileRow = { id: 4, path: 'listener.php', language: 'php', vendor: false, framework: null, frameworkClass: null };

  const testDef: FactRow = {
    id: 100, fileId: 1, kind: 'test-def', resolved: true, startLine: 1, endLine: 1,
    payload: { kind: 'test-def', framework: 'jest', testId: 't1' },
  };
  const importToAdmin: FactRow = {
    id: 101, fileId: 1, kind: 'import-edge', resolved: true, startLine: 1, endLine: 1,
    payload: { kind: 'import-edge', specifier: './admin', resolved: true, resolvedPath: 'admin.php' },
  };
  const enqueue: FactRow = {
    id: 200, fileId: 2, kind: 'enqueue-script', resolved: true, startLine: 1, endLine: 1,
    payload: { kind: 'enqueue-script', handle: 'inline-edit', srcPath: 'assets/js/admin/inline-edit.js' },
  };
  const ajaxCall: FactRow = {
    id: 300, fileId: 3, kind: 'ajax-call-js', resolved: true, startLine: 1, endLine: 1,
    payload: { kind: 'ajax-call-js', action: 'inline_save' },
  };
  const ajaxListener: FactRow = {
    id: 400, fileId: 4, kind: 'ajax-listener', resolved: true, startLine: 1, endLine: 1,
    payload: { kind: 'ajax-listener', action: 'inline_save' },
  };

  const facts = new Map<number, FactRow>([
    [100, testDef], [101, importToAdmin], [200, enqueue], [300, ajaxCall], [400, ajaxListener],
  ]);
  const factsByFile = new Map<number, FactRow[]>([
    [1, [testDef, importToAdmin]], [2, [enqueue]], [3, [ajaxCall]], [4, [ajaxListener]],
  ]);
  const anchorLinks = [
    { factId: 101, anchorKey: k('js-module:admin.php'), role: 'module' as const },
    { factId: 200, anchorKey: k('script-handle:inline-edit'), role: 'subject' as const },
    { factId: 200, anchorKey: k('js-module:assets/js/admin/inline-edit.js'), role: 'target' as const },
    { factId: 300, anchorKey: k('ajax:inline_save'), role: 'target' as const },
    { factId: 400, anchorKey: k('ajax:inline_save'), role: 'subject' as const },
  ];
  return {
    files: new Map([[1, f1], [2, f2], [3, f3], [4, f4]]),
    facts, factsByFile, anchorLinks,
    tests: [{ testId: 't1', fileId: 1, framework: 'jest', frameworkClass: opts.testFrameworkClass, factId: 100 }],
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

  it('structural import edges keep BASE_CONFIDENCE (characterization — must not change)', () => {
    const g = tinyGraph();
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', 'unit', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    // a.php is reached by a js-import edge (BASE_CONFIDENCE 0.95).
    const aEdge = r.edges.find((e) => e.source === 'a.php');
    expect(aEdge).toBeDefined();
    expect(aEdge?.confidence).toBeCloseTo(0.95);
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

  it('e2e tests still bridge ajax-call-js to ajax-listener (characterization — must not regress)', () => {
    const g = ajaxGraph({ testFrameworkClass: 'e2e', callResolved: true });
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', 'e2e', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    const edge = r.edges.find((e) => e.source === 'src/listener.php');
    expect(edge).toBeDefined();
    expect(edge?.evidence.some((ev) => ev.kind === 'ajax-mediated')).toBe(true);
  });

  it('unit tests bridge ajax-call-js to ajax-listener through an imported caller', () => {
    const g = ajaxGraph({ testFrameworkClass: 'unit', callResolved: true });
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', 'unit', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    const edge = r.edges.find((e) => e.source === 'src/listener.php');
    expect(edge).toBeDefined();
    expect(edge?.evidence.some((ev) => ev.kind === 'ajax-mediated')).toBe(true);
    // ajax-call-js fact at depth 1 (imported), ajax-listener partner at depth 2:
    // ajax-mediated 0.85 * exact 1 * 0.92**2 (0.8464) = 0.71944.
    expect(edge?.confidence).toBeCloseTo(0.71944);
  });

  it('an unresolved ajax-call-js bridges as ajax-mediated-partial', () => {
    const g = ajaxGraph({ testFrameworkClass: 'unit', callResolved: false });
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', 'unit', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    const edge = r.edges.find((e) => e.source === 'src/listener.php');
    expect(edge).toBeDefined();
    expect(edge?.evidence.some((ev) => ev.kind === 'ajax-mediated-partial')).toBe(true);
    expect(edge?.partial).toBe(true);
    // ajax-mediated-partial 0.4 * exact 1 * 0.92**2 (0.8464) = 0.33856.
    expect(edge?.confidence).toBeCloseTo(0.33856);
  });

  it('attenuates an ajax bridge reached through a deeper import chain', () => {
    // Chain: test -> mid.ts -> caller.ts (ajax-call) -> listener.php.
    const g = ajaxGraph({ testFrameworkClass: 'unit', callResolved: true });
    const fMid: FileRow = { id: 4, path: 'src/mid.ts', language: 'ts', vendor: false, framework: null, frameworkClass: null };
    const importToMid: FactRow = {
      id: 102, fileId: 1, kind: 'import-edge', resolved: true, startLine: 1, endLine: 1,
      payload: { kind: 'import-edge', specifier: './mid', resolved: true, resolvedPath: 'src/mid.ts' },
    };
    const midImportCaller: FactRow = {
      id: 103, fileId: 4, kind: 'import-edge', resolved: true, startLine: 1, endLine: 1,
      payload: { kind: 'import-edge', specifier: './caller', resolved: true, resolvedPath: 'src/caller.ts' },
    };
    const testDef = g.facts.get(100);
    const ajaxCall = g.facts.get(200);
    const ajaxListener = g.facts.get(300);
    if (!testDef || !ajaxCall || !ajaxListener) throw new Error('fixture');
    const files = new Map(g.files);
    files.set(4, fMid);
    const facts = new Map(g.facts);
    facts.delete(101);            // drop the direct test -> caller import
    facts.set(102, importToMid);
    facts.set(103, midImportCaller);
    const factsByFile = new Map<number, FactRow[]>([
      [1, [testDef, importToMid]],
      [2, [ajaxCall]],
      [3, [ajaxListener]],
      [4, [midImportCaller]],
    ]);
    const anchorLinks = [
      { factId: 102, anchorKey: k('js-module:src/mid.ts'), role: 'module' as const },
      { factId: 103, anchorKey: k('js-module:src/caller.ts'), role: 'module' as const },
      { factId: 200, anchorKey: k('ajax:save_order'), role: 'target' as const },
      { factId: 300, anchorKey: k('ajax:save_order'), role: 'subject' as const },
    ];
    const g2: Graph = { files, facts, factsByFile, anchorLinks, tests: g.tests };
    const idx = buildAnchorIndex(g2);
    const r = traverseTest(g2, idx, 100, 't1', 'unit', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    const edge = r.edges.find((e) => e.source === 'src/listener.php');
    expect(edge).toBeDefined();
    // ajax-call-js fact now at depth 2 (test->mid->caller), partner at depth 3:
    // ajax-mediated 0.85 * exact 1 * 0.92**3 (0.778688) = 0.6618848.
    expect(edge?.confidence).toBeCloseTo(0.6618848);
    // Strictly below the one-hop-shallower edge (0.71944).
    expect(edge?.confidence).toBeLessThan(0.71944);
  });

  it('drops an ajax bridge edge below the confidence threshold', () => {
    const g = ajaxGraph({ testFrameworkClass: 'unit', callResolved: true });
    const idx = buildAnchorIndex(g);
    // The ajax-mediated edge stores at ~0.71944. A threshold above it drops the
    // edge; the structural js-import edge to src/caller.ts (0.95) stays.
    const r = traverseTest(g, idx, 100, 't1', 'unit', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0.8,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    expect(r.edges.some((e) => e.source === 'src/listener.php')).toBe(false);
    expect(r.edges.some((e) => e.source === 'src/caller.ts')).toBe(true);
  });
});

function broadWildcardGraph(): Graph {
  // test (file 1) -> imports app.ts (file 2) which apiFetches /wp/v2/things
  // file 3 (broad.php) registers rest:GET /{*}/{*} (unresolved namespace).
  const f1: FileRow = { id: 1, path: 'tests/app.test.ts', language: 'ts', vendor: false, framework: 'jest', frameworkClass: 'unit' };
  const f2: FileRow = { id: 2, path: 'app.ts', language: 'ts', vendor: false, framework: null, frameworkClass: null };
  const f3: FileRow = { id: 3, path: 'broad.php', language: 'php', vendor: false, framework: null, frameworkClass: null };

  const testDef: FactRow = {
    id: 100, fileId: 1, kind: 'test-def', resolved: true, startLine: 1, endLine: 1,
    payload: { kind: 'test-def', framework: 'jest', testId: 't1' },
  };
  const importToApp: FactRow = {
    id: 101, fileId: 1, kind: 'import-edge', resolved: true, startLine: 1, endLine: 1,
    payload: { kind: 'import-edge', specifier: './app', resolved: true, resolvedPath: 'app.ts' },
  };
  const restCall: FactRow = {
    id: 200, fileId: 2, kind: 'rest-call-js', resolved: true, startLine: 1, endLine: 1,
    payload: { kind: 'rest-call-js', method: 'GET', path: '/wp/v2/things' },
  };
  const endpoint: FactRow = {
    id: 300, fileId: 3, kind: 'rest-endpoint', resolved: false, startLine: 1, endLine: 1,
    payload: { kind: 'rest-endpoint', method: 'GET', route: '/{*}/{*}' },
  };

  const facts = new Map<number, FactRow>([
    [100, testDef], [101, importToApp], [200, restCall], [300, endpoint],
  ]);
  const factsByFile = new Map<number, FactRow[]>([
    [1, [testDef, importToApp]], [2, [restCall]], [3, [endpoint]],
  ]);
  const anchorLinks = [
    { factId: 101, anchorKey: k('js-module:app.ts'), role: 'module' as const },
    { factId: 200, anchorKey: k('rest:GET /wp/v2/things'), role: 'subject' as const },
    { factId: 300, anchorKey: k('rest:GET /{*}/{*}'), role: 'target' as const },
  ];
  return {
    files: new Map([[1, f1], [2, f2], [3, f3]]),
    facts, factsByFile, anchorLinks,
    tests: [{ testId: 't1', fileId: 1, framework: 'jest', frameworkClass: 'unit', factId: 100 }],
  };
}

describe('traverseTest — confidence tiering', () => {
  it('prices a broad-wildcard REST bridge well below an exact match', () => {
    const g = broadWildcardGraph();
    const idx = buildAnchorIndex(g);
    // frameworkClass 'e2e' so the rest-call-js bridge is not e2e-gated out.
    const r = traverseTest(g, idx, 100, 't1', 'e2e', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    const broadEdge = r.edges.find((e) => e.source === 'broad.php');
    expect(broadEdge).toBeDefined();
    // rest-call-js fact reached at depth 1 (via js-import); endpoint partner at
    // depth 2. rest-mediated 0.85 * wildcardBroad 0.25 * 0.92**2 (0.8464).
    expect(broadEdge?.confidence).toBeCloseTo(0.17985);
    expect(broadEdge?.confidence).toBeLessThan(0.4);
  });

  it('prices an exact REST bridge high', () => {
    const g = broadWildcardGraph();
    // Swap the endpoint's anchor to an exact match of the apiFetch path.
    const exactLinks = g.anchorLinks.map((l) =>
      l.factId === 300 ? { ...l, anchorKey: k('rest:GET /wp/v2/things') } : l,
    );
    const g2: Graph = { ...g, anchorLinks: exactLinks };
    const idx = buildAnchorIndex(g2);
    const r = traverseTest(g2, idx, 100, 't1', 'e2e', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    const edge = r.edges.find((e) => e.source === 'broad.php');
    expect(edge).toBeDefined();
    // rest-mediated 0.85 * exact 1 * 0.92**2 (0.8464) = 0.71944.
    expect(edge?.confidence).toBeCloseTo(0.71944);
    expect(edge?.confidence).toBeGreaterThan(0.7);
  });

  it('attenuates a bridge edge reached through a deeper import chain', () => {
    // Chain the import: test -> mid.ts -> app.ts(rest-call) -> broad.php.
    const g = broadWildcardGraph();
    const fMid: FileRow = { id: 4, path: 'mid.ts', language: 'ts', vendor: false, framework: null, frameworkClass: null };
    const importToMid: FactRow = {
      id: 102, fileId: 1, kind: 'import-edge', resolved: true, startLine: 1, endLine: 1,
      payload: { kind: 'import-edge', specifier: './mid', resolved: true, resolvedPath: 'mid.ts' },
    };
    const midImportApp: FactRow = {
      id: 103, fileId: 4, kind: 'import-edge', resolved: true, startLine: 1, endLine: 1,
      payload: { kind: 'import-edge', specifier: './app', resolved: true, resolvedPath: 'app.ts' },
    };
    // Replace file-1's import (101 -> mid) and remove the direct test->app import.
    const files = new Map(g.files);
    files.set(4, fMid);
    const facts = new Map(g.facts);
    const testDef = facts.get(100);
    const restCall = facts.get(200);
    const endpoint = facts.get(300);
    if (!testDef || !restCall || !endpoint) throw new Error('fixture');
    facts.delete(101);
    facts.set(102, importToMid);
    facts.set(103, midImportApp);
    const factsByFile = new Map<number, FactRow[]>([
      [1, [testDef, importToMid]],
      [2, [restCall]],
      [3, [endpoint]],
      [4, [midImportApp]],
    ]);
    const anchorLinks = [
      { factId: 102, anchorKey: k('js-module:mid.ts'), role: 'module' as const },
      { factId: 103, anchorKey: k('js-module:app.ts'), role: 'module' as const },
      { factId: 200, anchorKey: k('rest:GET /wp/v2/things'), role: 'subject' as const },
      { factId: 300, anchorKey: k('rest:GET /{*}/{*}'), role: 'target' as const },
    ];
    const g2: Graph = { files, facts, factsByFile, anchorLinks, tests: g.tests };
    const idx = buildAnchorIndex(g2);
    const r = traverseTest(g2, idx, 100, 't1', 'e2e', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    const edge = r.edges.find((e) => e.source === 'broad.php');
    expect(edge).toBeDefined();
    // rest-call-js now at depth 2, endpoint partner at depth 3.
    // 0.85 * wildcardBroad 0.25 * 0.92**3 (0.778688) = 0.16550...
    expect(edge?.confidence).toBeCloseTo(0.16550);
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

  it('a unit test reaches an enqueued classic JS file via enqueue-mediated', () => {
    const g = enqueueGraph({ testFrameworkClass: 'unit' });
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', 'unit', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0, maxWildcardMatchesPerAnchor: 32,
    });
    const js = r.edges.find((e) => e.source === 'assets/js/admin/inline-edit.js');
    expect(js).toBeDefined();
    expect(js?.evidence.some((ev) => ev.kind === 'enqueue-mediated')).toBe(true);
  });

  it('the bridge carries on into the enqueued file’s ajax-mediated edge', () => {
    const g = enqueueGraph({ testFrameworkClass: 'unit' });
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', 'unit', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0, maxWildcardMatchesPerAnchor: 32,
    });
    const listener = r.edges.find((e) => e.source === 'listener.php');
    expect(listener).toBeDefined();
    expect(listener?.evidence.some((ev) => ev.kind === 'ajax-mediated')).toBe(true);
  });

  it('surfaces enqueue-script siblings when a PHP file is reached via a hook bridge', () => {
    // test (file 1) imports a.php (file 2) which fires hook 'thing'; admin.php
    // (file 3) listens for 'thing' AND (same file) enqueues a classic admin
    // script x.js (file 4). The enqueue-script fact must be surfaced even
    // though only the hook-listener fact is the matched bridge partner.
    const f1: FileRow = { id: 1, path: 'tests/x.test.ts', language: 'ts', vendor: false, framework: 'jest', frameworkClass: 'unit' };
    const f2: FileRow = { id: 2, path: 'a.php', language: 'php', vendor: false, framework: null, frameworkClass: null };
    const f3: FileRow = { id: 3, path: 'admin.php', language: 'php', vendor: false, framework: null, frameworkClass: null };
    const f4: FileRow = { id: 4, path: 'assets/js/admin/x.js', language: 'js', vendor: false, framework: null, frameworkClass: null };
    const testDef: FactRow = { id: 100, fileId: 1, kind: 'test-def', resolved: true, startLine: 1, endLine: 1, payload: { kind: 'test-def', framework: 'jest', testId: 't1' } };
    const importToA: FactRow = { id: 101, fileId: 1, kind: 'import-edge', resolved: true, startLine: 1, endLine: 1, payload: { kind: 'import-edge', specifier: './a', resolved: true, resolvedPath: 'a.php' } };
    const fire: FactRow = { id: 200, fileId: 2, kind: 'hook-fire', resolved: true, startLine: 1, endLine: 1, payload: { kind: 'hook-fire', hook: 'thing' } };
    const adminListener: FactRow = { id: 300, fileId: 3, kind: 'hook-listener', resolved: true, startLine: 1, endLine: 1, payload: { kind: 'hook-listener', hook: 'thing' } };
    const adminEnqueue: FactRow = { id: 301, fileId: 3, kind: 'enqueue-script', resolved: true, startLine: 2, endLine: 2, payload: { kind: 'enqueue-script', handle: 'x', srcPath: 'assets/js/admin/x.js' } };
    const jsFact: FactRow = { id: 400, fileId: 4, kind: 'ajax-call-js', resolved: true, startLine: 1, endLine: 1, payload: { kind: 'ajax-call-js', action: 'do_x' } };
    const g: Graph = {
      files: new Map([[1, f1], [2, f2], [3, f3], [4, f4]]),
      facts: new Map<number, FactRow>([[100, testDef], [101, importToA], [200, fire], [300, adminListener], [301, adminEnqueue], [400, jsFact]]),
      factsByFile: new Map<number, FactRow[]>([[1, [testDef, importToA]], [2, [fire]], [3, [adminListener, adminEnqueue]], [4, [jsFact]]]),
      anchorLinks: [
        { factId: 101, anchorKey: k('js-module:a.php'), role: 'module' as const },
        { factId: 200, anchorKey: k('hook:thing'), role: 'target' as const },
        { factId: 300, anchorKey: k('hook:thing'), role: 'subject' as const },
        { factId: 301, anchorKey: k('js-module:assets/js/admin/x.js'), role: 'target' as const },
      ],
      tests: [{ testId: 't1', fileId: 1, framework: 'jest', frameworkClass: 'unit', factId: 100 }],
    };
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', 'unit', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0, maxWildcardMatchesPerAnchor: 32,
    });
    const js = r.edges.find((e) => e.source === 'assets/js/admin/x.js');
    expect(js).toBeDefined();
    expect(js?.evidence.some((ev) => ev.kind === 'enqueue-mediated')).toBe(true);
  });

  it('enqueue-mediated edges attenuate with traversal distance', () => {
    const g = enqueueGraph({ testFrameworkClass: 'unit' });
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', 'unit', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0, maxWildcardMatchesPerAnchor: 32,
    });
    const js = r.edges.find((e) => e.source === 'assets/js/admin/inline-edit.js');
    // enqueue-mediated BASE_CONFIDENCE is 0.7; the JS file is reached past an
    // import hop, so Phase-1 distance decay must pull the stored confidence
    // strictly below the 0.7 base.
    expect(js?.confidence).toBeLessThan(0.7);
    expect(js?.confidence).toBeGreaterThan(0);
  });
});
