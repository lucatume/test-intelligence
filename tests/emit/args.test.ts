import { describe, it, expect } from 'vitest';
import { emitArgs } from '../../src/emit/args.js';
import type { QueryResult } from '../../src/query/types.js';

describe('emitArgs', () => {
  it('emits sorted, deduped source paths for sourcesFromTests', () => {
    const r: QueryResult = {
      rows: [
        { testId: 't1', source: 'src/b.ts', framework: 'jest', frameworkClass: 'unit', confidence: 1, partial: false },
        { testId: 't1', source: 'src/a.ts', framework: 'jest', frameworkClass: 'unit', confidence: 1, partial: false },
        { testId: 't1', source: 'src/a.ts', framework: 'jest', frameworkClass: 'unit', confidence: 1, partial: false },
      ],
      unknownPaths: [],
      unknownTestIds: [],
    };
    expect(emitArgs(r, { mode: 'sources' })).toBe('src/a.ts\nsrc/b.ts\n');
  });

  it('emits sorted, deduped test ids for testsFromSources', () => {
    const r: QueryResult = {
      rows: [
        { testId: 'jest:tests/b.test.ts::x', source: 'src/cart.ts', framework: 'jest', frameworkClass: 'unit', confidence: 1, partial: false },
        { testId: 'jest:tests/a.test.ts::y', source: 'src/cart.ts', framework: 'jest', frameworkClass: 'unit', confidence: 1, partial: false },
      ],
      unknownPaths: [],
      unknownTestIds: [],
    };
    expect(emitArgs(r, { mode: 'tests' })).toBe('jest:tests/a.test.ts::y\njest:tests/b.test.ts::x\n');
  });

  it('returns empty string when result is empty', () => {
    expect(emitArgs({ rows: [], unknownPaths: [], unknownTestIds: [] }, { mode: 'tests' })).toBe('');
  });
});
