import type { FrameworkName } from '../types.js';
import type { Shard, TestEdge } from '../storage/shard.js';
import { applyStaleness, type Strategy, type Weights } from './confidence.js';
import type { ExplainResult, ExplainEdge, QueryTestEdge } from './types.js';

export type ExplainTarget =
  | { readonly kind: 'id'; readonly framework: FrameworkName; readonly file: string; readonly filter: string | undefined; readonly raw: string }
  | { readonly kind: 'source'; readonly path: string; readonly raw: string }
  | { readonly kind: 'view-id'; readonly raw: string };

export type ExplainInput = {
  readonly target: ExplainTarget;
  readonly allShards: ReadonlyArray<{ readonly shard: Shard; readonly stale: boolean }>;
  readonly weights: Weights;
};

function strategiesOf(edge: TestEdge): readonly Strategy[] {
  const out: Strategy[] = [];
  for (const e of edge.evidence) {
    if (e.strategy === 'runtime' || e.strategy === 'static' || e.strategy === 'heuristic') {
      out.push(e.strategy);
    }
  }
  return out;
}

function toQueryTestEdge(te: TestEdge, stale: boolean, weights: Weights): QueryTestEdge {
  const s = applyStaleness({ evidence: strategiesOf(te), stale, weights });
  return {
    id: te.id,
    file: te.file,
    framework: te.framework,
    filter: te.filter,
    granularity: te.filter === undefined ? 'file' : 'method',
    confidence: s.confidence,
    stale: s.stale,
    strategies: s.kept,
  };
}

export function explain(input: ExplainInput): ExplainResult {
  const t = input.target;
  if (t.kind === 'view-id') {
    return { kind: 'unknown', target: t.raw };
  }
  if (t.kind === 'source') {
    for (const sws of input.allShards) {
      if (sws.shard.source !== t.path) continue;
      const tests = sws.shard.tests.map((te) => toQueryTestEdge(te, sws.stale, input.weights));
      tests.sort((a, b) => {
        if (a.file !== b.file) return a.file.localeCompare(b.file);
        return (a.filter ?? '').localeCompare(b.filter ?? '');
      });
      return { kind: 'source', source: sws.shard.source, tests };
    }
    return { kind: 'unknown', target: t.raw };
  }
  // kind === 'id'
  const coveredSources: string[] = [];
  let matched: TestEdge | null = null;
  let matchedStale = false;
  for (const sws of input.allShards) {
    for (const te of sws.shard.tests) {
      if (te.framework !== t.framework) continue;
      if (te.file !== t.file) continue;
      if (t.filter !== undefined && te.filter !== t.filter) continue;
      if (t.filter === undefined && te.filter !== undefined) continue;
      coveredSources.push(sws.shard.source);
      if (matched === null) {
        matched = te;
        matchedStale = sws.stale;
      }
    }
  }
  if (matched === null) return { kind: 'unknown', target: t.raw };
  const q = toQueryTestEdge(matched, matchedStale, input.weights);
  const edge: ExplainEdge = {
    id: q.id,
    file: q.file,
    framework: q.framework,
    filter: q.filter,
    confidence: q.confidence,
    stale: q.stale,
    strategies: q.strategies,
    coveredSources: [...new Set(coveredSources)].sort(),
  };
  return { kind: 'test', edge };
}
