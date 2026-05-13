import type { QueryResult } from '../query/types.js';

export interface EmitArgsOptions {
  readonly mode: 'tests' | 'sources';
}

export function emitArgs(result: QueryResult, opts: EmitArgsOptions): string {
  const seen = new Set<string>();
  for (const row of result.rows) {
    seen.add(opts.mode === 'tests' ? row.testId : row.source);
  }
  if (seen.size === 0) return '';
  return [...seen].sort().join('\n') + '\n';
}
