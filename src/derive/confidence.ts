import type { EdgeKind } from './types.js';

export const BASE_CONFIDENCE: Readonly<Record<EdgeKind, number>> = {
  'symbol-call': 0.9,
  'symbol-call-uncertain': 0.5,
  'php-include': 0.95,
  'js-import': 0.95,
  'hook-mediated': 0.8,
  'hook-mediated-uncertain': 0.4,
  'rest-mediated': 0.85,
  'rest-mediated-partial': 0.5,
  'ajax-mediated': 0.85,
  'ajax-mediated-partial': 0.4,
  'enqueue-mediated': 0.7,
  'shortcode-render': 0.85,
  'block-render': 0.7,
};

export function combineConfidence(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let prod = 1;
  for (const raw of values) {
    const c = Math.max(0, Math.min(1, raw));
    prod *= 1 - c;
  }
  return 1 - prod;
}

// --- Phase 1: bridge confidence tiering ---------------------------------

/**
 * Match-precision attenuation tiers. Multiplied into a bridge edge's
 * BASE_CONFIDENCE before combination. `exact` is the no-op identity tier and is
 * also used for every structural (non-bridge) edge.
 */
export interface MatchPrecision {
  /** Exact anchor-key lookup hit, or any non-bridge edge. */
  readonly exact: 1;
  /** Wildcard anchor carrying at least one literal segment, e.g.
   *  `rest:GET /wp/v2/comments/{*}` or `hook:wp_ajax_{*}`. */
  readonly wildcardPrefixed: number;
  /** Wildcard anchor with no literal segment beyond the type tag, e.g.
   *  `rest:GET /{*}/{*}` — matches everything. Hardest penalty. */
  readonly wildcardBroad: number;
}

export const MATCH_PRECISION: MatchPrecision = {
  exact: 1,
  wildcardPrefixed: 0.6,
  wildcardBroad: 0.25,
};

/** Per-hop decay applied to bridge arrival kinds. */
export const DISTANCE_DECAY = 0.92;
/** Lower bound for the distance factor — a bridge never decays below this. */
export const DISTANCE_FLOOR = 0.3;

/**
 * Attenuated base confidence for one piece of evidence.
 *
 * @param kind      the EdgeKind — selects BASE_CONFIDENCE.
 * @param precision match-precision tier; `exact` for structural / exact matches.
 * @param depth     BFS depth at which the partner fact was reached.
 * @param isBridge  distance decay applies to bridge kinds only. Structural
 *                  kinds (js-import, php-include, symbol-call*) pass `false`
 *                  and keep full BASE_CONFIDENCE regardless of depth — a deep
 *                  import chain is still a real dependency.
 */
export function evidenceConfidence(
  kind: EdgeKind,
  precision: keyof MatchPrecision,
  depth: number,
  isBridge: boolean,
): number {
  const base = BASE_CONFIDENCE[kind];
  const p = MATCH_PRECISION[precision];
  const distance = isBridge
    ? Math.max(DISTANCE_FLOOR, DISTANCE_DECAY ** depth)
    : 1;
  const c = base * p * distance;
  return Math.max(0, Math.min(1, c));
}
