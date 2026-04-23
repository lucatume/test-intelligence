import { describe, it, expect } from 'vitest';
import {
  combineConfidence,
  applyStaleness,
} from '../../src/query/confidence.js';

describe('combineConfidence — independent combination', () => {
  const weights = { runtime: 1.0, static: 0.7, heuristic: 0.3 } as const;

  it('runtime alone → 1.0', () => {
    expect(combineConfidence(['runtime'], weights)).toBeCloseTo(1.0);
  });

  it('static alone → 0.7', () => {
    expect(combineConfidence(['static'], weights)).toBeCloseTo(0.7);
  });

  it('heuristic alone → 0.3', () => {
    expect(combineConfidence(['heuristic'], weights)).toBeCloseTo(0.3);
  });

  it('runtime + static ≈ 1.0 (runtime already saturates)', () => {
    expect(combineConfidence(['runtime', 'static'], weights)).toBeCloseTo(1.0);
  });

  it('static + heuristic → 1 - 0.3*0.7 = 0.79', () => {
    expect(combineConfidence(['static', 'heuristic'], weights)).toBeCloseTo(0.79);
  });

  it('empty evidence list → 0', () => {
    expect(combineConfidence([], weights)).toBe(0);
  });

  it('duplicate strategies combine once per distinct strategy', () => {
    expect(combineConfidence(['static', 'static'], weights)).toBeCloseTo(0.7);
  });
});

describe('applyStaleness', () => {
  const weights = { runtime: 1.0, static: 0.7, heuristic: 0.3 } as const;

  it('fresh: evidence passed through unchanged', () => {
    const r = applyStaleness({
      evidence: ['runtime', 'static'],
      stale: false,
      weights,
    });
    expect(r.confidence).toBeCloseTo(1.0);
    expect(r.stale).toBe(false);
    expect(r.kept).toEqual(['runtime', 'static']);
  });

  it('stale: runtime confidence halved, static/heuristic dropped', () => {
    const r = applyStaleness({
      evidence: ['runtime', 'static', 'heuristic'],
      stale: true,
      weights,
    });
    expect(r.confidence).toBeCloseTo(0.5);
    expect(r.stale).toBe(true);
    expect(r.kept).toEqual(['runtime']);
  });

  it('stale with no runtime evidence: confidence 0, all dropped', () => {
    const r = applyStaleness({
      evidence: ['static', 'heuristic'],
      stale: true,
      weights,
    });
    expect(r.confidence).toBe(0);
    expect(r.kept).toEqual([]);
  });
});
