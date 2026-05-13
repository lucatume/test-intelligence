import type { AnchorKey, FactKind } from '../types.js';
import type { AnchorRole } from '../facts/types.js';
import type { Edge, EdgeKind, FactRow, Graph } from './types.js';
import type { AnchorIndex } from './anchor-index.js';
import { BASE_CONFIDENCE, combineConfidence } from './confidence.js';

export interface TraversalOptions {
  readonly maxDepth: number;
  readonly maxMillisPerTest: number;
  readonly threshold: number;
  readonly hookStopList: ReadonlySet<string>;
  readonly now: () => number;
}

export interface TraversalResult {
  readonly edges: readonly Edge[];
  readonly bounded: boolean;
}

interface EvidenceAgg {
  readonly kinds: Map<EdgeKind, Set<number>>;
  partial: boolean;
}

interface QueueItem {
  readonly fact: FactRow;
  readonly depth: number;
  readonly arrivalKind: EdgeKind | null;
  readonly arrivalFactId: number | null;
  readonly arrivalResolved: boolean;
}

export function traverseTest(
  graph: Graph,
  index: AnchorIndex,
  testFactId: number,
  testId: string,
  frameworkClass: 'unit' | 'e2e',
  options: TraversalOptions,
): TraversalResult {
  const start = options.now();
  const visitedFacts = new Set<number>();
  const evidence = new Map<string, EvidenceAgg>();
  const queue: QueueItem[] = [];
  let bounded = false;

  const testFact = graph.facts.get(testFactId);
  if (!testFact) return { edges: [], bounded: false };

  // Seed: every fact in the test's file at depth 0. Test-file facts never
  // contribute edges (the test file is not a "source").
  const testFileFacts = graph.factsByFile.get(testFact.fileId) ?? [];
  for (const f of testFileFacts) {
    queue.push({ fact: f, depth: 0, arrivalKind: null, arrivalFactId: null, arrivalResolved: true });
  }

  while (queue.length > 0) {
    if (options.now() - start > options.maxMillisPerTest) {
      bounded = true;
      break;
    }
    const cur = queue.shift();
    if (!cur) continue;
    if (visitedFacts.has(cur.fact.id)) continue;
    visitedFacts.add(cur.fact.id);
    if (cur.depth > options.maxDepth) {
      bounded = true;
      continue;
    }

    const file = graph.files.get(cur.fact.fileId);

    // Record an edge if this fact lives in a non-test, non-vendor file AND
    // we reached it via some traversal kind (not the seed depth-0 facts).
    if (
      file &&
      file.id !== testFact.fileId &&
      !file.vendor &&
      cur.arrivalKind !== null &&
      cur.arrivalFactId !== null
    ) {
      // Credit the arriving fact (the one that produced the bridge) and this
      // fact (the destination) as evidence for the edge.
      recordEvidence(evidence, file.path, cur.arrivalKind, cur.arrivalFactId, cur.arrivalResolved);
      recordEvidence(evidence, file.path, cur.arrivalKind, cur.fact.id, cur.fact.resolved);
    }

    // Walk outward through this fact's relations.
    enqueueDownstream(graph, index, cur.fact, cur.depth, queue, options, frameworkClass);
  }

  const edges: Edge[] = [];
  for (const [source, agg] of evidence) {
    const kinds: Array<{ kind: EdgeKind; factIds: readonly number[] }> = [];
    const baseValues: number[] = [];
    for (const [kind, ids] of agg.kinds) {
      kinds.push({ kind, factIds: [...ids] });
      baseValues.push(BASE_CONFIDENCE[kind]);
    }
    const confidence = combineConfidence(baseValues);
    if (confidence < options.threshold) continue;
    edges.push({ testId, source, confidence, partial: agg.partial, evidence: kinds });
  }
  return { edges, bounded };
}

