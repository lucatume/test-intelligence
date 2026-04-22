import * as P from '../parse.js';
import type { Infer, ParseResult } from '../parse.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const isoDate = P.refine(P.string, (s) => ISO_RE.test(s) ? null : `expected ISO8601 UTC date, got "${s}"`);
const confidence01 = P.refine(P.number, (n) => n >= 0 && n <= 1 ? null : 'confidence must be in [0, 1]');

const evidenceSchema = P.object({
  strategy: P.enumOf(['runtime', 'static', 'heuristic', 'view-provider:http', 'view-provider:rest', 'view-provider:cli'] as const),
  at: isoDate,
});

const testEdgeSchema = P.object({
  id: P.string,
  file: P.string,
  framework: P.enumOf(['phpunit', 'jest', 'playwright'] as const),
  filter: P.optional(P.string),
  confidence: confidence01,
  evidence: P.array(evidenceSchema),
  stale: P.optional(P.boolean),
});

const viewEdgeSchema = P.object({
  id: P.string,
  kind: P.enumOf(['http', 'rest', 'cli'] as const),
  confidence: confidence01,
  evidence: P.array(evidenceSchema),
});

const shardSchema = P.object({
  source: P.string,
  source_hash: P.string,
  tests: P.withDefault(P.array(testEdgeSchema), []),
  views: P.withDefault(P.array(viewEdgeSchema), []),
});

export type Shard = Infer<typeof shardSchema>;
export type TestEdge = Shard['tests'][number];
export type ViewEdge = Shard['views'][number];
export type Evidence = TestEdge['evidence'][number];

export function parseShard(raw: unknown): ParseResult<Shard> {
  return shardSchema.parse(raw);
}
