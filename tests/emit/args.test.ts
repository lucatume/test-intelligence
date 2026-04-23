import { describe, it, expect } from 'vitest';
import { formatArgs } from '../../src/emit/args.js';
import type { TestsQueryResult } from '../../src/query/types.js';

const base = (framework: TestsQueryResult['framework']): TestsQueryResult => ({
  framework,
  tests: [],
  unknownInputs: [],
});

describe('formatArgs — phpunit', () => {
  it('file-level edge emits the file path alone', () => {
    const s = formatArgs({
      ...base('phpunit'),
      tests: [
        { id: 'phpunit:tests/a.php', file: 'tests/a.php', framework: 'phpunit',
          filter: undefined, granularity: 'file', confidence: 0.9, stale: false, strategies: ['runtime'] },
      ],
    });
    expect(s).toBe('tests/a.php');
  });

  it('method-level edge emits file + --filter ^<name>$', () => {
    const s = formatArgs({
      ...base('phpunit'),
      tests: [
        { id: 'phpunit:tests/a.php::testAdd', file: 'tests/a.php', framework: 'phpunit',
          filter: 'testAdd', granularity: 'method', confidence: 0.9, stale: false, strategies: ['runtime'] },
      ],
    });
    expect(s).toBe("tests/a.php --filter '^testAdd$'");
  });

  it('multiple edges sorted alphabetically, newline-delimited, deduped', () => {
    const s = formatArgs({
      ...base('phpunit'),
      tests: [
        { id: 'phpunit:tests/b.php::testB', file: 'tests/b.php', framework: 'phpunit',
          filter: 'testB', granularity: 'method', confidence: 0.9, stale: false, strategies: ['runtime'] },
        { id: 'phpunit:tests/a.php::testA', file: 'tests/a.php', framework: 'phpunit',
          filter: 'testA', granularity: 'method', confidence: 0.9, stale: false, strategies: ['runtime'] },
        { id: 'phpunit:tests/a.php::testA', file: 'tests/a.php', framework: 'phpunit',
          filter: 'testA', granularity: 'method', confidence: 0.9, stale: false, strategies: ['runtime'] },
      ],
    });
    expect(s.split('\n')).toEqual([
      "tests/a.php --filter '^testA$'",
      "tests/b.php --filter '^testB$'",
    ]);
  });

  it('empty result emits empty string (empty is a safe fallback per spec)', () => {
    expect(formatArgs({ ...base('phpunit'), tests: [] })).toBe('');
  });
});

describe('formatArgs — jest', () => {
  it('method-level edge emits file + -t pattern', () => {
    const s = formatArgs({
      ...base('jest'),
      tests: [
        { id: 'jest:tests/a.test.ts::A', file: 'tests/a.test.ts', framework: 'jest',
          filter: 'A', granularity: 'method', confidence: 0.9, stale: false, strategies: ['runtime'] },
      ],
    });
    expect(s).toBe("tests/a.test.ts -t 'A'");
  });

  it('file-level edge emits file alone', () => {
    const s = formatArgs({
      ...base('jest'),
      tests: [
        { id: 'jest:tests/a.test.ts', file: 'tests/a.test.ts', framework: 'jest',
          filter: undefined, granularity: 'file', confidence: 0.9, stale: false, strategies: ['runtime'] },
      ],
    });
    expect(s).toBe('tests/a.test.ts');
  });
});

describe('formatArgs — playwright', () => {
  it('method-level edge emits file + --grep title', () => {
    const s = formatArgs({
      ...base('playwright'),
      tests: [
        { id: 'playwright:tests/e2e.spec.ts::adds to cart', file: 'tests/e2e.spec.ts', framework: 'playwright',
          filter: 'adds to cart', granularity: 'method', confidence: 1.0, stale: false, strategies: ['runtime'] },
      ],
    });
    expect(s).toBe("tests/e2e.spec.ts --grep 'adds to cart'");
  });
});

describe('formatArgs — shell-safety', () => {
  it("escapes single-quotes in filter names via ' bash-concat \"'\"'\"' pattern", () => {
    const s = formatArgs({
      ...base('jest'),
      tests: [
        { id: "jest:tests/a.test.ts::it's", file: 'tests/a.test.ts', framework: 'jest',
          filter: "it's", granularity: 'method', confidence: 0.9, stale: false, strategies: ['runtime'] },
      ],
    });
    expect(s).toBe(`tests/a.test.ts -t 'it'"'"'s'`);
  });
});
