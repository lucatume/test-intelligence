import { describe, it, expect } from 'vitest';
import { sourcesFromTests } from '../../src/query/sourcesFromTests.js';
import type { Shard } from '../../src/storage/shard.js';

const WEIGHTS = { runtime: 1.0, static: 0.7, heuristic: 0.3 } as const;

function shard(source: string, tests: Shard['tests']): Shard {
  return { source, source_hash: 'sha1:feed', tests, views: [] };
}

describe('sourcesFromTests', () => {
  const s1 = shard('src/Cart.php', [
    { id: 'phpunit:tests/CartTest.php::testAdd', file: 'tests/CartTest.php',
      framework: 'phpunit', filter: 'testAdd', confidence: 0.9, stale: undefined,
      evidence: [{ strategy: 'runtime', at: '2026-04-23T00:00:00Z' }] },
  ]);
  const s2 = shard('src/cart.ts', [
    { id: 'jest:tests/cart.test.ts::adds', file: 'tests/cart.test.ts',
      framework: 'jest', filter: 'adds', confidence: 0.9, stale: undefined,
      evidence: [{ strategy: 'runtime', at: '2026-04-23T00:00:00Z' }] },
  ]);
  const allShards: ReadonlyArray<{ shard: Shard; stale: boolean }> = [
    { shard: s1, stale: false },
    { shard: s2, stale: false },
  ];

  it('resolves an exact test-id input to the source(s) covering it', () => {
    const r = sourcesFromTests({
      allShards,
      inputs: [{ kind: 'id', framework: 'phpunit', file: 'tests/CartTest.php', filter: 'testAdd', raw: 'phpunit:tests/CartTest.php::testAdd' }],
      minConfidence: undefined,
      weights: WEIGHTS,
    });
    expect(r.sources).toEqual(['src/Cart.php']);
  });

  it('resolves a test-file input to every source whose shard lists a test in that file (any framework)', () => {
    const r = sourcesFromTests({
      allShards,
      inputs: [{ kind: 'file', file: 'tests/cart.test.ts', raw: 'tests/cart.test.ts' }],
      minConfidence: undefined,
      weights: WEIGHTS,
    });
    expect(r.sources).toEqual(['src/cart.ts']);
  });

  it('deduplicates and sorts alphabetically', () => {
    const sThird = shard('src/A.php', [
      { id: 'phpunit:tests/CartTest.php::testAdd', file: 'tests/CartTest.php',
        framework: 'phpunit', filter: 'testAdd', confidence: 0.9, stale: undefined,
        evidence: [{ strategy: 'runtime', at: '2026-04-23T00:00:00Z' }] },
    ]);
    const r = sourcesFromTests({
      allShards: [...allShards, { shard: sThird, stale: false }],
      inputs: [{ kind: 'id', framework: 'phpunit', file: 'tests/CartTest.php', filter: 'testAdd', raw: 'phpunit:tests/CartTest.php::testAdd' }],
      minConfidence: undefined,
      weights: WEIGHTS,
    });
    expect(r.sources).toEqual(['src/A.php', 'src/Cart.php']);
  });

  it('reports unknown inputs without failing', () => {
    const r = sourcesFromTests({
      allShards,
      inputs: [{ kind: 'file', file: 'tests/nope.ts', raw: 'tests/nope.ts' }],
      minConfidence: undefined,
      weights: WEIGHTS,
    });
    expect(r.sources).toEqual([]);
    expect(r.unknownInputs).toEqual(['tests/nope.ts']);
  });

  it('filters edges below --min-confidence', () => {
    const s = shard('src/low.ts', [
      { id: 'jest:tests/a.test.ts::A', file: 'tests/a.test.ts', framework: 'jest', filter: 'A',
        confidence: 0.3, stale: undefined,
        evidence: [{ strategy: 'heuristic', at: '2026-04-23T00:00:00Z' }] },
    ]);
    const r = sourcesFromTests({
      allShards: [{ shard: s, stale: false }],
      inputs: [{ kind: 'id', framework: 'jest', file: 'tests/a.test.ts', filter: 'A', raw: 'jest:tests/a.test.ts::A' }],
      minConfidence: 0.5,
      weights: WEIGHTS,
    });
    expect(r.sources).toEqual([]);
    expect(r.unknownInputs).toEqual(['jest:tests/a.test.ts::A']);
  });
});
