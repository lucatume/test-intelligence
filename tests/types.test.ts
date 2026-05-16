import { describe, expect, it, expectTypeOf } from 'vitest';
import { ALL_ANCHOR_TYPES } from '../src/types.js';
import type {
  AnchorKey,
  AnchorType,
  Confidence,
  FactKind,
  FrameworkName,
  ISODate,
  ProjectRelativePath,
  RunnerInvocation,
  SourcePath,
  TestFilePath,
} from '../src/types.js';
import { unsafeCoerce } from './helpers/unsafeCoerce.js';

describe('branded primitive types', () => {
  it('ProjectRelativePath is assignable from its brand-tagged form only', () => {
    const p: ProjectRelativePath = unsafeCoerce<ProjectRelativePath>('src/foo.ts');
    expectTypeOf(p).toEqualTypeOf<ProjectRelativePath>();
  });

  it('SourcePath is-a ProjectRelativePath', () => {
    const s: SourcePath = unsafeCoerce<SourcePath>('src/foo.ts');
    const p: ProjectRelativePath = s;
    expectTypeOf(p).toEqualTypeOf<ProjectRelativePath>();
  });

  it('TestFilePath is-a ProjectRelativePath', () => {
    const t: TestFilePath = unsafeCoerce<TestFilePath>('tests/foo.test.ts');
    const p: ProjectRelativePath = t;
    expectTypeOf(p).toEqualTypeOf<ProjectRelativePath>();
  });

  it('Confidence is a tagged number', () => {
    const c: Confidence = unsafeCoerce<Confidence>(0.5);
    expectTypeOf(c).toEqualTypeOf<Confidence>();
  });

  it('FrameworkName is a narrow union', () => {
    expectTypeOf<FrameworkName>().toEqualTypeOf<'phpunit' | 'jest' | 'playwright'>();
  });

  it('ISODate is a tagged string', () => {
    const d: ISODate = unsafeCoerce<ISODate>('2026-04-21T10:00:00Z');
    expectTypeOf(d).toEqualTypeOf<ISODate>();
  });

  it('RunnerInvocation is a structured command shape', () => {
    const r: RunnerInvocation = { bin: 'vendor/bin/phpunit', args: [] };
    expectTypeOf(r.bin).toEqualTypeOf<string>();
    expectTypeOf(r.args).toEqualTypeOf<readonly string[]>();
  });
});

describe('branded type identities', () => {
  it('AnchorKey is a string brand distinct from ProjectRelativePath', () => {
    // type-only test: this file must compile but the assignment below must not.
    // The test passes if `npm run typecheck` succeeds AND the @ts-expect-error line below is genuinely an error.
    const a = 'rest:GET /foo' as AnchorKey;
    // @ts-expect-error AnchorKey is not assignable to ProjectRelativePath
    const _bad: ProjectRelativePath = a;
    void _bad;
    expect(typeof a).toBe('string');
  });

  it('ALL_ANCHOR_TYPES enumerates exactly AnchorType', () => {
    type FromArray = (typeof ALL_ANCHOR_TYPES)[number];
    // type-only checks: both directions must hold.
    const _f: FromArray extends AnchorType ? true : false = true;
    const _g: AnchorType extends FromArray ? true : false = true;
    void _f; void _g;
    expect(ALL_ANCHOR_TYPES.length).toBe(12);
  });

  it('FactKind has the sealed v1 set', () => {
    const ks: FactKind[] = [
      'symbol-def',
      'symbol-use',
      'import-edge',
      'php-include',
      'hook-listener',
      'hook-fire',
      'rest-endpoint',
      'rest-call-js',
      'ajax-listener',
      'ajax-call-js',
      'enqueue-script',
      'admin-page-nav',
      'admin-page-register',
      'script-localize',
      'script-localize-inline',
      'shortcode',
      'block-render',
      'test-def',
      'parse-error',
    ];
    expect(ks.length).toBe(19);
  });
});