function enqueueDownstream(
  graph: Graph,
  index: AnchorIndex,
  fact: FactRow,
  depth: number,
  queue: QueueItem[],
  options: TraversalOptions,
  frameworkClass: 'unit' | 'e2e',
): void {
  // 1. import-edge / php-include: resolve directly to target file.
  if (fact.kind === 'import-edge') {
    const resolvedPath = (fact.payload as { resolvedPath?: unknown }).resolvedPath;
    if (typeof resolvedPath === 'string') {
      const target = findFileByPath(graph, resolvedPath);
      if (target) {
        const kind: EdgeKind = 'js-import';
        for (const f of graph.factsByFile.get(target.id) ?? []) {
          queue.push({ fact: f, depth: depth + 1, arrivalKind: kind, arrivalFactId: fact.id, arrivalResolved: fact.resolved });
        }
      }
    }
    return;
  }
  if (fact.kind === 'php-include') {
    const target = (fact.payload as { target?: unknown }).target;
    if (typeof target === 'string') {
      const file = findFileByPath(graph, target);
      if (file) {
        const kind: EdgeKind = 'php-include';
        for (const f of graph.factsByFile.get(file.id) ?? []) {
          queue.push({ fact: f, depth: depth + 1, arrivalKind: kind, arrivalFactId: fact.id, arrivalResolved: fact.resolved });
        }
      }
    }
    return;
  }

  // 2. Cross-language / hook bridges: follow anchor to complementary facts.
  const bridgeKind = bridgeKindFor(fact.kind, fact.resolved, frameworkClass, fact.payload, options.hookStopList);
  if (bridgeKind === null) return;

  const links = index.linksByFact.get(fact.id) ?? [];
  for (const link of links) {
    for (const partner of complementaryFactsForRole(index, link.anchorKey, link.role)) {
      queue.push({
        fact: partner,
        depth: depth + 1,
        arrivalKind: bridgeKind,
        arrivalFactId: fact.id,
        arrivalResolved: fact.resolved,
      });
    }
  }
}

function bridgeKindFor(
  kind: FactKind,
  resolved: boolean,
  frameworkClass: 'unit' | 'e2e',
  payload: Readonly<Record<string, unknown>>,
  stopList: ReadonlySet<string>,
): EdgeKind | null {
  switch (kind) {
    case 'symbol-use':
      return resolved ? 'symbol-call' : 'symbol-call-uncertain';
    case 'hook-fire': {
      const hook = (payload as { hook?: unknown }).hook;
      if (typeof hook !== 'string') return null;
      if (stopList.has(hook)) return null;
      return resolved ? 'hook-mediated' : 'hook-mediated-uncertain';
    }
    case 'hook-listener':
      // Listener side does not initiate further walks; the symbol-call from the
      // listener's callback body does that on the next BFS iteration through
      // symbol-use facts in the same file.
      return null;
    case 'rest-call-js':
      if (frameworkClass !== 'e2e') return null;
      return resolved ? 'rest-mediated' : 'rest-mediated-partial';
    case 'ajax-call-js':
      if (frameworkClass !== 'e2e') return null;
      return resolved ? 'ajax-mediated' : 'ajax-mediated-partial';
    case 'enqueue-script':
      if (frameworkClass !== 'e2e') return null;
      return 'enqueue-mediated';
    case 'shortcode':
      return 'shortcode-render';
    case 'block-render':
      if (frameworkClass !== 'e2e') return null;
      return 'block-render';
    default:
      return null;
  }
}

function recordEvidence(
  store: Map<string, EvidenceAgg>,
  source: string,
  kind: EdgeKind,
  factId: number,
  resolved: boolean,
): void {
  let entry = store.get(source);
  if (!entry) {
    entry = { kinds: new Map(), partial: false };
    store.set(source, entry);
  }
  let ids = entry.kinds.get(kind);
  if (!ids) {
    ids = new Set();
    entry.kinds.set(kind, ids);
  }
  ids.add(factId);
  if (!resolved) entry.partial = true;
}

function findFileByPath(graph: Graph, path: string) {
  for (const f of graph.files.values()) if (f.path === path) return f;
  return undefined;
}

function complementaryFactsForRole(
  idx: AnchorIndex,
  key: AnchorKey,
  role: AnchorRole,
): readonly FactRow[] {
  switch (role) {
    case 'target':   return idx.subjectsByAnchor.get(key) ?? [];
    case 'subject':  return idx.targetsByAnchor.get(key) ?? [];
    case 'module':   return idx.modulesByAnchor.get(key) ?? [];
    case 'callback': return idx.callbacksByAnchor.get(key) ?? [];
  }
}
