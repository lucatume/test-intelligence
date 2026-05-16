import type { AnchorKey, FactKind } from '../types.js';
import type { AnchorRole } from '../facts/types.js';
import type { Edge, EdgeKind, FactRow, Graph } from './types.js';
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

interface EvidenceAgg {
  // kind -> contributing fact ids + the attenuated confidence of each
  // contributing path. combineConfidence consumes `values` directly.
  readonly kinds: Map<EdgeKind, { ids: Set<number>; values: number[] }>;
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

    // Record an edge if this fact lives in a non-test, non-vendor file AND
    // we reached it via some traversal kind (not the seed depth-0 facts).
    if (
      file &&
      file.id !== testFact.fileId &&
      !file.vendor &&
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
    enqueueDownstream(graph, index, cur.fact, cur.depth, queue, enqueued, options, frameworkClass, evidence, testFact.fileId);
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

function enqueueDownstream(
  graph: Graph,
  index: AnchorIndex,
  fact: FactRow,
  depth: number,
  queue: QueueItem[],
  enqueued: Set<number>,
  options: TraversalOptions,
  frameworkClass: 'unit' | 'e2e',
  evidence: Map<number, EvidenceAgg>,
  testFileId: number,
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
    const target = (fact.payload as { target?: unknown }).target;
    if (typeof target === 'string') {
      const file = index.filesByPath.get(target);
      if (file) {
        const kind: EdgeKind = 'php-include';
        for (const f of graph.factsByFile.get(file.id) ?? []) {
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
      const kind: EdgeKind = 'enqueue-mediated';
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
  const bridgeKind = bridgeKindFor(fact.kind, fact.resolved, frameworkClass, fact.payload, options.hookStopList);
  if (bridgeKind === null) return;

  const links = index.linksByFact.get(fact.id) ?? [];
  for (const link of links) {
    for (const partner of complementaryFactsForRole(index, link.anchorKey, link.role, options.maxWildcardMatchesPerAnchor)) {
      const partnerDepth = depth + 1;
      // Attenuate: precision tier from the match, distance from BFS depth.
      const c = evidenceConfidence(bridgeKind, partner.precision, partnerDepth, true);
      // Record bridge evidence for the partner's file even when the partner is
      // already enqueued via another path. Without this, evidence kinds emitted
      // via the bridge (hook-mediated, shortcode-render, …) are lost whenever a
      // shorter-arrival kind (e.g. php-include) reaches the partner first.
      const partnerFile = graph.files.get(partner.fact.fileId);
      if (partnerFile && partnerFile.id !== testFileId && !partnerFile.vendor) {
        recordEvidence(evidence, partnerFile.id, bridgeKind, fact.id, partner.fact.id, c);
      }
      // Expose the partner file's enqueue-script siblings (program Phase 3):
      // WP enqueues sit inside hook callbacks, so a PHP file reached via a hook
      // bridge must surface its wp_enqueue_script facts for the enqueue→JS
      // bridge to fire. Scoped to enqueue-script ONLY — surfacing every sibling
      // fact would turn each hook hop into a full-file expansion and blow up
      // the BFS on WP-core-dense graphs. Siblings carry arrivalKind=null: they
      // propagate but record no edge of their own.
      enqueueEnqueueSiblings(graph, partner.fact, partnerDepth, queue, enqueued);
      if (enqueued.has(partner.fact.id)) continue;
      enqueued.add(partner.fact.id);
      queue.push({
        fact: partner.fact,
        depth: partnerDepth,
        arrivalKind: bridgeKind,
        arrivalFactId: fact.id,
        arrivalPrecision: partner.precision,
        arrivalIsBridge: true,
      });
    }
  }
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
    });
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
    case 'shortcode':
      return 'shortcode-render';
    case 'block-render':
      if (frameworkClass !== 'e2e') return null;
      return 'block-render';
    default:
      return null;
  }
}

function evidenceSlot(
  store: Map<number, EvidenceAgg>,
  fileId: number,
  kind: EdgeKind,
): { ids: Set<number>; values: number[] } {
  let entry = store.get(fileId);
  if (!entry) {
    entry = { kinds: new Map() };
    store.set(fileId, entry);
  }
  let slot = entry.kinds.get(kind);
  if (!slot) {
    slot = { ids: new Set(), values: [] };
    entry.kinds.set(kind, slot);
  }
  return slot;
}

/**
 * Record one bridge/structural arrival as evidence: the two endpoint fact ids
 * (arriving fact + destination fact) go into the provenance set, and the
 * attenuated confidence of the path is pushed ONCE — one arrival is one
 * independent observation, not two. Re-recording the same arriving fact does
 * not re-push the value: the same path arriving again is the same observation.
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
  const fresh = !slot.ids.has(arrivalFactId);
  slot.ids.add(arrivalFactId);
  slot.ids.add(destFactId);
  if (fresh) slot.values.push(confidence);
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
    for (const f of exactMap.get(key) ?? []) {
      out.push({ fact: f, precision: 'exact' });
    }
    if (wildList.length > 0) {
      let wildCount = 0;
      outer: for (const entry of wildList) {
        if (entry.regex.test(key)) {
          for (const f of entry.facts) {
            out.push({ fact: f, precision: entry.breadth });
            if (++wildCount >= cap) break outer;
          }
        }
      }
    }
    return out;
  } else {
    // Wildcard incoming key: scan the exact map's keys via regex. Precision is
    // this incoming key's own breadth.
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
