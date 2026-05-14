import type { AnchorKey, FactKind } from '../types.js';
import type { AnchorRole } from '../facts/types.js';
import type { Edge, EdgeKind, FactRow, Graph } from './types.js';
import { wildcardKeyToRegex, type AnchorIndex, type WildcardAnchorEntry } from './anchor-index.js';
import { BASE_CONFIDENCE, combineConfidence } from './confidence.js';

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
  frameworkClass: 'unit' | 'e2e',
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
  const testFileFacts = graph.factsByFile.get(testFact.fileId) ?? [];
  for (const f of testFileFacts) {
    if (enqueued.has(f.id)) continue;
    enqueued.add(f.id);
    queue.push({ fact: f, depth: 0, arrivalKind: null, arrivalFactId: null, arrivalResolved: true });
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
      recordEvidence(evidence, file.id, cur.arrivalKind, cur.arrivalFactId, cur.arrivalResolved);
      recordEvidence(evidence, file.id, cur.arrivalKind, cur.fact.id, cur.fact.resolved);
    }

    // Walk outward through this fact's relations.
    enqueueDownstream(graph, index, cur.fact, cur.depth, queue, enqueued, options, frameworkClass);
  }

  const edges: Edge[] = [];
  for (const [fileId, agg] of evidence) {
    const sourceFile = graph.files.get(fileId);
    if (!sourceFile) continue;
    const kinds: Array<{ kind: EdgeKind; factIds: readonly number[] }> = [];
    const baseValues: number[] = [];
    for (const [kind, ids] of agg.kinds) {
      kinds.push({ kind, factIds: [...ids] });
      baseValues.push(BASE_CONFIDENCE[kind]);
    }
    const confidence = combineConfidence(baseValues);
    if (confidence < options.threshold) continue;
    edges.push({ testId, source: sourceFile.path, confidence, partial: agg.partial, evidence: kinds });
  }
  return { edges, bounded };
}

function enqueueDownstream(
  graph: Graph,
  index: AnchorIndex,
  fact: FactRow,
  depth: number,
  queue: QueueItem[],
  enqueued: Set<number>,
  options: TraversalOptions,
  frameworkClass: 'unit' | 'e2e',
): void {
  // 1. import-edge / php-include: resolve directly to target file.
  if (fact.kind === 'import-edge') {
    const resolvedPath = (fact.payload as { resolvedPath?: unknown }).resolvedPath;
    if (typeof resolvedPath === 'string') {
      const target = index.filesByPath.get(resolvedPath);
      if (target) {
        const kind: EdgeKind = 'js-import';
        for (const f of graph.factsByFile.get(target.id) ?? []) {
          if (enqueued.has(f.id)) continue;
          enqueued.add(f.id);
          queue.push({ fact: f, depth: depth + 1, arrivalKind: kind, arrivalFactId: fact.id, arrivalResolved: fact.resolved });
        }
      }
    }
    return;
  }
  if (fact.kind === 'php-include') {
    const target = (fact.payload as { target?: unknown }).target;
    if (typeof target === 'string') {
      const file = index.filesByPath.get(target);
      if (file) {
        const kind: EdgeKind = 'php-include';
        for (const f of graph.factsByFile.get(file.id) ?? []) {
          if (enqueued.has(f.id)) continue;
          enqueued.add(f.id);
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
    for (const partner of complementaryFactsForRole(index, link.anchorKey, link.role, options.maxWildcardMatchesPerAnchor)) {
      if (enqueued.has(partner.id)) continue;
      enqueued.add(partner.id);
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
  store: Map<number, EvidenceAgg>,
  fileId: number,
  kind: EdgeKind,
  factId: number,
  resolved: boolean,
): void {
  let entry = store.get(fileId);
  if (!entry) {
    entry = { kinds: new Map(), partial: false };
    store.set(fileId, entry);
  }
  let ids = entry.kinds.get(kind);
  if (!ids) {
    ids = new Set();
    entry.kinds.set(kind, ids);
  }
  ids.add(factId);
  if (!resolved) entry.partial = true;
}

function complementaryFactsForRole(
  idx: AnchorIndex,
  key: AnchorKey,
  role: AnchorRole,
  cap: number,
): readonly FactRow[] {
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
    // Literal-side: exact lookup + wildcard scan.
    const exact = exactMap.get(key) ?? [];
    if (wildList.length === 0) return exact;
    const wildMatches: FactRow[] = [];
    outer: for (const entry of wildList) {
      if (entry.regex.test(key)) {
        for (const f of entry.facts) {
          wildMatches.push(f);
          if (wildMatches.length >= cap) break outer;
        }
      }
    }
    return wildMatches.length === 0 ? exact : [...exact, ...wildMatches];
  } else {
    // Wildcard-side: scan exact map's keys via regex.
    const regex = wildcardKeyToRegex(key);
    const out: FactRow[] = [];
    outer: for (const [candidateKey, facts] of exactMap) {
      if (!regex.test(candidateKey)) continue;
      for (const f of facts) {
        out.push(f);
        if (out.length >= cap) break outer;
      }
    }
    return out;
  }
}
