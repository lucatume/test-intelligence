import type { AnchorKey, FactKind } from '../types.js';
import type { AnchorRole } from '../facts/types.js';
import type { DependencyEdge, Edge, EdgeKind, FactRow, FileRow, Graph } from './types.js';
import { wildcardKeyToRegex, wildcardBreadth, type AnchorIndex, type WildcardAnchorEntry } from './anchor-index.js';
import { combineConfidence, evidenceConfidence, type MatchPrecision } from './confidence.js';

export interface TraversalOptions {
  readonly maxDepth: number;
  readonly maxMillisPerTest: number;
  readonly threshold: number;
  readonly hookStopList: ReadonlySet<string>;
  readonly now: () => number;
  readonly maxWildcardMatchesPerAnchor: number;
}

export interface TraversalResult {
  readonly edges: readonly Edge[];
  readonly bounded: boolean;
}

export interface DependencyTraversalResult {
  readonly rows: readonly DependencyEdge[];
  readonly unknownPaths: readonly string[];
}

interface EvidenceAgg {
  // kind -> contributing fact ids + the attenuated confidence of each
  // contributing path. combineConfidence consumes `values` directly.
  // `ids` is the union of arrival + destination fact ids (provenance display).
  // `destIds` is the dedup key for value pushes: one observation per destination
  // fact per kind, regardless of how many seed facts reached it.
  readonly kinds: Map<EdgeKind, { ids: Set<number>; destIds: Set<number>; values: number[] }>;
}

interface QueueItem {
  readonly fact: FactRow;
  readonly depth: number;
  readonly arrivalKind: EdgeKind | null;
  readonly arrivalFactId: number | null;
  // Match precision of the edge that reached this fact. `exact` for the seed
  // facts and for structural arrivals; the matched tier for bridge arrivals.
  readonly arrivalPrecision: keyof MatchPrecision;
  // True iff `arrivalKind` is a bridge kind (distance decay applies).
  readonly arrivalIsBridge: boolean;
  readonly enqueueSiblingFallback?: boolean;
}

/** A partner fact found by the anchor join, tagged with how precise the match was. */
interface MatchedPartner {
  readonly fact: FactRow;
  readonly precision: keyof MatchPrecision;
}

// Cadence for the wall-clock bound check inside the BFS hot loop. Checking
// `now()` every iteration shows up at scale; checking every 1024 iterations
// keeps overshoot at most ~1024 iterations of CPU work — well under the
// 5000 ms budget. Overshoot can only *grow* a bounded test's edge set
// (supersets are allowed under the correctness gate).
const TIME_CHECK_INTERVAL = 1024;

