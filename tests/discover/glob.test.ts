import { describe, it, expect } from 'vitest';
import { compileGlob, matchesAny } from '../../src/discover/glob.js';

describe('compileGlob', () => {
  it.each([
    ['node_modules/**', 'node_modules/foo/index.js', true],
    ['node_modules/**', 'src/node_modules/foo.js', false],
    ['**/*.test.ts', 'tests/cart.test.ts', true],
    ['**/*.test.ts', 'tests/a/b/cart.test.ts', true],
    ['**/*.test.ts', 'tests/cart.ts', false],
    ['**/*.{test,spec}.{ts,tsx,js,jsx}', 'src/a.spec.tsx', true],
    ['**/*.{test,spec}.{ts,tsx,js,jsx}', 'src/a.test.js', true],
    ['**/*.{test,spec}.{ts,tsx,js,jsx}', 'src/a.ts', false],
    ['dist/**', 'dist/cli.js', true],
    ['dist/**', 'dist', false],
    ['vendor/**', 'vendor/foo/bar.php', true],
    ['build', 'build', true],
    ['build', 'build/x', false],
    ['src/?.ts', 'src/a.ts', true],
    ['src/?.ts', 'src/ab.ts', false],
    ['src/[ab].ts', 'src/a.ts', true],
    ['src/[ab].ts', 'src/c.ts', false],
  ] as const)('compileGlob(%s).test(%s) === %s', (pattern, path, want) => {
    const re = compileGlob(pattern);
    expect(re.test(path)).toBe(want);
  });

  it('matchesAny short-circuits', () => {
    expect(matchesAny('node_modules/foo', ['dist/**', 'node_modules/**'])).toBe(true);
    expect(matchesAny('src/a.ts', ['dist/**', 'node_modules/**'])).toBe(false);
  });
});
