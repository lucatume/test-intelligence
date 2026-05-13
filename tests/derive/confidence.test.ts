import { describe, it, expect } from 'vitest';
import { BASE_CONFIDENCE, combineConfidence } from '../../src/derive/confidence.js';

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
    expect(BASE_CONFIDENCE['shortcode-render']).toBe(0.85);
    expect(BASE_CONFIDENCE['block-render']).toBe(0.7);
  });
});
