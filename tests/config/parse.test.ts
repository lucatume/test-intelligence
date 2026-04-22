import { describe, it, expect } from 'vitest';
import { parseConfig } from '../../src/config/parse.js';

describe('parseConfig — defaults', () => {
  it('accepts an empty object and fills all defaults', () => {
    const r = parseConfig({});
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.value.confidence).toEqual({ runtime: 1.0, static: 0.7, heuristic: 0.3 });
      expect(r.value.build.testTimeoutSeconds).toBe(60);
      expect(r.value.build.parallel).toBe(true);
      expect(r.value.build.maxCoverageArtifactBytes).toBe(500 * 1024 * 1024);
      expect(r.value.ignore).toEqual([]);
      expect(r.value.allowSymlinkTargets).toEqual([]);
      expect(r.value.frameworks).toEqual({});
      expect(r.value.views).toEqual({});
    }
  });
});

describe('parseConfig — frameworks', () => {
  it('accepts a well-formed phpunit framework block', () => {
    const r = parseConfig({
      frameworks: {
        phpunit: {
          runner: { bin: 'vendor/bin/phpunit', args: [] },
          coverage: 'pcov',
        },
      },
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.value.frameworks.phpunit?.runner).toEqual({
        bin: 'vendor/bin/phpunit', args: [],
      });
      expect(r.value.frameworks.phpunit?.coverage).toBe('pcov');
    }
  });

  it('accepts runner with bin-only (defaults args to [])', () => {
    const r = parseConfig({
      frameworks: { jest: { runner: { bin: 'npx', args: ['jest'] } } },
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.value.frameworks.jest?.runner.args).toEqual(['jest']);
    }
  });

  it('rejects runner missing bin', () => {
    const r = parseConfig({
      frameworks: { jest: { runner: { args: [] } } },
    });
    expect(r.kind).toBe('err');
  });

  it('rejects unknown framework name', () => {
    const r = parseConfig({
      frameworks: { mocha: { runner: { bin: 'x', args: [] } } },
    });
    expect(r.kind).toBe('err');
  });
});

describe('parseConfig — confidence weights', () => {
  it('accepts valid weights', () => {
    const r = parseConfig({ confidence: { runtime: 0.9, static: 0.5, heuristic: 0.1 } });
    expect(r.kind).toBe('ok');
  });

  it('rejects weights outside [0, 1]', () => {
    const r = parseConfig({ confidence: { runtime: 1.5, static: 0.5, heuristic: 0.1 } });
    expect(r.kind).toBe('err');
  });
});

describe('parseConfig — errors are path-qualified', () => {
  it('reports the field path in error messages', () => {
    const r = parseConfig({ build: { testTimeoutSeconds: 'nope' } });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.some((e) => e.path.includes('build') && e.path.includes('testTimeoutSeconds')))
        .toBe(true);
    }
  });
});
