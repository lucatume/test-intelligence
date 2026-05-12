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
    expect(c.hooks.stopList.add).toEqual([]);
    expect(c.hooks.stopList.remove).toEqual([]);
    expect(c.extractors).toEqual([]);
    expect(c.confidence.threshold).toBe(0.0);
    expect(c.traversal.maxDepth).toBe(25);
    expect(c.traversal.maxMillisPerTest).toBe(5000);
    expect(c.concurrency.phpWorkers).toBeUndefined();
    expect(c.ignore).toEqual(['node_modules/**', 'dist/**', 'build/**']);
    expect(c.vendor).toEqual(['vendor/**']);
    expect(c.allowSymlinkTargets).toEqual([]);
  });
});

describe('parseConfig — overrides', () => {
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

  it('clamps confidence threshold to [0, 1]', () => {
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
});