export function traverseTest(
  graph: Graph,
  index: AnchorIndex,
  testFactId: number,
  testId: string,
  options: TraversalOptions,
): TraversalResult {
  const start = options.now();
  const deadline = start + options.maxMillisPerTest;
  const enqueued = new Set<number>();
  // Keyed by file id, not file path — Map<number, X> hashes faster than
  // Map<string, X> in v8, and the file id is what the BFS already has.
  // The path is resolved once per source at materialization time below.
  const evidence = new Map<number, EvidenceAgg>();
  const queue: QueueItem[] = [];
  let head = 0;
  let bounded = false;
  let iter = 0;

  const testFact = graph.facts.get(testFactId);
  if (!testFact) return { edges: [], bounded: false };

  // Seed: every fact in the test's file at depth 0. Test-file facts never
  // contribute edges (the test file is not a "source"). Mark them
  // enqueued so anchor-link cycles can't push them back in.
  const allTestFileFacts = graph.factsByFile.get(testFact.fileId) ?? [];
  const testFile = graph.files.get(testFact.fileId);
  const testFileFacts = testFile?.framework === 'phpunit'
    ? phpUnitSeedFacts(allTestFileFacts, testFact)
    : testFile?.framework !== null && testFile?.framework !== undefined
      ? jsTestSeedFacts(allTestFileFacts, testFact)
      : allTestFileFacts;
  const mockedPaths = new Set<string>();
  for (const f of allTestFileFacts) {
    if (f.kind !== 'import-edge') continue;
    const meta = f.payload['meta'] as { readonly mocked?: unknown } | undefined;
    const path = f.payload['resolvedPath'];
    if (meta?.mocked === true && typeof path === 'string') mockedPaths.add(path);
  }
  for (const f of testFileFacts) {
    if (enqueued.has(f.id)) continue;
    enqueued.add(f.id);
    queue.push({
      fact: f, depth: 0, arrivalKind: null, arrivalFactId: null,
      arrivalPrecision: 'exact', arrivalIsBridge: false,
    });
  }

  while (head < queue.length) {
    if ((iter++ & (TIME_CHECK_INTERVAL - 1)) === 0 && options.now() > deadline) {
      bounded = true;
      break;
    }
    const cur = queue[head++];
    if (!cur) continue;
    if (cur.depth > options.maxDepth) {
      bounded = true;
      continue;
    }

    const file = graph.files.get(cur.fact.fileId);

    // Record an edge if this fact lives in a framework-compatible, non-vendor
    // file AND we reached it via some traversal kind (not the seed facts).
    if (
      file &&
      file.id !== testFact.fileId &&
      isSource(file) &&
      cur.arrivalKind !== null &&
      cur.arrivalFactId !== null
    ) {
      // Structural and bridge arrivals both land here. Distance decay applies
      // to bridge kinds only; `arrivalIsBridge` is set when the arriving kind
      // is a cross-language / hook bridge. `arrivalPrecision` is `exact` for
      // structural arrivals and carries the match tier for bridge arrivals.
      const c = evidenceConfidence(
        cur.arrivalKind,
        cur.arrivalPrecision,
        cur.depth,
        cur.arrivalIsBridge,
      );
      recordEvidence(evidence, file.id, cur.arrivalKind, cur.arrivalFactId, cur.fact.id, c);
    }

    // Walk outward through this fact's relations.
    enqueueDownstream(
      graph, index, cur.fact, cur.depth, queue, enqueued, options, evidence,
      testFact.fileId, cur.enqueueSiblingFallback === true, mockedPaths,
    );
  }

  const edges: Edge[] = [];
  for (const [fileId, agg] of evidence) {
    const sourceFile = graph.files.get(fileId);
    if (!sourceFile) continue;
    const kinds: Array<{ kind: EdgeKind; factIds: readonly number[] }> = [];
    const pathValues: number[] = [];
    for (const [kind, slot] of agg.kinds) {
      kinds.push({ kind, factIds: [...slot.ids] });
      // Each recorded path is an independent observation — feed every
      // attenuated value into the combination formula.
      for (const v of slot.values) pathValues.push(v);
    }
    const confidence = combineConfidence(pathValues);
    if (confidence < options.threshold) continue;
    // `partial` reflects evidence KIND quality (an *-uncertain / *-partial
    // variant), independent of the numeric attenuation applied to confidence.
    const partial = kinds.some(
      (kk) => kk.kind.endsWith('-uncertain') || kk.kind.endsWith('-partial'),
    );
    edges.push({ testId, source: sourceFile.path, confidence, partial, evidence: kinds });
  }
  return { edges, bounded };
}

export function directDependenciesFromSources(
  graph: Graph,
  index: AnchorIndex,
  sources: readonly string[],
  options: TraversalOptions,
): DependencyTraversalResult {
  const rows: DependencyEdge[] = [];
  const unknownPaths: string[] = [];
  for (const source of new Set(sources)) {
    const sourceFile = index.filesByPath.get(source);
    if (!sourceFile || !isSource(sourceFile)) {
      unknownPaths.push(source);
      continue;
    }
    const evidence = new Map<number, EvidenceAgg>();
    for (const seed of graph.factsByFile.get(sourceFile.id) ?? []) {
      const queue: QueueItem[] = [];
      enqueueDownstream(
        graph, index, seed, 0, queue, new Set([seed.id]), options, evidence,
        sourceFile.id, false, new Set(),
      );
      for (const item of queue) {
        const target = graph.files.get(item.fact.fileId);
        if (!target || target.id === sourceFile.id || !isSource(target)) continue;
        if (item.arrivalKind === null || item.arrivalFactId === null) continue;
        recordEvidence(
          evidence,
          target.id,
          item.arrivalKind,
          item.arrivalFactId,
          item.fact.id,
          evidenceConfidence(item.arrivalKind, item.arrivalPrecision, 1, item.arrivalIsBridge),
        );
      }
    }
    for (const [targetId, agg] of evidence) {
      const target = graph.files.get(targetId);
      if (!target) continue;
      const kinds = [...agg.kinds.keys()].sort();
      const confidence = combineConfidence([...agg.kinds.values()].flatMap((slot) => slot.values));
      if (confidence < options.threshold) continue;
      rows.push({
        source,
        target: target.path,
        confidence,
        partial: kinds.some((kind) => kind.endsWith('-partial') || kind.endsWith('-uncertain')),
        kinds,
      });
    }
  }
  rows.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  return { rows, unknownPaths };
}

