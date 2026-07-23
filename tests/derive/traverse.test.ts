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

function adminPageGraph(): Graph {
  // test (file 1, a Playwright spec) carries an admin-page-nav fact to
  // 'wc-settings'. file 2 (menus.php) registers that admin page. The bridge is
  // a pure anchor join: wp-admin-page:wc-settings target<->subject.
  const f1: FileRow = { id: 1, path: 'tests/e2e-pw/settings.spec.ts', language: 'ts', vendor: false, framework: 'playwright', frameworkClass: 'e2e' };
  const f2: FileRow = { id: 2, path: 'includes/admin/class-wc-admin-menus.php', language: 'php', vendor: false, framework: null, frameworkClass: null };

  const testDef: FactRow = {
    id: 100, fileId: 1, kind: 'test-def', resolved: true, startLine: 1, endLine: 1,
    payload: { kind: 'test-def', framework: 'playwright', testId: 't1' },
  };
  const nav: FactRow = {
    id: 200, fileId: 1, kind: 'admin-page-nav', resolved: true, startLine: 3, endLine: 3,
    payload: { kind: 'admin-page-nav', url: 'wp-admin/admin.php?page=wc-settings', slug: 'wc-settings', method: 'goto' },
  };
  const register: FactRow = {
    id: 300, fileId: 2, kind: 'admin-page-register', resolved: true, startLine: 123, endLine: 130,
    payload: { kind: 'admin-page-register', slug: 'wc-settings', fn: 'add_submenu_page' },
  };

  const facts = new Map<number, FactRow>([[100, testDef], [200, nav], [300, register]]);
  const factsByFile = new Map<number, FactRow[]>([
    [1, [testDef, nav]], [2, [register]],
  ]);
  const anchorLinks = [
    { factId: 200, anchorKey: k('wp-admin-page:wc-settings'), role: 'target' as const },
    { factId: 300, anchorKey: k('wp-admin-page:wc-settings'), role: 'subject' as const },
  ];
  return {
    files: new Map([[1, f1], [2, f2]]),
    facts, factsByFile, anchorLinks,
    tests: [{ testId: 't1', fileId: 1, framework: 'playwright', frameworkClass: 'e2e', factId: 100 }],
  };
}

function storeGraph(): Graph {
  // test (file 1, jest unit) imports file 2 (a React component) which accesses
  // the 'wc/admin/plugins' store via useDispatch. file 3 registers that store.
  // The bridge is a wp-store:wc/admin/plugins target<->subject anchor join.
  const f1: FileRow = { id: 1, path: 'tests/Plugins.test.tsx', language: 'ts', vendor: false, framework: 'jest', frameworkClass: 'unit' };
  const f2: FileRow = { id: 2, path: 'client/components/Plugins.tsx', language: 'ts', vendor: false, framework: null, frameworkClass: null };
  const f3: FileRow = { id: 3, path: 'client/data/plugins/index.js', language: 'js', vendor: false, framework: null, frameworkClass: null };

  const testDef: FactRow = {
    id: 100, fileId: 1, kind: 'test-def', resolved: true, startLine: 1, endLine: 1,
    payload: { kind: 'test-def', framework: 'jest', testId: 't1' },
  };
  const importToComp: FactRow = {
    id: 101, fileId: 1, kind: 'import-edge', resolved: true, startLine: 1, endLine: 1,
    payload: { kind: 'import-edge', specifier: './Plugins', resolved: true, resolvedPath: 'client/components/Plugins.tsx' },
  };
  const access: FactRow = {
    id: 200, fileId: 2, kind: 'store-access', resolved: true, startLine: 5, endLine: 5,
    payload: { kind: 'store-access', key: 'wc/admin/plugins' },
  };
  const register: FactRow = {
    id: 300, fileId: 3, kind: 'store-register', resolved: true, startLine: 10, endLine: 14,
    payload: { kind: 'store-register', key: 'wc/admin/plugins' },
  };

  const facts = new Map<number, FactRow>([[100, testDef], [101, importToComp], [200, access], [300, register]]);
  const factsByFile = new Map<number, FactRow[]>([
    [1, [testDef, importToComp]], [2, [access]], [3, [register]],
  ]);
  const anchorLinks = [
    { factId: 200, anchorKey: k('wp-store:wc/admin/plugins'), role: 'target' as const },
    { factId: 300, anchorKey: k('wp-store:wc/admin/plugins'), role: 'subject' as const },
  ];
  return {
    files: new Map([[1, f1], [2, f2], [3, f3]]),
    facts, factsByFile, anchorLinks,
    tests: [{ testId: 't1', fileId: 1, framework: 'jest', frameworkClass: 'unit', factId: 100 }],
  };
}

