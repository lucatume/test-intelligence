import type { Shard, TestEdge } from '../storage/shard.js';
import type { FrameworkName } from '../types.js';
import { applyStaleness, type Strategy, type Weights } from './confidence.js';
import type { QueryTestEdge, TestsQueryResult, Granularity } from './types.js';

export type ShardWithStaleness = {
  readonly shard: Shard;
  readonly stale: boolean;
};

export type TestsFromSourcesInput = {
  readonly shardsBySource: ReadonlyMap<string, ShardWithStaleness>;
  readonly sources: readonly string[];
  readonly framework: FrameworkName;
  readonly minConfidence: number | undefined;
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

function edgeKey(e: QueryTestEdge): string {
  return `${e.framework}|${e.file}|${e.filter ?? ''}`;
}

export function testsFromSources(input: TestsFromSourcesInput): TestsQueryResult {
  const unknown: string[] = [];
  const byKey = new Map<string, QueryTestEdge>();
  const fileLevelKeys = new Set<string>(); // `${framework}|${file}` for any file-level edge

  for (const src of input.sources) {
    const sws = input.shardsBySource.get(src);
    if (sws === undefined) {
      unknown.push(src);
      continue;
    }
    for (const te of sws.shard.tests) {
      if (te.framework !== input.framework) continue;
      const strategies = strategiesOf(te);
      const staled = applyStaleness({
        evidence: strategies,
        stale: sws.stale,
        weights: input.weights,
      });
      if (staled.kept.length === 0 && strategies.length > 0 && sws.stale) {
        continue;
      }
      if (input.minConfidence !== undefined && staled.confidence < input.minConfidence) {
        continue;
      }
      const granularity: Granularity = te.filter === undefined ? 'file' : 'method';
      const edge: QueryTestEdge = {
        id: te.id,
        file: te.file,
        framework: te.framework,
        filter: te.filter,
        granularity,
        confidence: staled.confidence,
        stale: staled.stale,
        strategies: staled.kept,
      };
      if (granularity === 'file') {
        fileLevelKeys.add(`${edge.framework}|${edge.file}`);
      }
      const key = edgeKey(edge);
      const prior = byKey.get(key);
      if (prior === undefined || edge.confidence > prior.confidence) {
        byKey.set(key, edge);
      }
    }
  }

  // Coarser-granularity collapse: drop any method-level edge whose file has a
  // file-level edge for the same framework (running the whole file is a superset).
  const collapsed: QueryTestEdge[] = [];
  for (const edge of byKey.values()) {
    if (edge.granularity === 'method' && fileLevelKeys.has(`${edge.framework}|${edge.file}`)) {
      continue;
    }
    collapsed.push(edge);
  }

  collapsed.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    const af = a.filter ?? '';
    const bf = b.filter ?? '';
    if (af !== bf) return af < bf ? -1 : 1;
    return 0;
  });

  return {
    framework: input.framework,
    tests: collapsed,
    unknownInputs: unknown,
  };
}
