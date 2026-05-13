import type { FrameworkName } from '../types.js';

export interface QueryRow {
  readonly testId: string;
  readonly source: string;
  readonly framework: FrameworkName;
  readonly frameworkClass: 'unit' | 'e2e';
  readonly confidence: number;
  readonly partial: boolean;
}

export interface QueryResult {
  readonly rows: readonly QueryRow[];
  readonly unknownPaths: readonly string[];
  readonly unknownTestIds: readonly string[];
}

export interface TestsFromSourcesArgs {
  readonly sources: readonly string[];
  readonly framework: FrameworkName;
  readonly minConfidence: number;
}

export interface SourcesFromTestsArgs {
  readonly testIds: readonly string[];
  readonly minConfidence: number;
}
