// Branded primitives: each has exactly one constructor (its parser).
// Interior code handles only these branded values — never raw strings or numbers
// for things that carry semantic meaning.
//
// The `__brand` field is the outer brand; `__kind` is the inner discriminator
// when a brand has sub-variants (e.g., SourcePath vs TestFilePath both extend
// ProjectRelativePath). This two-level scheme is intentional — the outer brand
// enforces "this string has been through path-parser rules," the inner kind
// enforces "this path is a source (or test) path specifically." Do not collapse.

export type ProjectRelativePath = string & { readonly __brand: 'ProjectRelativePath' };
export type SourcePath          = ProjectRelativePath & { readonly __kind: 'Source' };
export type TestFilePath        = ProjectRelativePath & { readonly __kind: 'Test' };

export type Confidence = number & { readonly __brand: 'Confidence' }; // 0..1

export type FrameworkName = 'phpunit' | 'jest' | 'playwright';

export type ISODate = string & { readonly __brand: 'ISODate' };

export type RunnerInvocation = {
  readonly bin: string;
  readonly args: readonly string[];
};