function enqueueDownstream(
  graph: Graph,
  index: AnchorIndex,
  fact: FactRow,
  depth: number,
  queue: QueueItem[],
  enqueued: Set<number>,
  options: TraversalOptions,
  evidence: Map<number, EvidenceAgg>,
  testFileId: number,
  enqueueSiblingFallback: boolean,
  mockedPaths: ReadonlySet<string>,
): void {
  if (isCallableDef(fact)) {
    enqueueCallableBody(graph, fact, depth, queue, enqueued);
  }

  // 1. import-edge / php-include: resolve directly to target file.
  if (fact.kind === 'import-edge') {
    const meta = fact.payload['meta'] as {
      readonly typeOnly?: unknown;
      readonly mocked?: unknown;
      readonly dynamic?: unknown;
    } | undefined;
    if (
      meta?.typeOnly === true ||
      meta?.mocked === true ||
      (meta?.dynamic === true && fact.fileId !== testFileId)
    ) return;
    const resolvedPath = (fact.payload as { resolvedPath?: unknown }).resolvedPath;
    if (typeof resolvedPath === 'string' && !mockedPaths.has(resolvedPath)) {
      const target = index.filesByPath.get(resolvedPath);
      if (target) {
        const kind: EdgeKind = 'js-import';
        for (const f of graph.factsByFile.get(target.id) ?? []) {
          if (enqueued.has(f.id)) continue;
          enqueued.add(f.id);
          queue.push({
            fact: f, depth: depth + 1, arrivalKind: kind, arrivalFactId: fact.id,
            arrivalPrecision: 'exact', arrivalIsBridge: false,
          });
        }
      }
    }
    return;
  }
  if (fact.kind === 'php-include') {
    const explicitTarget = (index.linksByFact.get(fact.id) ?? [])
      .find((link) => link.role === 'target' && link.anchorKey.startsWith('php-file:'))
      ?.anchorKey.slice('php-file:'.length);
    const target = explicitTarget ?? (fact.payload as { target?: unknown }).target;
    if (typeof target === 'string') {
      const file = index.filesByPath.get(target);
      if (file) {
        const kind: EdgeKind = 'php-include';
        const targetFacts = graph.factsByFile.get(file.id) ?? [];
        const destination = targetFacts[0] ?? fact;
        if (file.id !== testFileId && isSource(file)) {
          recordEvidence(
            evidence,
            file.id,
            kind,
            fact.id,
            destination.id,
            evidenceConfidence(kind, 'exact', depth + 1, false),
          );
        }
        for (const f of fileScopeFacts(targetFacts)) {
          if (enqueued.has(f.id)) continue;
          enqueued.add(f.id);
          queue.push({
            fact: f, depth: depth + 1, arrivalKind: null, arrivalFactId: null,
            arrivalPrecision: 'exact', arrivalIsBridge: false,
          });
        }
      }
    }
    return;
  }

  // enqueue-script: resolve the js-module anchor to the enqueued JS file and
  // enqueue that file's facts. This is the only static reachability route to
  // classic-WP admin scripts — they are not ES modules, nothing imports them.
  if (fact.kind === 'enqueue-script') {
    const links = index.linksByFact.get(fact.id) ?? [];
    for (const link of links) {
      if (link.role !== 'target' || !link.anchorKey.startsWith('js-module:')) continue;
      const modPath = link.anchorKey.slice('js-module:'.length);
      const target = index.filesByPath.get(modPath);
      if (!target) continue;
      const kind: EdgeKind = enqueueSiblingFallback
        ? 'enqueue-mediated-sibling-fallback-partial'
        : 'enqueue-mediated';
      for (const f of graph.factsByFile.get(target.id) ?? []) {
        if (enqueued.has(f.id)) continue;
        enqueued.add(f.id);
        queue.push({
          fact: f, depth: depth + 1, arrivalKind: kind, arrivalFactId: fact.id,
          arrivalPrecision: 'exact', arrivalIsBridge: true,
        });
      }
    }
    return;
  }

  // 2. Cross-language / hook bridges: follow anchor to complementary facts.
  if (fact.kind === 'symbol-use') {
    const links = index.linksByFact.get(fact.id) ?? [];
    if ([...mockedPaths].some((path) =>
      links.some((link) => link.anchorKey.startsWith(`js-symbol:${path}:`)),
    )) return;
  }
  const bridgeKind = bridgeKindFor(fact.kind, fact.resolved, fact.payload, options.hookStopList);
  if (bridgeKind === null) return;

  // The bridge initiator was resolved by the LLM pass — attenuate every edge
  // it produces by LLM_RESOLUTION (the resolution is a code-cited judgment,
  // not a measured extractor anchor).
  const llmSourced = isLlmResolved(fact.payload);

  const links = index.linksByFact.get(fact.id) ?? [];
  for (const link of links) {
    for (const partner of complementaryFactsForRole(index, link.anchorKey, link.role, options.maxWildcardMatchesPerAnchor)) {
      const partnerDepth = depth + 1;
      // Attenuate: precision tier from the match, distance from BFS depth,
      // and LLM_RESOLUTION when the initiating fact is llm-pass sourced.
      const scopedHookListener =
        bridgeKind === 'hook-mediated' &&
        partner.fact.kind === 'hook-listener' &&
        (graph.factsByFile.get(partner.fact.fileId) ?? []).some(
          (candidate) => isCallableDef(candidate) && containsFact(candidate, partner.fact),
        );
      const evidenceKind = scopedHookListener
        ? 'hook-mediated-uncertain'
        : broadFallbackKind(bridgeKind, partner.precision);
      const c = evidenceConfidence(evidenceKind, partner.precision, partnerDepth, true, llmSourced);
      // Record bridge evidence for the partner's file even when the partner is
      // already enqueued via another path. Without this, evidence kinds emitted
      // via the bridge (hook-mediated, shortcode-render, …) are lost whenever a
      // shorter-arrival kind (e.g. php-include) reaches the partner first.
      const partnerFile = graph.files.get(partner.fact.fileId);
      if (
        partnerFile &&
        partnerFile.id !== testFileId &&
        isSource(partnerFile)
      ) {
        recordEvidence(evidence, partnerFile.id, evidenceKind, fact.id, partner.fact.id, c);
      }
      // Expose the partner file's enqueue-script siblings (program Phase 3):
      // WP enqueues sit inside hook callbacks, so a PHP file reached via a hook
      // bridge must surface its wp_enqueue_script facts for the enqueue→JS
      // bridge to fire. Scoped to enqueue-script ONLY — surfacing every sibling
      // fact would turn each hook hop into a full-file expansion and blow up
      // the BFS on WP-core-dense graphs. Siblings carry arrivalKind=null: they
      // propagate but record no edge of their own.
      enqueueEnqueueSiblings(graph, partner.fact, partnerDepth, queue, enqueued);
      enqueueAdminPageCallbackSiblings(graph, partner.fact, partnerDepth, queue, enqueued);
      if (enqueued.has(partner.fact.id)) continue;
      enqueued.add(partner.fact.id);
      queue.push({
        fact: partner.fact,
        depth: partnerDepth,
        arrivalKind: evidenceKind,
        arrivalFactId: fact.id,
        arrivalPrecision: partner.precision,
        arrivalIsBridge: true,
      });
    }
  }
}