function blockGraph(): Graph {
  // test (file 1, jest unit) imports file 2 (a block's JS edit component) which
  // carries a block-render TARGET fact (registerBlockType). file 3 (PHP)
  // registers that block (register_block_type) — block-render SUBJECT. The
  // bridge is a block:woocommerce/cart target<->subject anchor join.
  const f1: FileRow = { id: 1, path: 'tests/cart-block.test.tsx', language: 'ts', vendor: false, framework: 'jest', frameworkClass: 'unit' };
  const f2: FileRow = { id: 2, path: 'assets/js/blocks/cart/index.tsx', language: 'ts', vendor: false, framework: null, frameworkClass: null };
  const f3: FileRow = { id: 3, path: 'src/Blocks/Cart.php', language: 'php', vendor: false, framework: null, frameworkClass: null };

  const testDef: FactRow = {
    id: 100, fileId: 1, kind: 'test-def', resolved: true, startLine: 1, endLine: 1,
    payload: { kind: 'test-def', framework: 'jest', testId: 't1' },
  };
  const importToBlock: FactRow = {
    id: 101, fileId: 1, kind: 'import-edge', resolved: true, startLine: 1, endLine: 1,
    payload: { kind: 'import-edge', specifier: './index', resolved: true, resolvedPath: 'assets/js/blocks/cart/index.tsx' },
  };
  const jsRegister: FactRow = {
    id: 200, fileId: 2, kind: 'block-render', resolved: true, startLine: 5, endLine: 5,
    payload: { kind: 'block-render', name: 'woocommerce/cart' },
  };
  const phpRegister: FactRow = {
    id: 300, fileId: 3, kind: 'block-render', resolved: true, startLine: 20, endLine: 24,
    payload: { kind: 'block-render', name: 'woocommerce/cart' },
  };

  const facts = new Map<number, FactRow>([[100, testDef], [101, importToBlock], [200, jsRegister], [300, phpRegister]]);
  const factsByFile = new Map<number, FactRow[]>([
    [1, [testDef, importToBlock]], [2, [jsRegister]], [3, [phpRegister]],
  ]);
  const anchorLinks = [
    { factId: 200, anchorKey: k('block:woocommerce/cart'), role: 'target' as const },
    { factId: 300, anchorKey: k('block:woocommerce/cart'), role: 'subject' as const },
  ];
  return {
    files: new Map([[1, f1], [2, f2], [3, f3]]),
    facts, factsByFile, anchorLinks,
    tests: [{ testId: 't1', fileId: 1, framework: 'jest', frameworkClass: 'unit', factId: 100 }],
  };
}

