import type { FrameworkName } from '../types.js';
import type { Strategy } from './confidence.js';

// Granularity of a selected edge. File-level collapses method-level edges
// emitted by the same shard for the same test file (spec §Granularity).
export type Granularity = 'file' | 'method';

export type QueryTestEdge = {
  readonly id: string;           // raw id string as stored in the shard
  readonly file: string;         // test file path (project-relative)
  readonly framework: FrameworkName;
  readonly filter: string | undefined; // present iff granularity === 'method'
  readonly granularity: Granularity;
  readonly confidence: number;
  readonly stale: boolean;
  readonly strategies: readonly Strategy[];
};

export type TestsQueryResult = {
  readonly framework: FrameworkName;
  readonly tests: readonly QueryTestEdge[];
  readonly unknownInputs: readonly string[];
};

export type SourcesQueryResult = {
  readonly sources: readonly string[]; // alphabetically sorted, deduplicated
  readonly unknownInputs: readonly string[];
};

export type ExplainEdge = {
  readonly id: string;
  readonly file: string;
  readonly framework: FrameworkName;
  readonly filter: string | undefined;
  readonly confidence: number;
  readonly stale: boolean;
  readonly strategies: readonly Strategy[];
  readonly coveredSources: readonly string[]; // sources whose shards list this test
};

export type ExplainResult =
  | { readonly kind: 'test'; readonly edge: ExplainEdge }
  | { readonly kind: 'source'; readonly source: string; readonly tests: readonly QueryTestEdge[] }
  | { readonly kind: 'unknown'; readonly target: string };