const PHPUNIT_LIFECYCLE = new Set([
  'setUp', 'tearDown', 'set_up', 'tear_down',
  'setUpBeforeClass', 'tearDownAfterClass',
  'wpSetUpBeforeClass', 'wpTearDownAfterClass',
]);

function phpUnitSeedFacts(facts: readonly FactRow[], testFact: FactRow): readonly FactRow[] {
  const callables = facts.filter(isCallableDef);
  const selected = callables.find((f) => containsLine(f, testFact.startLine));
  const seededRanges = callables.filter((f) => f === selected || PHPUNIT_LIFECYCLE.has(callableMethodName(f)));
  return facts.filter((fact) => {
    if (isCallableDef(fact)) return seededRanges.includes(fact);
    const owner = callables.find((callable) => callable !== fact && containsFact(callable, fact));
    return owner === undefined || seededRanges.includes(owner);
  });
}

function jsTestSeedFacts(facts: readonly FactRow[], testFact: FactRow): readonly FactRow[] {
  const siblings = facts.filter((fact) => fact.kind === 'test-def' && fact.id !== testFact.id);
  const selectedScopes = jsScopeRanges(testFact);
  const selectedScopeKeys = new Set(selectedScopes.map(scopeKey));
  const allScopes = facts.flatMap((fact) => fact.kind === 'test-def' ? jsScopeRanges(fact) : []);
  return facts.filter((fact) =>
    !siblings.some((sibling) => containsFact(sibling, fact))
    && allScopes.every((scope) => !containsScope(scope, fact) || selectedScopeKeys.has(scopeKey(scope))),
  );
}

