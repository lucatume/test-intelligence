import type { ProjectRelativePath, ISODate } from '../types.js';

// Phase 1 resolves exactly one fact-kind family — `hook-fire` / `hook-listener`.
export type FactKind = 'hook-fire' | 'hook-listener';

export type Classification =
  | 'structural-rule'
  | 'project-constant'
  | 'data-dependent-unresolvable';

// One exported work unit. `exprHash` is the fact's stable Phase-0
// `payload.unresolved.exprHash` — the cache/result key. `unresolvedExpression`
// and `enclosingScope` are derived from the Phase-0 `unresolved` block:
// `unresolved.fields[0].expression` and `unresolved.scope`. A `hook-*` fact
// has exactly one unresolved field (`hook`), so the singular shape is exact.
export interface ResolveUnit {
  readonly exprHash: string;
  readonly factKind: FactKind;
  readonly unresolvedExpression: string;
  readonly enclosingScope: string;
  readonly filePath: ProjectRelativePath;
  readonly codeContext: {
    readonly startLine: number;
    readonly endLine: number;
    readonly text: string;
  };
}

export interface ResolveBundle {
  readonly version: 1;
  readonly pass: 'llm';
  readonly project: string;
  readonly generatedAt: ISODate;
  readonly units: readonly ResolveUnit[];
}

export interface Resolution {
  readonly exprHash: string;
  readonly classification: Classification;
  readonly resolvedValue?: { readonly hookName: string };
  readonly citation?: { readonly path: ProjectRelativePath; readonly line: number };
  readonly note?: string;
}

export interface ResolutionsFile {
  readonly version: 1;
  readonly pass: 'llm';
  readonly resolutions: readonly Resolution[];
}

export interface ImportSummary {
  readonly applied: number;
  readonly rejected: number;
  readonly stale: number;
  readonly classifiedUnresolvable: number;
  readonly rejections: readonly { readonly exprHash: string; readonly reason: string }[];
}

export type ResolveError =
  | { readonly kind: 'parse'; readonly message: string }
  | { readonly kind: 'io'; readonly message: string };
