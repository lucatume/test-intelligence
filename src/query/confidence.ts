export type Strategy = 'runtime' | 'static' | 'heuristic';

export type Weights = {
  readonly runtime: number;
  readonly static: number;
  readonly heuristic: number;
};

export function combineConfidence(
  strategies: readonly Strategy[],
  weights: Weights,
): number {
  const unique = new Set<Strategy>(strategies);
  let product = 1;
  for (const s of unique) product *= (1 - weights[s]);
  return 1 - product;
}

export type StalenessInput = {
  readonly evidence: readonly Strategy[];
  readonly stale: boolean;
  readonly weights: Weights;
};

export type StalenessOutput = {
  readonly confidence: number;
  readonly stale: boolean;
  readonly kept: readonly Strategy[];
};

// Staleness rule (spec §Staleness):
//   - source_hash match → pass through.
//   - source_hash mismatch → keep runtime evidence with weight halved; drop static/heuristic.
export function applyStaleness(input: StalenessInput): StalenessOutput {
  if (!input.stale) {
    return {
      confidence: combineConfidence(input.evidence, input.weights),
      stale: false,
      kept: [...new Set(input.evidence)],
    };
  }
  const kept: Strategy[] = [];
  const halvedWeights: Weights = {
    runtime: input.weights.runtime / 2,
    static: input.weights.static,
    heuristic: input.weights.heuristic,
  };
  for (const s of new Set(input.evidence)) {
    if (s === 'runtime') kept.push(s);
  }
  return {
    confidence: combineConfidence(kept, halvedWeights),
    stale: true,
    kept,
  };
}