interface JsScopeRange {
  readonly startLine: number;
  readonly endLine: number;
}

function jsScopeRanges(fact: FactRow): readonly JsScopeRange[] {
  const meta = fact.payload['meta'];
  if (typeof meta !== 'object' || meta === null) return [];
  const ranges = (meta as Readonly<Record<string, unknown>>)['scopeRanges'];
  if (!Array.isArray(ranges)) return [];
  return ranges.filter((range): range is JsScopeRange =>
    typeof range === 'object' && range !== null
    && typeof (range as Readonly<Record<string, unknown>>)['startLine'] === 'number'
    && typeof (range as Readonly<Record<string, unknown>>)['endLine'] === 'number',
  );
}

function containsScope(scope: JsScopeRange, fact: FactRow): boolean {
  return fact.startLine >= scope.startLine && fact.endLine <= scope.endLine;
}

function scopeKey(scope: JsScopeRange): string {
  return `${String(scope.startLine)}:${String(scope.endLine)}`;
}

function enqueueCallableBody(
  graph: Graph,
  callable: FactRow,
  depth: number,
  queue: QueueItem[],
  enqueued: Set<number>,
): void {
  for (const fact of graph.factsByFile.get(callable.fileId) ?? []) {
    if (fact.id === callable.id || !containsFact(callable, fact) || enqueued.has(fact.id)) continue;
    enqueued.add(fact.id);
    queue.push({
      fact, depth, arrivalKind: null, arrivalFactId: null,
      arrivalPrecision: 'exact', arrivalIsBridge: false,
    });
  }
}

function isCallableDef(fact: FactRow): boolean {
  if (fact.kind !== 'symbol-def') return false;
  const meta = fact.payload['meta'];
  return typeof meta === 'object' && meta !== null
    && (meta as Readonly<Record<string, unknown>>)['callable'] === true;
}

function fileScopeFacts(facts: readonly FactRow[]): readonly FactRow[] {
  const callables = facts.filter(isCallableDef);
  return facts.filter((fact) =>
    !isCallableDef(fact) && !callables.some((callable) => containsFact(callable, fact)),
  );
}

function containsFact(container: FactRow, fact: FactRow): boolean {
  return fact.startLine >= container.startLine && fact.endLine <= container.endLine;
}

function containsLine(container: FactRow, line: number): boolean {
  return line >= container.startLine && line <= container.endLine;
}

function callableMethodName(fact: FactRow): string {
  const name = fact.payload['name'];
  if (typeof name !== 'string') return '';
  const pos = name.lastIndexOf('::');
  return pos === -1 ? name : name.slice(pos + 2);
}

function isSource(file: FileRow): boolean {
  return !file.vendor && file.framework === null;
}

