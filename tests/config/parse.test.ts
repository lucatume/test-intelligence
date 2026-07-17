import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/parse.js';

describe('parseConfig — empty object', () => {
  it('produces a fully-defaulted ValidatedConfig', () => {
    const r = parseConfig({});
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const c = r.value;
    expect(c.tests.defaultClass).toBe('unit');
    expect(c.tests.classes).toEqual([]);
    expect(c.tests.phpunit.baseClasses).toEqual(['PHPUnit\\Framework\\TestCase']);
    expect(c.tests.phpunit.methodPatterns).toEqual(['test*', '@test', '#[Test]']);
    expect(c.tests.jest.fileGlobs).toEqual([
      '**/*.test.{ts,tsx,js,jsx}',
      '**/*.spec.{ts,tsx,js,jsx}',
    ]);
    expect(c.tests.qunit.fileGlobs).toEqual([]);
    expect(c.hooks.stopList.add).toEqual([]);
    expect(c.hooks.stopList.remove).toEqual([]);
    expect(c.extractors).toEqual([]);
    expect(c.confidence.threshold).toBe(0.0);
    expect(c.traversal.maxDepth).toBe(100);
    expect(c.traversal.maxMillisPerTest).toBe(5000);
    expect(c.traversal.maxWildcardMatchesPerAnchor).toBe(32);
    expect(c.concurrency.phpWorkers).toBeUndefined();
    // The default ignore list now ships several bundles (worktrees, tool dirs,
    // test artifacts, build caches, minified). The full enumeration lives in
    // tests/config/parse-ignore.test.ts; here we only pin the always-on
    // baseline so future bundle changes don't churn this test.
    expect(c.ignore).toEqual(
      expect.arrayContaining([
        '**/node_modules',
        '**/node_modules/**',
        '**/dist',
        '**/dist/**',
        '**/build',
        '**/build/**',
        '**/.git',
        '**/.git/**',
      ]),
    );
    expect(c.ignoreDefaults).toEqual({
      agenticWorktrees: true,
      toolDirs: true,
      testArtifacts: true,
      buildCaches: true,
      minified: true,
    });
    expect(c.vendor).toEqual(['**/vendor', '**/vendor/**']);
    expect(c.allowSymlinkTargets).toEqual([]);
  });
});

describe('parseConfig — build.outputDirs', () => {
  it('defaults build.outputDirs to ["build","dist"] when absent', () => {
    const r = parseConfig({});
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.build.outputDirs).toEqual(['build', 'dist']);
  });

  it('accepts a user-supplied build.outputDirs', () => {
    const r = parseConfig({ build: { outputDirs: ['out'] } });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.build.outputDirs).toEqual(['out']);
  });
});

describe('parseConfig — wpPatternWrappers', () => {
  it('parses a valid wpPatternWrappers entry', () => {
    const input = {
      wpPatternWrappers: [
        {
          name: 'register_my_route',
          wraps: 'register_rest_route',
          argSpecs: [
            { kind: 'fixed', value: 'my-plugin/v1' },
            { kind: 'param', wrapperParamIdx: 0 },
            { kind: 'merge', defaults: { methods: 'POST' }, callerParamIdx: 1 },
          ],
        },
      ],
    };
    const result = parseConfig(input);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.wpPatternWrappers).toHaveLength(1);
    expect(result.value.wpPatternWrappers[0]?.argSpecs).toHaveLength(3);
  });

  it('rejects an argSpec with unknown kind', () => {
    const input = {
      wpPatternWrappers: [
        { name: 'x', wraps: 'register_rest_route', argSpecs: [{ kind: 'nope' }] },
      ],
    };
    const result = parseConfig(input);
    expect(result.kind).toBe('err');
  });

  it('rejects wraps not in WP_PHP_PATTERNS', () => {
    const input = {
      wpPatternWrappers: [
        { name: 'x', wraps: 'register_made_up_function', argSpecs: [] },
      ],
    };
    const result = parseConfig(input);
    expect(result.kind).toBe('err');
  });

  it('treats missing wpPatternWrappers as an empty list', () => {
    const result = parseConfig({});
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.wpPatternWrappers).toHaveLength(0);
  });
});

describe('parseConfig — overrides', () => {
  it('honours QUnit file globs', () => {
    const r = parseConfig({ tests: { qunit: { fileGlobs: ['tests/qunit/**/*.js'] } } });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.tests.qunit.fileGlobs).toEqual(['tests/qunit/**/*.js']);
  });

  it('honours tests.classes path globs', () => {
    const r = parseConfig({
      tests: {
        classes: [{ paths: ['tests/E2E/**'], class: 'e2e' }],
        defaultClass: 'unit',
      },
    });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.tests.classes).toEqual([{ paths: ['tests/E2E/**'], class: 'e2e' }]);
  });

  it('honours hooks.stopList add/remove', () => {
    const r = parseConfig({
      hooks: { stopList: { add: ['custom'], remove: ['template_redirect'] } },
    });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.hooks.stopList.add).toEqual(['custom']);
    expect(r.value.hooks.stopList.remove).toEqual(['template_redirect']);
  });

  it('strictly parses declarative extractors', () => {
    const pattern = {
      match: { lang: 'php', nodeKind: 'function-call', name: 'load_it' },
      bind: { target: { arg: 0, type: 'path-literal' } },
      emit: 'php-include',
      anchor: { template: 'php-file:src/{target}', role: 'target' },
    } as const;
    const valid = parseConfig({ extractors: [pattern] });
    expect(valid.kind).toBe('ok');
    if (valid.kind === 'ok') expect(valid.value.extractors).toEqual([pattern]);
    expect(parseConfig({ extractors: [{ ...pattern, nope: true }] }).kind).toBe('err');
  });

  it('rejects confidence threshold outside [0, 1]', () => {
    const r = parseConfig({ confidence: { threshold: -0.5 } });
    expect(r.kind).toBe('err');
  });

  it('rejects negative traversal.maxDepth', () => {
    const r = parseConfig({ traversal: { maxDepth: -1 } });
    expect(r.kind).toBe('err');
  });

  it('rejects unknown fields at the top level', () => {
    const r = parseConfig({ frameworks: {} }); // old shape — must not be accepted silently
    expect(r.kind).toBe('err');
  });

  it('rejects unknown sub-object fields (typo guard)', () => {
    const r = parseConfig({
      tests: { phpunit: { baseClass: [] } },  // singular typo; correct field is baseClasses
    });
    expect(r.kind).toBe('err');
  });
});
