import type { FrameworkName } from '../types.js';
import type { Shard, TestEdge } from '../storage/shard.js';
import { applyStaleness, type Strategy, type Weights } from './confidence.js';
import type { SourcesQueryResult } from './types.js';

export type TestInput =
  | { readonly kind: 'id'; readonly framework: FrameworkName; readonly file: string; readonly filter: string | undefined; readonly raw: string }
  | { readonly kind: 'file'; readonly file: string; readonly raw: string };

export type SourcesFromTestsInput = {
  readonly allShards: ReadonlyArray<{ readonly shard: Shard; readonly stale: boolean }>;
  readonly inputs: readonly TestInput[];
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

function edgeMatches(te: TestEdge, input: TestInput): boolean {
  if (input.kind === 'file') return te.file === input.file;
  if (te.framework !== input.framework) return false;
  if (te.file !== input.file) return false;
  if (input.filter === undefined) return true;       // file-scope id: any edge in this file matches
  if (te.filter === undefined) return true;          // file-level edge covers any method-level input
  return te.filter === input.filter;
}

function edgeConfidence(
  te: TestEdge,
  stale: boolean,
  weights: Weights,
): { confidence: number; kept: number } {
  const result = applyStaleness({ evidence: strategiesOf(te), stale, weights });
  return { confidence: result.confidence, kept: result.kept.length };
}

export function sourcesFromTests(input: SourcesFromTestsInput): SourcesQueryResult {
  const sourcesSet = new Set<string>();
  const matchedPerInput: boolean[] = input.inputs.map(() => false);

  for (const sws of input.allShards) {
    for (const te of sws.shard.tests) {
      for (const [i, ti] of input.inputs.entries()) {
        if (!edgeMatches(te, ti)) continue;
        const c = edgeConfidence(te, sws.stale, input.weights);
        if (c.kept === 0 && sws.stale) continue;
        if (input.minConfidence !== undefined && c.confidence < input.minConfidence) continue;
        sourcesSet.add(sws.shard.source);
        matchedPerInput[i] = true;
      }
    }
  }

  const unknownInputs: string[] = [];
  for (const [i, ti] of input.inputs.entries()) {
    if (!matchedPerInput[i]) unknownInputs.push(ti.raw);
  }

  return {
    sources: [...sourcesSet].sort(),
    unknownInputs,
  };
}