/**
 * Enqueue the `enqueue-script` facts in `anchorFact`'s file as propagate-only
 * BFS items (`arrivalKind = null`). Used when a bridge arrival exposes a PHP
 * file: WP `wp_enqueue_script` calls live inside hook callbacks, so a file
 * reached via a hook bridge must surface its enqueues for the enqueue→JS
 * bridge to fire. Scoped to enqueue-script only — surfacing every sibling fact
 * would turn each hook hop into a full-file expansion. The siblings record no
 * edge of their own; `enqueueDownstream` resolves their js-module anchor.
 */
function enqueueEnqueueSiblings(
  graph: Graph,
  anchorFact: FactRow,
  depth: number,
  queue: QueueItem[],
  enqueued: Set<number>,
): void {
  for (const f of graph.factsByFile.get(anchorFact.fileId) ?? []) {
    if (f.kind !== 'enqueue-script') continue;
    if (enqueued.has(f.id)) continue;
    enqueued.add(f.id);
    queue.push({
      fact: f, depth, arrivalKind: null, arrivalFactId: null,
      arrivalPrecision: 'exact', arrivalIsBridge: false,
      enqueueSiblingFallback: true,
    });
  }
}

/**
 * When an admin-page-mediated bridge arrives at an `admin-page-register` fact,
 * surface the sibling `symbol-use` fact(s) the PHP extractor emits at the same
 * `add_menu_page` / `add_submenu_page` call — anchored at `php-symbol:<cb>`
 * role 'subject'. Those uses bridge via the symbol-call kind to the
 * `symbol-def` in the callback's defining file (the second hop of the e2e
 * edge). Scoped narrowly to admin-page-register sibling expansion to avoid
 * turning every bridge into a full-file fan-out.
 */
function enqueueAdminPageCallbackSiblings(
  graph: Graph,
  anchorFact: FactRow,
  depth: number,
  queue: QueueItem[],
  enqueued: Set<number>,
): void {
  if (anchorFact.kind !== 'admin-page-register') return;
  for (const f of graph.factsByFile.get(anchorFact.fileId) ?? []) {
    if (f.kind !== 'symbol-use') continue;
    if (f.startLine !== anchorFact.startLine) continue;
    if (enqueued.has(f.id)) continue;
    enqueued.add(f.id);
    queue.push({
      fact: f, depth, arrivalKind: null, arrivalFactId: null,
      arrivalPrecision: 'exact', arrivalIsBridge: false,
    });
  }
}

function broadFallbackKind(
  kind: EdgeKind,
  precision: keyof MatchPrecision,
): EdgeKind {
  if (precision !== 'wildcardBroad') return kind;
  if (kind === 'rest-mediated') return 'rest-mediated-broad-fallback-partial';
  if (kind === 'rest-mediated-partial') {
    return 'rest-mediated-broad-fallback-unresolved-partial';
  }
  return kind;
}

// True when the fact's payload carries `meta.resolvedBy === 'llm-pass'` — the
// LLM-resolution pass filled it. Edges it initiates are LLM_RESOLUTION-priced.
function isLlmResolved(payload: Readonly<Record<string, unknown>>): boolean {
  const meta = payload['meta'];
  return typeof meta === 'object' && meta !== null
    && (meta as Record<string, unknown>)['resolvedBy'] === 'llm-pass';
}

