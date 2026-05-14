import { describe, it, expect } from 'vitest';
import { parseConfig } from '../../src/config/parse.js';
import { matchesAny } from '../../src/discover/glob.js';

function effectiveIgnore(raw: unknown): readonly string[] {
  const r = parseConfig(raw);
  if (r.kind !== 'ok') throw new Error('cfg parse failed');
  return r.value.ignore;
}

function matchedBy(path: string, raw: unknown): boolean {
  return matchesAny(path, effectiveIgnore(raw));
}

describe('parseConfig — default ignore bundles', () => {
  it('baseline always present (node_modules, .git, dist, build)', () => {
    expect(matchedBy('node_modules', {})).toBe(true);
    expect(matchedBy('packages/a/node_modules', {})).toBe(true);
    expect(matchedBy('.git', {})).toBe(true);
    expect(matchedBy('dist', {})).toBe(true);
    expect(matchedBy('build', {})).toBe(true);
  });

  it('agenticWorktrees default-on: .claude/worktrees, .worktrees, worktrees', () => {
    expect(matchedBy('.claude/worktrees', {})).toBe(true);
    expect(matchedBy('.claude/worktrees/TESTOPS-49', {})).toBe(true);
    expect(matchedBy('.claude/worktrees/TESTOPS-49/src/app.ts', {})).toBe(true);
    expect(matchedBy('.worktrees', {})).toBe(true);
    expect(matchedBy('.worktrees/feature-x/src/file.ts', {})).toBe(true);
    expect(matchedBy('worktrees', {})).toBe(true);
    expect(matchedBy('packages/pkg/.claude/worktrees', {})).toBe(true);
  });

  it('toolDirs default-on: yarn berry, bun, pnpm store, pnp loader', () => {
    expect(matchedBy('.yarn/cache', {})).toBe(true);
    expect(matchedBy('.yarn/cache/some.zip', {})).toBe(true);
    expect(matchedBy('.yarn/releases', {})).toBe(true);
    expect(matchedBy('.yarn/releases/yarn-4.0.2.cjs', {})).toBe(true);
    expect(matchedBy('.yarn/unplugged', {})).toBe(true);
    expect(matchedBy('.yarn/sdks', {})).toBe(true);
    expect(matchedBy('.yarn/install-state.gz', {})).toBe(true);
    expect(matchedBy('.yarn/build-state.yml', {})).toBe(true);
    expect(matchedBy('.pnp.cjs', {})).toBe(true);
    expect(matchedBy('.pnp.loader.mjs', {})).toBe(true);
    expect(matchedBy('.bun', {})).toBe(true);
    expect(matchedBy('.bun/install/cache/foo', {})).toBe(true);
    expect(matchedBy('.pnpm-store', {})).toBe(true);
  });

  it('testArtifacts default-on: playwright, cypress, coverage', () => {
    expect(matchedBy('playwright-report', {})).toBe(true);
    expect(matchedBy('playwright-report/index.html', {})).toBe(true);
    expect(matchedBy('test-results', {})).toBe(true);
    expect(matchedBy('test-results/some-test/trace.zip', {})).toBe(true);
    expect(matchedBy('blob-report', {})).toBe(true);
    expect(matchedBy('playwright/.cache', {})).toBe(true);
    expect(matchedBy('cypress/videos', {})).toBe(true);
    expect(matchedBy('cypress/videos/login.mp4', {})).toBe(true);
    expect(matchedBy('cypress/screenshots', {})).toBe(true);
    expect(matchedBy('cypress/downloads', {})).toBe(true);
    expect(matchedBy('coverage', {})).toBe(true);
    expect(matchedBy('.nyc_output', {})).toBe(true);
    expect(matchedBy('packages/a/coverage', {})).toBe(true);
  });

  it('buildCaches default-on: framework build/cache dirs', () => {
    expect(matchedBy('.next', {})).toBe(true);
    expect(matchedBy('.nuxt', {})).toBe(true);
    expect(matchedBy('.svelte-kit', {})).toBe(true);
    expect(matchedBy('.turbo', {})).toBe(true);
    expect(matchedBy('.parcel-cache', {})).toBe(true);
    expect(matchedBy('.vercel', {})).toBe(true);
    expect(matchedBy('.netlify', {})).toBe(true);
    expect(matchedBy('.cache', {})).toBe(true);
    expect(matchedBy('.angular', {})).toBe(true);
  });

  it('minified default-on: *.min.{js,mjs,cjs,jsx,ts,tsx,css}', () => {
    expect(matchedBy('public/app.min.js', {})).toBe(true);
    expect(matchedBy('public/app.min.mjs', {})).toBe(true);
    expect(matchedBy('public/app.min.cjs', {})).toBe(true);
    expect(matchedBy('src/a.min.jsx', {})).toBe(true);
    expect(matchedBy('src/a.min.ts', {})).toBe(true);
    expect(matchedBy('src/a.min.tsx', {})).toBe(true);
    expect(matchedBy('public/style.min.css', {})).toBe(true);
    // sanity: non-minified files NOT matched by the minified bundle
    expect(matchedBy('src/a.js', {})).toBe(false);
    expect(matchedBy('src/a.ts', {})).toBe(false);
  });

  it('user ignore extends defaults rather than replacing', () => {
    const cfg = { ignore: ['**/my-secret', '**/my-secret/**'] };
    expect(matchedBy('my-secret', cfg)).toBe(true);
    expect(matchedBy('my-secret/file.ts', cfg)).toBe(true);
    // defaults still apply
    expect(matchedBy('node_modules', cfg)).toBe(true);
    expect(matchedBy('.claude/worktrees', cfg)).toBe(true);
    expect(matchedBy('public/app.min.js', cfg)).toBe(true);
  });

  it('ignoreDefaults.minified=false removes the minified bundle but keeps others', () => {
    const cfg = { ignoreDefaults: { minified: false } };
    expect(matchedBy('public/app.min.js', cfg)).toBe(false);
    expect(matchedBy('public/style.min.css', cfg)).toBe(false);
    // other bundles intact
    expect(matchedBy('node_modules', cfg)).toBe(true);
    expect(matchedBy('.claude/worktrees', cfg)).toBe(true);
    expect(matchedBy('.yarn/cache', cfg)).toBe(true);
    expect(matchedBy('playwright-report', cfg)).toBe(true);
  });

  it('per-bundle toggles can disable each group independently', () => {
    const cfg = {
      ignoreDefaults: {
        agenticWorktrees: false,
        toolDirs: false,
        testArtifacts: false,
        buildCaches: false,
        minified: false,
      },
    };
    expect(matchedBy('.claude/worktrees', cfg)).toBe(false);
    expect(matchedBy('.yarn/cache', cfg)).toBe(false);
    expect(matchedBy('playwright-report', cfg)).toBe(false);
    expect(matchedBy('.next', cfg)).toBe(false);
    expect(matchedBy('public/app.min.js', cfg)).toBe(false);
    // baseline still on
    expect(matchedBy('node_modules', cfg)).toBe(true);
    expect(matchedBy('.git', cfg)).toBe(true);
  });

  it('exposes the toggle map on ValidatedConfig.ignoreDefaults', () => {
    const r = parseConfig({ ignoreDefaults: { minified: false } });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.ignoreDefaults).toEqual({
      agenticWorktrees: true,
      toolDirs: true,
      testArtifacts: true,
      buildCaches: true,
      minified: false,
    });
  });

  it('rejects unknown keys under ignoreDefaults', () => {
    const r = parseConfig({ ignoreDefaults: { bogus: true } });
    expect(r.kind).toBe('err');
  });
});
