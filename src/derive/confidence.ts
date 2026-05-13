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