function bridgeKindFor(
  kind: FactKind,
  resolved: boolean,
  payload: Readonly<Record<string, unknown>>,
  stopList: ReadonlySet<string>,
): EdgeKind | null {
  switch (kind) {
    case 'symbol-use':
      return resolved ? 'symbol-call' : 'symbol-call-uncertain';
    case 'hook-fire': {
      const hook = (payload as { hook?: unknown }).hook;
      if (typeof hook !== 'string') return null;
      if (!/[A-Za-z0-9]/.test(hook.replaceAll('{*}', ''))) return null;
      if (stopList.has(hook)) return null;
      return resolved ? 'hook-mediated' : 'hook-mediated-uncertain';
    }
    case 'hook-listener':
      // Listener side does not initiate further walks; the symbol-call from the
      // listener's callback body does that on the next BFS iteration through
      // symbol-use facts in the same file.
      return null;
    case 'rest-call-js':
      // No framework-class gate (program Phase 4). e2e specs page.goto() a URL
      // and never statically import the apiFetch caller, so gating to e2e
      // starved this bridge (program failure mode F1). Unit tests that DO
      // import the caller now bridge; Phase 1 tiering prices broad-wildcard
      // fan-out (rest:GET /{*}/{*}) at the 0.25 wildcardBroad tier and
      // literal-exact matches near full confidence, so --min-confidence is the
      // noise filter.
      return resolved ? 'rest-mediated' : 'rest-mediated-partial';
    case 'ajax-call-js':
      // No framework-class gate (program Phase 2). AJAX actions are literal
      // strings on both sides; the ajax:<action> anchor is an exact-match key.
      // e2e specs do not statically import the $.post caller, so gating to e2e
      // starved the bridge (program failure mode F1). Unit tests that DO import
      // the caller now bridge; Phase 1 distance attenuation prices transitive
      // edges honestly.
      return resolved ? 'ajax-mediated' : 'ajax-mediated-partial';
    case 'enqueue-script':
      // No framework-class gate (program Phase 3). The enqueue link is the only
      // static reachability path to classic-WP admin JS — those scripts are not
      // ES modules, nothing imports them. Gating to e2e starved this bridge AND
      // Phase 2's ajax bridge, which can only reach a $.post caller through this
      // link. Phase 1 distance attenuation prices transitive enqueue edges
      // honestly. Note: enqueueDownstream handles enqueue-script via its
      // js-module branch and returns before reaching this switch, so this case
      // is now effectively unreachable for enqueue-script facts; it is kept for
      // exhaustiveness and documents the gate's removal.
      return 'enqueue-mediated';
    case 'admin-page-nav':
      // Program Phase 5: a Playwright spec's page.goto('admin.php?page=<slug>')
      // URL is a static anchor. It bridges, via a literal-exact menu-slug join,
      // to the PHP add_menu_page/add_submenu_page that registers <slug>. No
      // framework-class gate — admin-page-nav facts arise only from
      // page.goto/page.route (Playwright idioms), so the pattern IS the gate.
      // This is the first bridge an e2e spec produces because it is e2e-shaped,
      // not despite it. The survey scoped Phase 5 to this hop: page->bundle is
      // not statically recoverable on real WP codebases.
      return 'admin-page-mediated';
    case 'admin-page-register':
      // Subject side. Like hook-listener, it initiates no further walk; the
      // edge forms from the admin-page-nav (target) side via the anchor join.
      return null;
    case 'store-register':
      // Registration (subject) side. Like hook-listener / admin-page-register
      // it initiates no walk; the edge forms from the store-access (target)
      // side via the wp-store: anchor join.
      return null;
    case 'store-access':
      // @wordpress/data store read/write (useSelect/useDispatch/select/
      // dispatch). No framework-class gate: store access lives in React
      // components imported by unit tests AND exercised by e2e specs; gating
      // to e2e would starve the unit-test path (same reasoning as the rest/
      // ajax bridges). A store key is a literal exact-match string on both
      // sides, so the anchor join is always exact-precision.
      return 'store-mediated';
    case 'shortcode':
      return 'shortcode-render';
    case 'block-render':
      // No framework-class gate. The block-render fire side is JS
      // registerBlockType (a block's edit/save component), which is imported
      // by jest unit component tests — gating to e2e starved the bridge and it
      // produced zero edges. PHP register_block_type is the subject side; the
      // anchor join pairs JS-target ↔ PHP-subject on block:<ns>/<name>.
      return 'block-render';
    default:
      return null;
  }
}

function evidenceSlot(
  store: Map<number, EvidenceAgg>,
  fileId: number,
  kind: EdgeKind,
): { ids: Set<number>; destIds: Set<number>; values: number[] } {
  let entry = store.get(fileId);
  if (!entry) {
    entry = { kinds: new Map() };
    store.set(fileId, entry);
  }
  let slot = entry.kinds.get(kind);
  if (!slot) {
    slot = { ids: new Set(), destIds: new Set(), values: [] };
    entry.kinds.set(kind, slot);
  }
  return slot;
}

