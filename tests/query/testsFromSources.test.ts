import { describe, it, expect } from 'vitest';
import { testsFromSources } from '../../src/query/testsFromSources.js';
import type { Shard } from '../../src/storage/shard.js';

const WEIGHTS = { runtime: 1.0, static: 0.7, heuristic: 0.3 } as const;

function shard(partial: Partial<Shard> & { source: string }): Shard {
  return {
    source: partial.source,
    source_hash: partial.source_hash ?? 'sha1:feed',
    tests: partial.tests ?? [],
    views: partial.views ?? [],
  };
}

describe('testsFromSources — basic', () => {
  it('returns tests matching the requested framework only', () => {
    const s = shard({
      source: 'src/x.ts',
      tests: [
        { id: 'jest:tests/a.test.ts::A', file: 'tests/a.test.ts', framework: 'jest',
          filter: 'A', confidence: 0.9, evidence: [{ strategy: 'runtime', at: '2026-04-23T00:00:00Z' }], stale: undefined },
        { id: 'phpunit:tests/B.php::testB', file: 'tests/B.php', framework: 'phpunit',
          filter: 'testB', confidence: 0.7, evidence: [{ strategy: 'static', at: '2026-04-23T00:00:00Z' }], stale: undefined },
      ],
    });
    const r = testsFromSources({
      shardsBySource: new Map([[s.source, { shard: s, stale: false }]]),
      sources: ['src/x.ts'],
      framework: 'jest',
      minConfidence: undefined,
      weights: WEIGHTS,
    });
    expect(r.tests).toHaveLength(1);
    expect(r.tests[0]?.framework).toBe('jest');
  });

  it('deduplicates identical edges from multiple source inputs', () => {
    const common = {
      id: 'jest:tests/a.test.ts::A', file: 'tests/a.test.ts', framework: 'jest' as const,
      filter: 'A', confidence: 0.9, evidence: [{ strategy: 'runtime' as const, at: '2026-04-23T00:00:00Z' }], stale: undefined,
    };
    const s1 = shard({ source: 'src/a.ts', tests: [common] });
    const s2 = shard({ source: 'src/b.ts', tests: [common] });
    const r = testsFromSources({
      shardsBySource: new Map([['src/a.ts', { shard: s1, stale: false }], ['src/b.ts', { shard: s2, stale: false }]]),
      sources: ['src/a.ts', 'src/b.ts'],
      framework: 'jest',
      minConfidence: undefined,
      weights: WEIGHTS,
    });
    expect(r.tests).toHaveLength(1);
  });

  it('collapses a method-level edge when a file-level edge exists for the same test file', () => {
    const s = shard({
      source: 'src/x.ts',
      tests: [
        { id: 'jest:tests/a.test.ts', file: 'tests/a.test.ts', framework: 'jest',
          filter: undefined, confidence: 0.9, evidence: [{ strategy: 'runtime', at: '2026-04-23T00:00:00Z' }], stale: undefined },
        { id: 'jest:tests/a.test.ts::A', file: 'tests/a.test.ts', framework: 'jest', filter: 'A',
          confidence: 0.9, evidence: [{ strategy: 'runtime', at: '2026-04-23T00:00:00Z' }], stale: undefined },
      ],
    });
    const r = testsFromSources({
      shardsBySource: new Map([['src/x.ts', { shard: s, stale: false }]]),
      sources: ['src/x.ts'],
      framework: 'jest',
      minConfidence: undefined,
      weights: WEIGHTS,
    });
    expect(r.tests).toHaveLength(1);
    expect(r.tests[0]?.granularity).toBe('file');
    expect(r.tests[0]?.filter).toBeUndefined();
  });

  it('filters edges below --min-confidence', () => {
    const s = shard({
      source: 'src/x.ts',
      tests: [
        { id: 'jest:tests/a.test.ts::A', file: 'tests/a.test.ts', framework: 'jest', filter: 'A',
          confidence: 0.3, evidence: [{ strategy: 'heuristic', at: '2026-04-23T00:00:00Z' }], stale: undefined },
        { id: 'jest:tests/b.test.ts::B', file: 'tests/b.test.ts', framework: 'jest', filter: 'B',
          confidence: 0.9, evidence: [{ strategy: 'runtime', at: '2026-04-23T00:00:00Z' }], stale: undefined },
      ],
    });
    const r = testsFromSources({
      shardsBySource: new Map([['src/x.ts', { shard: s, stale: false }]]),
      sources: ['src/x.ts'],
      framework: 'jest',
      minConfidence: 0.5,
      weights: WEIGHTS,
    });
    expect(r.tests.map((t) => t.filter)).toEqual(['B']);
  });

  it('reports unknown input sources without failing', () => {
    const r = testsFromSources({
      shardsBySource: new Map(),
      sources: ['src/missing.ts'],
      framework: 'jest',
      minConfidence: undefined,
      weights: WEIGHTS,
    });
    expect(r.tests).toEqual([]);
    expect(r.unknownInputs).toEqual(['src/missing.ts']);
  });

  it('applies staleness: runtime halves, static/heuristic drop', () => {
    const s = shard({
      source: 'src/x.ts',
      tests: [
        { id: 'jest:tests/a.test.ts::A', file: 'tests/a.test.ts', framework: 'jest', filter: 'A',
          confidence: 1.0,
          evidence: [
            { strategy: 'runtime', at: '2026-04-23T00:00:00Z' },
            { strategy: 'static',  at: '2026-04-23T00:00:00Z' },
          ], stale: undefined },
      ],
    });
    const r = testsFromSources({
      shardsBySource: new Map([['src/x.ts', { shard: s, stale: true }]]),
      sources: ['src/x.ts'],
      framework: 'jest',
      minConfidence: undefined,
      weights: WEIGHTS,
    });
    expect(r.tests).toHaveLength(1);
    expect(r.tests[0]?.stale).toBe(true);
    expect(r.tests[0]?.confidence).toBeCloseTo(0.5);
  });

  it('edges are ordered deterministically by (file, filter)', () => {
    const s = shard({
      source: 'src/x.ts',
      tests: [
        { id: 'jest:tests/b.test.ts::B', file: 'tests/b.test.ts', framework: 'jest', filter: 'B',
          confidence: 0.9, evidence: [{ strategy: 'runtime', at: '2026-04-23T00:00:00Z' }], stale: undefined },
        { id: 'jest:tests/a.test.ts::Z', file: 'tests/a.test.ts', framework: 'jest', filter: 'Z',
          confidence: 0.9, evidence: [{ strategy: 'runtime', at: '2026-04-23T00:00:00Z' }], stale: undefined },
        { id: 'jest:tests/a.test.ts::A', file: 'tests/a.test.ts', framework: 'jest', filter: 'A',
          confidence: 0.9, evidence: [{ strategy: 'runtime', at: '2026-04-23T00:00:00Z' }], stale: undefined },
      ],
    });
    const r = testsFromSources({
      shardsBySource: new Map([['src/x.ts', { shard: s, stale: false }]]),
      sources: ['src/x.ts'],
      framework: 'jest',
      minConfidence: undefined,
      weights: WEIGHTS,
    });
    expect(r.tests.map((t) => `${t.file}::${String(t.filter)}`)).toEqual([
      'tests/a.test.ts::A', 'tests/a.test.ts::Z', 'tests/b.test.ts::B',
    ]);
  });
});
