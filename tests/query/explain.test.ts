import { describe, it, expect } from 'vitest';
import { explain } from '../../src/query/explain.js';
import type { Shard } from '../../src/storage/shard.js';

const WEIGHTS = { runtime: 1.0, static: 0.7, heuristic: 0.3 } as const;

describe('explain', () => {
  const shards: ReadonlyArray<{ shard: Shard; stale: boolean }> = [
    {
      shard: {
        source: 'src/Cart.php',
        source_hash: 'sha1:feed',
        tests: [
          { id: 'phpunit:tests/CartTest.php::testAdd', file: 'tests/CartTest.php',
            framework: 'phpunit', filter: 'testAdd', confidence: 0.9, stale: undefined,
            evidence: [{ strategy: 'runtime', at: '2026-04-23T00:00:00Z' }] },
        ],
        views: [],
      },
      stale: false,
    },
  ];

  it('returns a test-kind result for a known test id', () => {
    const r = explain({
      target: { kind: 'id', framework: 'phpunit', file: 'tests/CartTest.php', filter: 'testAdd', raw: 'phpunit:tests/CartTest.php::testAdd' },
      allShards: shards,
      weights: WEIGHTS,
    });
    expect(r.kind).toBe('test');
    if (r.kind === 'test') {
      expect(r.edge.coveredSources).toEqual(['src/Cart.php']);
      expect(r.edge.strategies).toEqual(['runtime']);
    }
  });

  it('returns a source-kind result for a known source path', () => {
    const r = explain({
      target: { kind: 'source', path: 'src/Cart.php', raw: 'src/Cart.php' },
      allShards: shards,
      weights: WEIGHTS,
    });
    expect(r.kind).toBe('source');
    if (r.kind === 'source') {
      expect(r.source).toBe('src/Cart.php');
      expect(r.tests).toHaveLength(1);
    }
  });

  it('returns unknown for a view-like id (v1 has no view providers)', () => {
    const r = explain({
      target: { kind: 'view-id', raw: 'rest:POST /api/v1/cart/items' },
      allShards: shards,
      weights: WEIGHTS,
    });
    expect(r.kind).toBe('unknown');
  });

  it('returns unknown for a completely unrecognized target', () => {
    const r = explain({
      target: { kind: 'source', path: 'src/nope.ts', raw: 'src/nope.ts' },
      allShards: shards,
      weights: WEIGHTS,
    });
    expect(r.kind).toBe('unknown');
  });
});
