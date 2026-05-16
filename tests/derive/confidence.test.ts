import { describe, it, expect } from 'vitest';
import { BASE_CONFIDENCE, combineConfidence, MATCH_PRECISION, DISTANCE_DECAY, DISTANCE_FLOOR, evidenceConfidence } from '../../src/derive/confidence.js';

describe('confidence', () => {
  it('combines two paths independently: c = 1 - (1-a)(1-b)', () => {
    expect(combineConfidence([0.9, 0.8])).toBeCloseTo(0.98);
  });
  it('combines an empty list to 0', () => {
    expect(combineConfidence([])).toBe(0);
  });
  it('clamps to [0, 1]', () => {
    expect(combineConfidence([1.5])).toBe(1);
    expect(combineConfidence([-0.1, 0.5])).toBeCloseTo(0.5);
  });
  it('has the per-edge-kind base confidences from the spec', () => {
    expect(BASE_CONFIDENCE['symbol-call']).toBe(0.9);
    expect(BASE_CONFIDENCE['php-include']).toBe(0.95);
    expect(BASE_CONFIDENCE['js-import']).toBe(0.95);
    expect(BASE_CONFIDENCE['hook-mediated']).toBe(0.8);
    expect(BASE_CONFIDENCE['hook-mediated-uncertain']).toBe(0.4);
    expect(BASE_CONFIDENCE['rest-mediated']).toBe(0.85);
    expect(BASE_CONFIDENCE['rest-mediated-partial']).toBe(0.5);
    expect(BASE_CONFIDENCE['ajax-mediated']).toBe(0.85);
    expect(BASE_CONFIDENCE['ajax-mediated-partial']).toBe(0.4);
    expect(BASE_CONFIDENCE['enqueue-mediated']).toBe(0.7);
    expect(BASE_CONFIDENCE['admin-page-mediated']).toBe(0.9);
    expect(BASE_CONFIDENCE['shortcode-render']).toBe(0.85);
    expect(BASE_CONFIDENCE['block-render']).toBe(0.7);
    expect(BASE_CONFIDENCE['store-mediated']).toBe(0.8);
  });
});

describe('attenuation constants', () => {
  it('exposes the match-precision tiers', () => {
    expect(MATCH_PRECISION.exact).toBe(1);
    expect(MATCH_PRECISION.wildcardPrefixed).toBe(0.6);
    expect(MATCH_PRECISION.wildcardBroad).toBe(0.25);
  });
  it('exposes the distance decay constants', () => {
    expect(DISTANCE_DECAY).toBe(0.92);
    expect(DISTANCE_FLOOR).toBe(0.3);
  });
});

describe('evidenceConfidence', () => {
  it('exact bridge match at depth 1 attenuates only by distance', () => {
    // rest-mediated 0.85 * exact 1 * 0.92**1
    expect(evidenceConfidence('rest-mediated', 'exact', 1, true)).toBeCloseTo(0.782);
  });
  it('broad-wildcard bridge match attenuates hard', () => {
    // 0.85 * 0.25 * 0.92
    expect(evidenceConfidence('rest-mediated', 'wildcardBroad', 1, true)).toBeCloseTo(0.1955);
  });
  it('prefixed-wildcard bridge match attenuates moderately', () => {
    // 0.85 * 0.6 * 0.92
    expect(evidenceConfidence('rest-mediated', 'wildcardPrefixed', 1, true)).toBeCloseTo(0.4692);
  });
  it('distance decays per hop', () => {
    // hook-mediated 0.8 * 1 * 0.92**3
    expect(evidenceConfidence('hook-mediated', 'exact', 3, true)).toBeCloseTo(0.6229504);
  });
  it('distance never decays below the floor', () => {
    // 0.92**20 < 0.3 -> clamp distance to 0.3 -> 0.8 * 0.3
    expect(evidenceConfidence('hook-mediated', 'exact', 20, true)).toBeCloseTo(0.24);
  });
  it('structural (non-bridge) edges are exempt from distance decay', () => {
    // js-import 0.95, depth 12, isBridge=false -> distance factor 1
    expect(evidenceConfidence('js-import', 'exact', 12, false)).toBeCloseTo(0.95);
  });
  it('clamps the result to [0, 1]', () => {
    expect(evidenceConfidence('js-import', 'exact', 0, false)).toBeLessThanOrEqual(1);
    expect(evidenceConfidence('rest-mediated-partial', 'wildcardBroad', 50, true)).toBeGreaterThanOrEqual(0);
  });
});

describe('attenuated combination', () => {
  it('many low-confidence observations of one edge combine upward (intended)', () => {
    // Ten broad-wildcard rest-mediated paths, each ~0.18.
    const one = evidenceConfidence('rest-mediated', 'wildcardBroad', 2, true);
    const combined = combineConfidence(Array<number>(10).fill(one));
    // 1 - (1-0.18)**10 ~ 0.86 — many weak observations are strong evidence.
    expect(combined).toBeGreaterThan(0.8);
  });
  it('a single broad-wildcard observation stays weak', () => {
    const one = evidenceConfidence('rest-mediated', 'wildcardBroad', 2, true);
    expect(combineConfidence([one])).toBeLessThan(0.25);
  });
});