describe('traverseTest', () => {
  it('marks callable-scoped hook listeners as uncertain', () => {
    const graph = tinyGraph();
    const originalListener = graph.facts.get(300);
    if (originalListener === undefined) throw new Error('missing listener fixture');
    const listener = { ...originalListener, startLine: 5, endLine: 5 };
    const callable: FactRow = {
      id: 301,
      fileId: 3,
      kind: 'symbol-def',
      resolved: true,
      startLine: 1,
      endLine: 10,
      payload: { kind: 'symbol-def', name: 'register', meta: { callable: true } },
    };
    const facts = new Map(graph.facts);
    facts.set(300, listener);
    facts.set(301, callable);
    const factsByFile = new Map(graph.factsByFile);
    factsByFile.set(3, [callable, listener]);
    const scopedGraph = { ...graph, facts, factsByFile };

    const result = traverseTest(scopedGraph, buildAnchorIndex(scopedGraph), 100, 't1', {
      maxDepth: 25,
      maxMillisPerTest: 5000,
      threshold: 0,
      hookStopList: new Set(),
      now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });

    const listenerEdge = result.edges.find((edge) => edge.source === 'b.php');
    expect(listenerEdge?.evidence.map((evidence) => evidence.kind)).toContain('hook-mediated-uncertain');
    expect(listenerEdge?.partial).toBe(true);
  });

  it('scopes PHPUnit seeds to the selected test, lifecycle, and reached helpers', () => {
    const testFile: FileRow = { id: 1, path: 'tests/ScopedTest.php', language: 'php', vendor: false, framework: 'phpunit', frameworkClass: 'unit' };
    const source = (id: number, path: string): FileRow => ({ id, path, language: 'php', vendor: false, framework: null, frameworkClass: null });
    const fact = (id: number, kind: FactRow['kind'], startLine: number, endLine: number, payload: FactRow['payload']): FactRow =>
      ({ id, fileId: 1, kind, resolved: true, startLine, endLine, payload });
    const selectedDef = fact(10, 'symbol-def', 3, 5, { kind: 'symbol-def', name: 'ScopedTest::testSelected', exported: false, meta: { callable: true } });
    const selectedTest = fact(11, 'test-def', 3, 5, { kind: 'test-def', framework: 'phpunit', testId: 'selected' });
    const helperUse = fact(12, 'symbol-use', 4, 4, { kind: 'symbol-use', name: 'ScopedTest::helper' });
    const siblingDef = fact(20, 'symbol-def', 7, 9, { kind: 'symbol-def', name: 'ScopedTest::testSibling', exported: false, meta: { callable: true } });
    const siblingTest = fact(21, 'test-def', 7, 9, { kind: 'test-def', framework: 'phpunit', testId: 'sibling' });
    const siblingImport = fact(22, 'php-include', 8, 8, { kind: 'php-include', target: 'bad.php' });
    const helperDef = fact(30, 'symbol-def', 11, 13, { kind: 'symbol-def', name: 'ScopedTest::helper', exported: false, meta: { callable: true } });
    const helperImport = fact(31, 'php-include', 12, 12, { kind: 'php-include', target: 'good.php' });
    const setupDef = fact(40, 'symbol-def', 15, 17, { kind: 'symbol-def', name: 'ScopedTest::setUp', exported: false, meta: { callable: true } });
    const setupImport = fact(41, 'php-include', 16, 16, { kind: 'php-include', target: 'lifecycle.php' });
    const classDef = fact(1, 'symbol-def', 1, 30, { kind: 'symbol-def', name: 'ScopedTest', exported: true });
    const targetFact = (id: number, fileId: number): FactRow => ({ id, fileId, kind: 'symbol-def', resolved: true, startLine: 1, endLine: 1, payload: { kind: 'symbol-def', name: `s${String(id)}`, exported: true } });
    const good = targetFact(101, 2); const bad = targetFact(102, 3); const lifecycle = targetFact(103, 4);
    const testFacts = [classDef, selectedDef, selectedTest, helperUse, siblingDef, siblingTest, siblingImport, helperDef, helperImport, setupDef, setupImport];
    const graph: Graph = {
      files: new Map([[1, testFile], [2, source(2, 'good.php')], [3, source(3, 'bad.php')], [4, source(4, 'lifecycle.php')]]),
      facts: new Map([...testFacts, good, bad, lifecycle].map((f) => [f.id, f])),
      factsByFile: new Map([[1, testFacts], [2, [good]], [3, [bad]], [4, [lifecycle]]]),
      anchorLinks: [
        { factId: 12, anchorKey: k('php-symbol:ScopedTest::helper'), role: 'subject' },
        { factId: 30, anchorKey: k('php-symbol:ScopedTest::helper'), role: 'target' },
      ],
      tests: [
        { testId: 'selected', fileId: 1, framework: 'phpunit', frameworkClass: 'unit', factId: 11 },
        { testId: 'sibling', fileId: 1, framework: 'phpunit', frameworkClass: 'unit', factId: 21 },
      ],
    };
    const result = traverseTest(graph, buildAnchorIndex(graph), 11, 'selected', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0, maxWildcardMatchesPerAnchor: 32,
    });
    expect(result.edges.map((edge) => edge.source).sort()).toEqual(['good.php', 'lifecycle.php']);
  });

  it('scopes JS describe hooks to tests in the same suite', () => {
    const testFile: FileRow = { id: 1, path: 'tests/orders.test.ts', language: 'ts', vendor: false, framework: 'playwright', frameworkClass: 'e2e' };
    const sourceFile: FileRow = { id: 2, path: 'orders.php', language: 'php', vendor: false, framework: null, frameworkClass: null };
    const firstTest: FactRow = {
      id: 10, fileId: 1, kind: 'test-def', resolved: true, startLine: 3, endLine: 4,
      payload: { kind: 'test-def', framework: 'playwright', testId: 'first', meta: { scopeRanges: [{ startLine: 1, endLine: 10 }] } },
    };
    const secondTest: FactRow = {
      id: 11, fileId: 1, kind: 'test-def', resolved: true, startLine: 13, endLine: 14,
      payload: { kind: 'test-def', framework: 'playwright', testId: 'second', meta: { scopeRanges: [{ startLine: 11, endLine: 20 }] } },
    };
    const firstSuiteHook: FactRow = {
      id: 12, fileId: 1, kind: 'rest-call-js', resolved: true, startLine: 8, endLine: 8,
      payload: { kind: 'rest-call-js', url: '/wc/v3/orders' },
    };
    const endpoint: FactRow = {
      id: 20, fileId: 2, kind: 'rest-endpoint', resolved: true, startLine: 1, endLine: 1,
      payload: { kind: 'rest-endpoint', method: 'POST', route: '/orders' },
    };
    const graph: Graph = {
      files: new Map([[1, testFile], [2, sourceFile]]),
      facts: new Map([[10, firstTest], [11, secondTest], [12, firstSuiteHook], [20, endpoint]]),
      factsByFile: new Map([[1, [firstTest, secondTest, firstSuiteHook]], [2, [endpoint]]]),
      anchorLinks: [
        { factId: 12, anchorKey: k('rest:POST /wc/v3/orders'), role: 'target' },
        { factId: 20, anchorKey: k('rest:POST /wc/v3/orders'), role: 'subject' },
      ],
      tests: [],
    };
    const options = {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set<string>(), now: () => 0, maxWildcardMatchesPerAnchor: 32,
    };
    expect(traverseTest(graph, buildAnchorIndex(graph), 10, 'first', options).edges.map((edge) => edge.source))
      .toEqual(['orders.php']);
    expect(traverseTest(graph, buildAnchorIndex(graph), 11, 'second', options).edges).toEqual([]);
  });

  it('a unit test bridges a JS block-render to the PHP that registers the block', () => {
    const g = blockGraph();
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    const phpEdge = r.edges.find((e) => e.source === 'src/Blocks/Cart.php');
    expect(phpEdge).toBeDefined();
    expect(phpEdge?.evidence.some((ev) => ev.kind === 'block-render')).toBe(true);
  });

  it('a unit test bridges through a @wordpress/data store-access to the registering file', () => {
    const g = storeGraph();
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    const storeEdge = r.edges.find((e) =>
      e.evidence.some((ev) => ev.kind === 'store-mediated'),
    );
    expect(storeEdge).toBeDefined();
    expect(storeEdge?.source).toBe('client/data/plugins/index.js');
  });


  it('a Playwright spec bridges to the PHP that registers the admin page it visits', () => {
    // Program Phase 5: the admin-page-nav fact (from page.goto) and the
    // admin-page-register fact (from add_submenu_page) join on the
    // wp-admin-page:wc-settings anchor. No framework-class gate.
    const g = adminPageGraph();
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    const adminEdge = r.edges.find((e) =>
      e.evidence.some((ev) => ev.kind === 'admin-page-mediated'),
    );
    expect(adminEdge).toBeDefined();
    expect(adminEdge?.source).toBe('includes/admin/class-wc-admin-menus.php');
    // BASE_CONFIDENCE 0.9, literal-exact slug join, one hop.
    expect(adminEdge?.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('traverses through a bridge partner test helper without emitting it', () => {
    const g = adminPageGraph();
    const files = new Map(g.files);
    const incompatible = files.get(2);
    if (!incompatible) throw new Error('fixture');
    files.set(2, { ...incompatible, framework: 'phpunit', frameworkClass: 'unit' });
    files.set(3, {
      id: 3, path: 'assets/admin.js', language: 'js', vendor: false,
      framework: null, frameworkClass: null,
    });
    const enqueue: FactRow = {
      id: 301, fileId: 2, kind: 'enqueue-script', resolved: true,
      startLine: 140, endLine: 140, payload: { kind: 'enqueue-script' },
    };
    const jsFact: FactRow = {
      id: 400, fileId: 3, kind: 'symbol-def', resolved: true,
      startLine: 1, endLine: 1, payload: { kind: 'symbol-def', symbol: 'admin' },
    };
    const facts = new Map(g.facts).set(301, enqueue).set(400, jsFact);
    const factsByFile = new Map(g.factsByFile);
    factsByFile.set(2, [...(factsByFile.get(2) ?? []), enqueue]);
    factsByFile.set(3, [jsFact]);
    const g2: Graph = {
      ...g, files, facts, factsByFile,
      anchorLinks: [
        ...g.anchorLinks,
        { factId: 301, anchorKey: k('js-module:assets/admin.js'), role: 'target' },
      ],
    };
    const r = traverseTest(g2, buildAnchorIndex(g2), 100, 't1', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });

    expect(r.edges.some((e) => e.source === 'includes/admin/class-wc-admin-menus.php')).toBe(false);
    expect(r.edges.some((e) => e.source === 'assets/admin.js')).toBe(true);
  });

  it('reaches imported and hook-listener files', () => {
    const g = tinyGraph();
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    const sources = r.edges.map((e) => e.source).sort();
    expect(sources).toEqual(['a.php', 'b.php']);
    expect(r.bounded).toBe(false);
  });

  it('stops direct and transitive imports at jest.mock boundaries', () => {
    const g = tinyGraph();
    const mocked: FactRow = {
      ...(g.facts.get(101) as FactRow),
      payload: {
        kind: 'import-edge', specifier: './a', resolved: true, resolvedPath: 'a.php',
        meta: { mocked: true },
      },
    };
    const symbolUse: FactRow = {
      id: 102, fileId: 1, kind: 'symbol-use', resolved: true, startLine: 2, endLine: 2,
      payload: { kind: 'symbol-use', name: 'x' },
    };
    const symbolDef: FactRow = {
      id: 201, fileId: 2, kind: 'symbol-def', resolved: true, startLine: 1, endLine: 1,
      payload: { kind: 'symbol-def', name: 'x' },
    };
    const facts = new Map(g.facts).set(101, mocked).set(102, symbolUse).set(201, symbolDef);
    const factsByFile = new Map(g.factsByFile)
      .set(1, [g.facts.get(100) as FactRow, mocked, symbolUse])
      .set(2, [...(g.factsByFile.get(2) ?? []), symbolDef]);
    const graph = {
      ...g, facts, factsByFile,
      anchorLinks: [
        ...g.anchorLinks,
        { factId: 102, anchorKey: k('js-symbol:a.php:x'), role: 'subject' as const },
        { factId: 201, anchorKey: k('js-symbol:a.php:x'), role: 'target' as const },
      ],
    };
    const r = traverseTest(graph, buildAnchorIndex(graph), 100, 't1', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0, maxWildcardMatchesPerAnchor: 32,
    });
    expect(r.edges).toEqual([]);
  });

  it('does not expand dynamic imports reached through source files', () => {
    const g = tinyGraph();
    const dynamicImport: FactRow = {
      id: 200, fileId: 2, kind: 'import-edge', resolved: true, startLine: 1, endLine: 1,
      payload: {
        kind: 'import-edge', specifier: './lazy', resolved: true, resolvedPath: 'b.php',
        meta: { dynamic: true },
      },
    };
    const facts = new Map(g.facts).set(200, dynamicImport);
    const factsByFile = new Map(g.factsByFile).set(2, [dynamicImport]);
    const graph = { ...g, facts, factsByFile, anchorLinks: g.anchorLinks.slice(0, 1) };
    const r = traverseTest(graph, buildAnchorIndex(graph), 100, 't1', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0, maxWildcardMatchesPerAnchor: 32,
    });
    expect(r.edges.map((e) => e.source)).toEqual(['a.php']);
  });

  it('does not execute callable bodies merely because their file is included', () => {
    const g = tinyGraph();
    const includeToA: FactRow = {
      ...(g.facts.get(101) as FactRow),
      kind: 'php-include',
      payload: { kind: 'php-include', target: 'a.php' },
    };
    const callable: FactRow = {
      id: 200, fileId: 2, kind: 'symbol-def', resolved: true, startLine: 1, endLine: 3,
      payload: { kind: 'symbol-def', name: 'lazy', exported: true, meta: { callable: true } },
    };
    const nestedInclude: FactRow = {
      id: 201, fileId: 2, kind: 'php-include', resolved: true, startLine: 2, endLine: 2,
      payload: { kind: 'php-include', target: 'b.php' },
    };
    const facts = new Map(g.facts)
      .set(101, includeToA)
      .set(200, callable)
      .set(201, nestedInclude);
    const factsByFile = new Map(g.factsByFile)
      .set(1, [g.facts.get(100) as FactRow, includeToA])
      .set(2, [callable, nestedInclude]);
    const graph = { ...g, facts, factsByFile, anchorLinks: [] };
    const r = traverseTest(graph, buildAnchorIndex(graph), 100, 't1', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0, maxWildcardMatchesPerAnchor: 32,
    });
    expect(r.edges.map((e) => e.source)).toEqual(['a.php']);
  });

  it('traverses through test helpers without returning them as sources', () => {
    const g = tinyGraph();
    const files = new Map(g.files);
    files.set(2, { ...(files.get(2) as FileRow), framework: 'jest', frameworkClass: 'unit' });
    const graph = { ...g, files };
    const r = traverseTest(graph, buildAnchorIndex(graph), 100, 't1', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0, maxWildcardMatchesPerAnchor: 32,
    });
    expect(r.edges.map((e) => e.source)).toEqual(['b.php']);
  });

  it('respects hook stop-list', () => {
    const g = tinyGraph();
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', {
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
    const r = traverseTest(g, idx, 100, 't1', {
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
    const r = traverseTest(g, idx, 100, 't1', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(['thing']), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    const aEdge = r.edges.find((e) => e.source === 'a.php');
    expect(aEdge).toBeDefined();
    expect(aEdge?.evidence.every((e) => e.kind === 'js-import')).toBe(true);
    expect(aEdge?.partial).toBe(false);
  });

  it('unit tests reaching an apiFetch caller bridge to rest-endpoint', () => {
    // Program Phase 4: the rest-call-js bridge has no framework-class gate. A
    // unit test that imports the apiFetch caller reaches the rest-call-js fact
    // and bridges to the rest-endpoint. An e2e spec with no static import path
    // to the caller does not reach the fact — not because of a gate, but
    // because the import graph has no edge to traverse.
    const f1: FileRow = { id: 1, path: 'tests/unit.test.ts', language: 'ts', vendor: false, framework: 'jest', frameworkClass: 'unit' };
    const f2: FileRow = { id: 2, path: 'src/endpoint.php', language: 'php', vendor: false, framework: null, frameworkClass: null };
    const f3: FileRow = { id: 3, path: 'src/caller.ts', language: 'ts', vendor: false, framework: null, frameworkClass: null };
    const td: FactRow = { id: 1, fileId: 1, kind: 'test-def', resolved: true, startLine: 1, endLine: 1, payload: {} };
    const imp: FactRow = {
      id: 2, fileId: 1, kind: 'import-edge', resolved: true, startLine: 1, endLine: 1,
      payload: { kind: 'import-edge', specifier: './caller', resolved: true, resolvedPath: 'src/caller.ts' },
    };
    const rcj: FactRow = { id: 3, fileId: 3, kind: 'rest-call-js', resolved: true, startLine: 1, endLine: 1, payload: {} };
    const endpoint: FactRow = { id: 4, fileId: 2, kind: 'rest-endpoint', resolved: true, startLine: 1, endLine: 1, payload: {} };
    const g: Graph = {
      files: new Map([[1, f1], [2, f2], [3, f3]]),
      facts: new Map([[1, td], [2, imp], [3, rcj], [4, endpoint]]),
      factsByFile: new Map([[1, [td, imp]], [2, [endpoint]], [3, [rcj]]]),
      anchorLinks: [
        { factId: 2, anchorKey: k('js-module:src/caller.ts'), role: 'module' },
        { factId: 3, anchorKey: k('rest:GET /x'), role: 'target' },
        { factId: 4, anchorKey: k('rest:GET /x'), role: 'subject' },
      ],
      tests: [],
    };
    const idx = buildAnchorIndex(g);

    const unit = traverseTest(g, idx, 1, 't1', { maxDepth: 25, maxMillisPerTest: 5000, threshold: 0, hookStopList: new Set(), now: () => 0, maxWildcardMatchesPerAnchor: 32 });
    expect(unit.edges.some((e) => e.source === 'src/endpoint.php')).toBe(true);

    // An e2e spec that does NOT import the caller never reaches the rest-call-js
    // fact — no import edge to traverse. No gate involved.
    const gNoImport: Graph = {
      ...g,
      facts: new Map([[1, td], [3, rcj], [4, endpoint]]),
      factsByFile: new Map([[1, [td]], [2, [endpoint]], [3, [rcj]]]),
      anchorLinks: g.anchorLinks.filter((l) => l.factId !== 2),
    };
    const e2e = traverseTest(gNoImport, buildAnchorIndex(gNoImport), 1, 't2', { maxDepth: 25, maxMillisPerTest: 5000, threshold: 0, hookStopList: new Set(), now: () => 0, maxWildcardMatchesPerAnchor: 32 });
    expect(e2e.edges.some((e) => e.source === 'src/endpoint.php')).toBe(false);
  });

  it('structural import edges keep BASE_CONFIDENCE (characterization — must not change)', () => {
    const g = tinyGraph();
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    // a.php is reached by a js-import edge (BASE_CONFIDENCE 0.95).
    const aEdge = r.edges.find((e) => e.source === 'a.php');
    expect(aEdge).toBeDefined();
    expect(aEdge?.confidence).toBeCloseTo(0.95);
  });

  it('does not traverse a type-only import edge', () => {
    const base = tinyGraph();
    const importFact = base.facts.get(101);
    const testFact = base.facts.get(100);
    if (!importFact || !testFact) throw new Error('fixture');
    const typeOnlyImport: FactRow = {
      ...importFact,
      payload: {
        kind: 'import-edge', specifier: './a', resolved: true,
        resolvedPath: 'a.php', meta: { typeOnly: true },
      },
    };
    const facts = new Map(base.facts).set(101, typeOnlyImport);
    const factsByFile = new Map(base.factsByFile).set(1, [testFact, typeOnlyImport]);
    const g: Graph = { ...base, facts, factsByFile };
    const r = traverseTest(g, buildAnchorIndex(g), 100, 't1', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });

    expect(r.edges).toEqual([]);
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
    const rUnresolved = traverseTest(gUnresolved, buildAnchorIndex(gUnresolved), 1, 't1', opts);
    const gResolved = build(true);
    const rResolved = traverseTest(gResolved, buildAnchorIndex(gResolved), 1, 't1', opts);

    const kindsOf = (r: ReturnType<typeof traverseTest>): string[] =>
      (r.edges.find((e) => e.source === 'src/endpoint.php')?.evidence.map((e) => e.kind) ?? []).sort();

    // The edge exists in both, and the evidence kinds are identical.
    expect(kindsOf(rResolved)).toEqual(kindsOf(rUnresolved));
    // The bridging rest-call-js is resolved → the kind is rest-mediated.
    expect(kindsOf(rResolved)).toContain('rest-mediated');
    expect(rResolved.edges[0]?.partial).toBe(false);
  });

  it('e2e tests still bridge ajax-call-js to ajax-listener (characterization — must not regress)', () => {
    const g = ajaxGraph({ testFrameworkClass: 'e2e', callResolved: true });
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', {
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
    const r = traverseTest(g, idx, 100, 't1', {
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
    const r = traverseTest(g, idx, 100, 't1', {
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
    const r = traverseTest(g2, idx, 100, 't1', {
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
    const r = traverseTest(g, idx, 100, 't1', {
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
    // Unit-class test: the rest-call-js bridge has no framework-class gate
    // (program Phase 4); the broad-wildcard endpoint is priced by Phase 1.
    const r = traverseTest(g, idx, 100, 't1', {
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
    expect(broadEdge?.evidence.some((ev) => ev.kind === 'rest-mediated-broad-fallback-partial')).toBe(true);
    expect(broadEdge?.partial).toBe(true);
  });

  it('does not emit a test fixture from another framework as a source', () => {
    const g = broadWildcardGraph();
    const files = new Map(g.files);
    files.set(2, {
      id: 2,
      path: 'app.ts',
      language: 'ts',
      vendor: false,
      framework: 'jest',
      frameworkClass: 'unit',
    });
    files.set(3, {
      id: 3,
      path: 'tests/RestApiCacheTest.php',
      language: 'php',
      vendor: false,
      framework: 'phpunit',
      frameworkClass: 'unit',
    });
    const g2: Graph = { ...g, files };
    const r = traverseTest(g2, buildAnchorIndex(g2), 100, 't1', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });

    expect(r.edges.some((e) => e.source === 'tests/RestApiCacheTest.php')).toBe(false);
    expect(r.edges.some((e) => e.source === 'app.ts')).toBe(false);
  });

  it('keeps unresolved broad REST pricing while marking the fallback', () => {
    const g = broadWildcardGraph();
    const restCall = g.facts.get(200);
    if (!restCall) throw new Error('fixture');
    const facts = new Map(g.facts).set(200, { ...restCall, resolved: false });
    const factsByFile = new Map(g.factsByFile);
    factsByFile.set(2, (factsByFile.get(2) ?? []).map((f) => facts.get(f.id) ?? f));
    const g2: Graph = { ...g, facts, factsByFile };

    const r = traverseTest(g2, buildAnchorIndex(g2), 100, 't1', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    const edge = r.edges.find((e) => e.source === 'broad.php');
    expect(edge?.evidence.some(
      (ev) => ev.kind === 'rest-mediated-broad-fallback-unresolved-partial',
    )).toBe(true);
    expect(edge?.confidence).toBeCloseTo(0.1058);
    expect(edge?.partial).toBe(true);
  });

  it('does not emit an imported test file from another framework as a source', () => {
    const g = broadWildcardGraph();
    const files = new Map(g.files);
    files.set(2, {
      id: 2,
      path: 'app.ts',
      language: 'ts',
      vendor: false,
      framework: 'phpunit',
      frameworkClass: 'unit',
    });
    const g2: Graph = { ...g, files };
    const r = traverseTest(g2, buildAnchorIndex(g2), 100, 't1', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });

    expect(r.edges.some((e) => e.source === 'app.ts')).toBe(false);
  });

  it('traverses through an imported test file from another framework', () => {
    const g = broadWildcardGraph();
    const files = new Map(g.files);
    const incompatible = files.get(2);
    if (!incompatible) throw new Error('fixture');
    files.set(2, { ...incompatible, framework: 'phpunit', frameworkClass: 'unit' });
    files.set(4, {
      id: 4, path: 'downstream.ts', language: 'ts', vendor: false,
      framework: null, frameworkClass: null,
    });
    const importDownstream: FactRow = {
      id: 201, fileId: 2, kind: 'import-edge', resolved: true,
      startLine: 2, endLine: 2,
      payload: { kind: 'import-edge', resolvedPath: 'downstream.ts' },
    };
    const downstreamFact: FactRow = {
      id: 400, fileId: 4, kind: 'symbol-def', resolved: true,
      startLine: 1, endLine: 1, payload: { kind: 'symbol-def', symbol: 'downstream' },
    };
    const facts = new Map(g.facts).set(201, importDownstream).set(400, downstreamFact);
    const factsByFile = new Map(g.factsByFile);
    factsByFile.set(2, [...(factsByFile.get(2) ?? []), importDownstream]);
    factsByFile.set(4, [downstreamFact]);
    const g2: Graph = { ...g, files, facts, factsByFile };
    const r = traverseTest(g2, buildAnchorIndex(g2), 100, 't1', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });

    expect(r.edges.some((e) => e.source === 'downstream.ts')).toBe(true);
  });

  it('prices an exact REST bridge high', () => {
    const g = broadWildcardGraph();
    // Swap the endpoint's anchor to an exact match of the apiFetch path.
    const exactLinks = g.anchorLinks.map((l) =>
      l.factId === 300 ? { ...l, anchorKey: k('rest:GET /wp/v2/things') } : l,
    );
    const g2: Graph = { ...g, anchorLinks: exactLinks };
    const idx = buildAnchorIndex(g2);
    const r = traverseTest(g2, idx, 100, 't1', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    const edge = r.edges.find((e) => e.source === 'broad.php');
    expect(edge).toBeDefined();
    // rest-mediated 0.85 * exact 1 * 0.92**2 (0.8464) = 0.71944.
    expect(edge?.confidence).toBeCloseTo(0.71944);
    expect(edge?.confidence).toBeGreaterThan(0.7);
    expect(edge?.evidence.some((ev) => ev.kind === 'rest-mediated')).toBe(true);
    expect(edge?.partial).toBe(false);
  });

  it('unit tests walk REST edges through an imported apiFetch caller', () => {
    // Program Phase 4: a unit-class test that imports the apiFetch caller
    // bridges rest-call-js -> rest-endpoint. broadWildcardGraph's test file is
    // already unit-class; swap the endpoint anchor to an exact match.
    const g = broadWildcardGraph();
    const exactLinks = g.anchorLinks.map((l) =>
      l.factId === 300 ? { ...l, anchorKey: k('rest:GET /wp/v2/things') } : l,
    );
    const g2: Graph = { ...g, anchorLinks: exactLinks };
    const idx = buildAnchorIndex(g2);
    const r = traverseTest(g2, idx, 100, 't1', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    const edge = r.edges.find((e) => e.source === 'broad.php');
    expect(edge).toBeDefined();
    expect(edge?.evidence.some((ev) => ev.kind === 'rest-mediated')).toBe(true);
    // rest-mediated 0.85 * exact 1 * 0.92**2 (0.8464) = 0.71944.
    expect(edge?.confidence).toBeCloseTo(0.71944);
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
    const r = traverseTest(g2, idx, 100, 't1', {
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
    const r = traverseTest(graph, idx, 100, 'phpunit:tests/x.php::Foo::testIt', {
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

  it('does not bridge a hook with no known name fragment', () => {
    const wildFire: FactRow = {
      id: 100, fileId: 1, kind: 'hook-fire', resolved: false,
      startLine: 1, endLine: 1, payload: { kind: 'hook-fire', hook: '{*}_{*}' },
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
        { factId: 100, anchorKey: k('hook:{*}_{*}'), role: 'target' },
        { factId: 101, anchorKey: k('hook:wp_ajax_save'), role: 'subject' },
      ],
      tests: [],
    };
    const r = traverseTest(graph, buildAnchorIndex(graph), 100, 'phpunit:tests/x.php::Foo::testIt', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    expect(r.edges).toEqual([]);
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
    const r = traverseTest(graph, idx, 200, 'phpunit:tests/x.php::Foo::testIt', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    expect(r.edges.map((e) => e.source)).toEqual(['src/listener.php']);
  });

  it('prefers the same REST wildcard shape over a literal sibling route', () => {
    const testDef: FactRow = {
      id: 300, fileId: 1, kind: 'test-def', resolved: true,
      startLine: 1, endLine: 10, payload: { kind: 'test-def', framework: 'playwright', testId: 't1' },
    };
    const restCall: FactRow = {
      id: 301, fileId: 1, kind: 'rest-call-js', resolved: false,
      startLine: 5, endLine: 5, payload: { kind: 'rest-call-js', url: '/wc/v3/orders/{*}' },
    };
    const itemEndpoint: FactRow = {
      id: 302, fileId: 2, kind: 'rest-endpoint', resolved: true,
      startLine: 1, endLine: 1, payload: { kind: 'rest-endpoint', method: 'PUT', route: '/orders/{*}' },
    };
    const batchEndpoint: FactRow = {
      id: 303, fileId: 3, kind: 'rest-endpoint', resolved: true,
      startLine: 1, endLine: 1, payload: { kind: 'rest-endpoint', method: 'PUT', route: '/orders/batch' },
    };
    const graph: Graph = {
      files: new Map([
        [1, { id: 1, path: 'tests/orders.test.ts', language: 'ts', vendor: false, framework: 'playwright', frameworkClass: 'e2e' }],
        [2, { id: 2, path: 'src/item.php', language: 'php', vendor: false, framework: null, frameworkClass: null }],
        [3, { id: 3, path: 'src/batch.php', language: 'php', vendor: false, framework: null, frameworkClass: null }],
      ]),
      facts: new Map([[300, testDef], [301, restCall], [302, itemEndpoint], [303, batchEndpoint]]),
      factsByFile: new Map([[1, [testDef, restCall]], [2, [itemEndpoint]], [3, [batchEndpoint]]]),
      anchorLinks: [
        { factId: 301, anchorKey: k('rest:PUT /wc/v3/orders/{*}'), role: 'target' },
        { factId: 302, anchorKey: k('rest:PUT /wc/v3/orders/{*}'), role: 'subject' },
        { factId: 303, anchorKey: k('rest:PUT /wc/v3/orders/batch'), role: 'subject' },
      ],
      tests: [],
    };
    const r = traverseTest(graph, buildAnchorIndex(graph), 300, 't1', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    expect(r.edges.map((e) => e.source)).toEqual(['src/item.php']);
    expect(r.edges[0]?.evidence.map((e) => e.kind)).toEqual(['rest-mediated-partial']);
  });

  it('prefers the most specific REST wildcard route for a literal call', () => {
    const testDef: FactRow = {
      id: 400, fileId: 1, kind: 'test-def', resolved: true,
      startLine: 1, endLine: 10, payload: { kind: 'test-def', framework: 'phpunit', testId: 't1' },
    };
    const restCall: FactRow = {
      id: 401, fileId: 1, kind: 'rest-call-js', resolved: true,
      startLine: 5, endLine: 5,
      payload: { kind: 'rest-call-js', method: 'GET', route: '/wp-abilities/v1/abilities/test/example/run' },
    };
    const listEndpoint: FactRow = {
      id: 402, fileId: 2, kind: 'rest-endpoint', resolved: true,
      startLine: 1, endLine: 1,
      payload: { kind: 'rest-endpoint', method: 'GET', route: '/abilities/{*}' },
    };
    const runEndpoint: FactRow = {
      id: 403, fileId: 3, kind: 'rest-endpoint', resolved: true,
      startLine: 1, endLine: 1,
      payload: { kind: 'rest-endpoint', method: 'GET', route: '/abilities/{*}/run' },
    };
    const graph: Graph = {
      files: new Map([
        [1, { id: 1, path: 'tests/run.php', language: 'php', vendor: false, framework: 'phpunit', frameworkClass: 'unit' }],
        [2, { id: 2, path: 'src/list.php', language: 'php', vendor: false, framework: null, frameworkClass: null }],
        [3, { id: 3, path: 'src/run.php', language: 'php', vendor: false, framework: null, frameworkClass: null }],
      ]),
      facts: new Map([[400, testDef], [401, restCall], [402, listEndpoint], [403, runEndpoint]]),
      factsByFile: new Map([[1, [testDef, restCall]], [2, [listEndpoint]], [3, [runEndpoint]]]),
      anchorLinks: [
        { factId: 401, anchorKey: k('rest:GET /wp-abilities/v1/abilities/test/example/run'), role: 'target' },
        { factId: 402, anchorKey: k('rest:GET /wp-abilities/v1/abilities/{*}'), role: 'subject' },
        { factId: 403, anchorKey: k('rest:GET /wp-abilities/v1/abilities/{*}/run'), role: 'subject' },
      ],
      tests: [],
    };
    const r = traverseTest(graph, buildAnchorIndex(graph), 400, 't1', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0,
      maxWildcardMatchesPerAnchor: 32,
    });
    expect(r.edges.map((e) => e.source)).toEqual(['src/run.php']);
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

    const r = traverseTest(graph, idx, 9000, 'phpunit:tests/x.php::Foo::testIt', {
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
    const r = traverseTest(g, idx, 100, 't1', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0, maxWildcardMatchesPerAnchor: 32,
    });
    const js = r.edges.find((e) => e.source === 'assets/js/admin/inline-edit.js');
    expect(js).toBeDefined();
    expect(js?.evidence.some((ev) => ev.kind === 'enqueue-mediated')).toBe(true);
    expect(js?.evidence.some((ev) => ev.kind === 'enqueue-mediated-sibling-fallback-partial')).toBe(false);
    expect(js?.partial).toBe(false);
  });

  it('the bridge carries on into the enqueued file’s ajax-mediated edge', () => {
    const g = enqueueGraph({ testFrameworkClass: 'unit' });
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', {
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
    const r = traverseTest(g, idx, 100, 't1', {
      maxDepth: 25, maxMillisPerTest: 5000, threshold: 0,
      hookStopList: new Set(), now: () => 0, maxWildcardMatchesPerAnchor: 32,
    });
    const js = r.edges.find((e) => e.source === 'assets/js/admin/x.js');
    expect(js).toBeDefined();
    expect(js?.evidence.some((ev) => ev.kind === 'enqueue-mediated-sibling-fallback-partial')).toBe(true);
    expect(js?.partial).toBe(true);
  });

  it('enqueue-mediated edges attenuate with traversal distance', () => {
    const g = enqueueGraph({ testFrameworkClass: 'unit' });
    const idx = buildAnchorIndex(g);
    const r = traverseTest(g, idx, 100, 't1', {
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
