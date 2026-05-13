import type Database from 'better-sqlite3';
import type { QueryResult, QueryRow, SourcesFromTestsArgs } from './types.js';
import type { FrameworkName } from '../types.js';

export function sourcesFromTests(
  db: Database.Database,
  args: SourcesFromTestsArgs,
): QueryResult {
  if (args.testIds.length === 0) {
    return { rows: [], unknownPaths: [], unknownTestIds: [] };
  }
  const hasTest = db.prepare('SELECT 1 FROM test WHERE test_id = ? LIMIT 1');
  const known: string[] = [];
  const unknownTestIds: string[] = [];
  for (const id of args.testIds) {
    if (hasTest.get(id) !== undefined) known.push(id);
    else unknownTestIds.push(id);
  }
  if (known.length === 0) {
    return { rows: [], unknownPaths: [], unknownTestIds };
  }
  const placeholders = known.map(() => '?').join(',');
  const stmt = db.prepare(`
    SELECT e.test_id AS testId, e.source AS source, e.confidence AS confidence,
           e.partial AS partial,
           t.framework AS framework, t.framework_class AS frameworkClass
    FROM edge e
    JOIN test t ON t.test_id = e.test_id
    WHERE e.test_id IN (${placeholders})
      AND e.confidence >= ?
    ORDER BY e.test_id, e.source
  `);
  const params: unknown[] = [...known, args.minConfidence];
  const rows: QueryRow[] = [];
  for (const r of stmt.all(...params) as Array<{
    testId: string;
    source: string;
    confidence: number;
    partial: number;
    framework: string;
    frameworkClass: string;
  }>) {
    rows.push({
      testId: r.testId,
      source: r.source,
      confidence: r.confidence,
      partial: r.partial !== 0,
      framework: r.framework as FrameworkName,
      frameworkClass: r.frameworkClass === 'e2e' ? 'e2e' : 'unit',
    });
  }
  return { rows, unknownPaths: [], unknownTestIds };
}
