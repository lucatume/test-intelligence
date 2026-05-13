import type { QueryResult } from '../query/types.js';

export function emitJson(result: QueryResult): string {
  const payload = {
    edges: result.rows.map((r) => ({
      testId: r.testId,
      source: r.source,
      framework: r.framework,
      frameworkClass: r.frameworkClass,
      confidence: r.confidence,
      partial: r.partial,
    })),
    unknownPaths: [...result.unknownPaths],
    unknownTestIds: [...result.unknownTestIds],
  };
  return JSON.stringify(payload) + '\n';
}
