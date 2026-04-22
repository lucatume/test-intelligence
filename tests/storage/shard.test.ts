import { describe, it, expect } from 'vitest';
import { parseShard } from '../../src/storage/shard.js';

const VALID_SHARD = {
  source: 'src/Cart.php',
  source_hash: 'sha1:abc123',
  tests: [
    {
      id: 'phpunit:tests/CartTest.php::testAdd',
      file: 'tests/CartTest.php',
      framework: 'phpunit',
      filter: 'testAdd',
      confidence: 0.95,
      evidence: [
        { strategy: 'runtime', at: '2026-04-21T10:00:00Z' },
      ],
    },
  ],
  views: [],
};

describe('parseShard — happy path', () => {
  it('accepts a well-formed shard', () => {
    const r = parseShard(VALID_SHARD);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.source).toBe('src/Cart.php');
  });

  it('accepts a shard with empty tests and views arrays', () => {
    const r = parseShard({ source: 'src/x.ts', source_hash: 'sha1:y', tests: [], views: [] });
    expect(r.kind).toBe('ok');
  });
});

describe('parseShard — rejects malformed', () => {
  it('rejects missing source', () => {
    const bad = { ...VALID_SHARD } as Record<string, unknown>;
    delete bad.source;
    expect(parseShard(bad).kind).toBe('err');
  });

  it('rejects confidence outside [0, 1]', () => {
    const bad = structuredClone(VALID_SHARD);
    (bad.tests[0] as unknown as { confidence: number }).confidence = 1.5;
    expect(parseShard(bad).kind).toBe('err');
  });

  it('rejects unknown framework name', () => {
    const bad = structuredClone(VALID_SHARD);
    (bad.tests[0] as unknown as { framework: string }).framework = 'mocha';
    expect(parseShard(bad).kind).toBe('err');
  });

  it('rejects unknown strategy', () => {
    const bad = structuredClone(VALID_SHARD);
    const evidence = (bad.tests[0] as unknown as { evidence: { strategy: string }[] }).evidence;
    (evidence[0] as unknown as { strategy: string }).strategy = 'magic';
    expect(parseShard(bad).kind).toBe('err');
  });

  it('rejects malformed ISO date', () => {
    const bad = structuredClone(VALID_SHARD);
    const evidence = (bad.tests[0] as unknown as { evidence: { at: string }[] }).evidence;
    (evidence[0] as unknown as { at: string }).at = 'not-a-date';
    expect(parseShard(bad).kind).toBe('err');
  });
});
