import { describe, it, expectTypeOf } from 'vitest';
import type {
  ProjectRelativePath,
  SourcePath,
  TestFilePath,
  Confidence,
  FrameworkName,
  ISODate,
  RunnerInvocation,
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
