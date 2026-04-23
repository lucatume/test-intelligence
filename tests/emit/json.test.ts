import { describe, it, expect } from 'vitest';
import {
  formatTestsJson,
  formatSourcesJson,
  formatSourcesArgs,
  formatExplainJson,
} from '../../src/emit/json.js';

describe('formatTestsJson', () => {
  it('emits a stable JSON shape with tests[] and unknownInputs[]', () => {
    const s = formatTestsJson({
      framework: 'jest',
      tests: [
        { id: 'jest:tests/a.test.ts::A', file: 'tests/a.test.ts', framework: 'jest',
          filter: 'A', granularity: 'method', confidence: 0.9, stale: false, strategies: ['runtime'] },
      ],
      unknownInputs: ['src/missing.ts'],
    });
    const parsed = JSON.parse(s) as Record<string, unknown>;
    expect(parsed.framework).toBe('jest');
    expect(Array.isArray(parsed.tests)).toBe(true);
    expect(parsed.unknownInputs).toEqual(['src/missing.ts']);
    const [t] = parsed.tests as Array<Record<string, unknown>>;
    expect(t?.id).toBe('jest:tests/a.test.ts::A');
    expect(t?.confidence).toBeCloseTo(0.9);
    expect(t?.strategies).toEqual(['runtime']);
    expect(t?.stale).toBe(false);
  });
});

describe('formatSourcesJson', () => {
  it('emits sources[] + unknownInputs[]', () => {
    const s = formatSourcesJson({
      sources: ['src/Cart.php', 'src/cart.ts'],
      unknownInputs: [],
    });
    const parsed = JSON.parse(s) as Record<string, unknown>;
    expect(parsed.sources).toEqual(['src/Cart.php', 'src/cart.ts']);
  });
});

describe('formatSourcesArgs', () => {
  it('emits one source per line', () => {
    const s = formatSourcesArgs({
      sources: ['src/A.php', 'src/b.ts'],
      unknownInputs: [],
    });
    expect(s).toBe('src/A.php\nsrc/b.ts');
  });

  it('empty sources → empty string', () => {
    expect(formatSourcesArgs({ sources: [], unknownInputs: [] })).toBe('');
  });
});

describe('formatExplainJson', () => {
  it('test-kind includes the evidence trail', () => {
    const s = formatExplainJson({
      kind: 'test',
      edge: {
        id: 'jest:tests/a.test.ts::A', file: 'tests/a.test.ts', framework: 'jest',
        filter: 'A', confidence: 0.9, stale: false, strategies: ['runtime'],
        coveredSources: ['src/x.ts'],
      },
    });
    const parsed = JSON.parse(s) as Record<string, unknown>;
    expect(parsed.kind).toBe('test');
  });

  it('unknown-kind returns { kind: "unknown", target }', () => {
    const parsed = JSON.parse(formatExplainJson({ kind: 'unknown', target: 'rest:POST /x' })) as Record<string, unknown>;
    expect(parsed.kind).toBe('unknown');
    expect(parsed.target).toBe('rest:POST /x');
  });
});
