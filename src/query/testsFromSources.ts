import type Database from 'better-sqlite3';
import type { QueryResult, QueryRow, TestsFromSourcesArgs } from './types.js';
import type { FrameworkName } from '../types.js';

export function testsFromSources(
  db: Database.Database,
  args: TestsFromSourcesArgs,
): QueryResult {
  const rows: QueryRow[] = [];
  const unknownPaths: string[] = [];
  if (args.sources.length === 0) {
    return { rows: [], unknownPaths: [], unknownTestIds: [] };
  }

  const hasFile = db.prepare('SELECT 1 FROM file WHERE path = ? LIMIT 1');
  const known: string[] = [];
  for (const p of args.sources) {
    if (hasFile.get(p) !== undefined) known.push(p);
    else unknownPaths.push(p);
  }
  if (known.length === 0) {
    return { rows, unknownPaths, unknownTestIds: [] };
  }

  const placeholders = known.map(() => '?').join(',');
  const stmt = db.prepare(`
    SELECT e.test_id AS testId, e.source AS source, e.confidence AS confidence,
           e.partial AS partial,
           t.framework AS framework, t.framework_class AS frameworkClass
    FROM edge e
    JOIN test t ON t.test_id = e.test_id
    WHERE e.source IN (${placeholders})
      AND t.framework = ?
      AND e.confidence >= ?
    ORDER BY e.test_id, e.source
  `);
  const params: unknown[] = [...known, args.framework, args.minConfidence];
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
  return { rows, unknownPaths, unknownTestIds: [] };
}