/**
 * Record one bridge/structural arrival as evidence: the two endpoint fact ids
 * (arriving fact + destination fact) go into the provenance set, and the
 * attenuated confidence is pushed ONCE per destination fact per edge kind.
 *
 * The dedup key is the destination fact id, not the arrival fact id. Multiple
 * seed facts in the test file all reaching the SAME destination fact (e.g.
 * 59 rest-call-js facts wildcard-matching one broad-wildcard rest-endpoint
 * PHP subject) is one observation firing N times, not N independent paths —
 * pushing N values into combineConfidence's `1 - ∏(1-c)` formula saturates to
 * ~1.00 even with heavy precision attenuation. Distinct destination facts in
 * the same source file remain genuinely independent observations and combine
 * disjunctively, preserving the spec's confidence-combination semantic.
 */
function recordEvidence(
  store: Map<number, EvidenceAgg>,
  fileId: number,
  kind: EdgeKind,
  arrivalFactId: number,
  destFactId: number,
  confidence: number,
): void {
  const slot = evidenceSlot(store, fileId, kind);
  slot.ids.add(arrivalFactId);
  slot.ids.add(destFactId);
  if (slot.destIds.has(destFactId)) return;
  slot.destIds.add(destFactId);
  slot.values.push(confidence);
}

function complementaryFactsForRole(
  idx: AnchorIndex,
  key: AnchorKey,
  role: AnchorRole,
  cap: number,
): readonly MatchedPartner[] {
  const isWild = key.includes('{*}');
  // Pick the complementary side's exact map and wildcard list.
  let exactMap: ReadonlyMap<AnchorKey, readonly FactRow[]>;
  let wildList: readonly WildcardAnchorEntry[];
  switch (role) {
    case 'target':
      exactMap = idx.subjectsByAnchor;
      wildList = idx.wildcardSubjects;
      break;
    case 'subject':
      exactMap = idx.targetsByAnchor;
      wildList = idx.wildcardTargets;
      break;
    case 'module':
      exactMap = idx.modulesByAnchor;
      wildList = idx.wildcardModules;
      break;
    case 'callback':
      exactMap = idx.callbacksByAnchor;
      wildList = idx.wildcardCallbacks;
      break;
  }

  if (!isWild) {
    // Literal incoming key: exact lookup (precision exact) + wildcard scan
    // (precision from the matched wildcard entry's precomputed breadth).
    const out: MatchedPartner[] = [];
    const exact = exactMap.get(key) ?? [];
    for (const f of exact) {
      out.push({ fact: f, precision: 'exact' });
    }
    if (wildList.length > 0) {
      const isRest = key.startsWith('rest:');
      let matchingWildcards = wildList;
      if (isRest) {
        matchingWildcards = wildList.filter((entry) => entry.regex.test(key));
      }
      if (matchingWildcards.length > 1 && isRest) {
        const mostLiteral = Math.max(
          ...matchingWildcards.map((entry) => entry.originalKey.replaceAll('{*}', '').length),
        );
        matchingWildcards = matchingWildcards.filter(
          (entry) => entry.originalKey.replaceAll('{*}', '').length === mostLiteral,
        );
      }
      let wildCount = 0;
      outer: for (const entry of matchingWildcards) {
        if (!isRest && !entry.regex.test(key)) continue;
        for (const f of entry.facts) {
          out.push({ fact: f, precision: entry.breadth });
          if (++wildCount >= cap) break outer;
        }
      }
    }
    return out;
  } else {
    // Prefer the identical normalized wildcard shape. A dynamic caller such as
    // /orders/{*} must bind the route-param endpoint, not a literal sibling
    // such as /orders/batch.
    const exactWildcard = wildList.find((entry) => entry.originalKey === key);
    if (exactWildcard) {
      return exactWildcard.facts.map((fact) => ({ fact, precision: 'exact' }));
    }
    // Otherwise scan literal keys as a lower-confidence wildcard fallback.
    const incomingBreadth = wildcardBreadth(key);
    const regex = wildcardKeyToRegex(key);
    const out: MatchedPartner[] = [];
    outer: for (const [candidateKey, facts] of exactMap) {
      if (!regex.test(candidateKey)) continue;
      for (const f of facts) {
        out.push({ fact: f, precision: incomingBreadth });
        if (out.length >= cap) break outer;
      }
    }
    return out;
  }
}
