import { describe, it, expect } from 'vitest';
import { emitJson } from '../../src/emit/json.js';
import type { QueryResult } from '../../src/query/types.js';

describe('emitJson', () => {
  it('emits structured JSON with edges + unknown lists', () => {
    const r: QueryResult = {
      rows: [
        { testId: 't1', source: 'src/a.ts', framework: 'jest', frameworkClass: 'unit', confidence: 0.9, partial: false },
      ],
      unknownPaths: ['src/missing.ts'],
      unknownTestIds: [],
    };
    const parsed = JSON.parse(emitJson(r)) as {
      edges: { testId: string; source: string; confidence: number; partial: boolean }[];
      unknownPaths: string[];
      unknownTestIds: string[];
    };
    expect(parsed.edges).toHaveLength(1);
    expect(parsed.edges[0]?.confidence).toBe(0.9);
    expect(parsed.unknownPaths).toEqual(['src/missing.ts']);
  });
});
