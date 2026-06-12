import type Database from 'better-sqlite3';

export type DeriveScope =
  | { readonly kind: 'scoped'; readonly testIds: ReadonlySet<string> }
  | { readonly kind: 'full'; readonly reason: string };

// Above this fraction of all tests, scoped traversal saves nothing over a
// full pass (and pays the bookkeeping), so fall back.
const FULL_FALLBACK_RATIO = 0.5;

/**
 * Candidate tests whose traversal output can change given `changedFileIds`.
 * Requires `snapshotFactAnchors` to have run BEFORE extraction (it provides
 * `ti_pre_fact_anchor`). Buckets:
 *  (a) tests with an existing edge to a changed file (their walk entered it)
 *  (b) tests with an edge to any file holding a fact on an anchor key a
 *      changed file GAINED (a brand-new bridge into the changed file), plus
 *      tests whose own test file holds such a fact (test-file facts are the
 *      BFS seed and record no edge)
 *  (c) tests defined in a changed file
 * Role complementarity is deliberately ignored in (b): over-approximation
 * is allowed (supersets re-derive to the same result), under-approximation
 * is not.
 *
 * Programmer error (invariant violation) if `snapshotFactAnchors` was not
 * called before this function — the gained-keys query below will throw
 * "no such table: ti_pre_fact_anchor", which is correct per repo conventions
 * (throw is reserved for programmer errors).
 */
export function computeDeriveScope(
  db: Database.Database,
  changedFileIds: ReadonlySet<number>,
): DeriveScope {
  const priorEdges = (db.prepare('SELECT COUNT(*) AS n FROM edge').get() as { n: number }).n;
  if (priorEdges === 0) return { kind: 'full', reason: 'no prior edges' };
  if (changedFileIds.size === 0) return { kind: 'scoped', testIds: new Set<string>() };

  db.exec('DROP TABLE IF EXISTS ti_scope_changed; CREATE TEMP TABLE ti_scope_changed (id INTEGER PRIMARY KEY) WITHOUT ROWID;');
  const ins = db.prepare('INSERT OR IGNORE INTO ti_scope_changed VALUES (?)');
  for (const id of changedFileIds) ins.run(id);

  // Keys gained by changed files relative to the pre-extract snapshot.
  // Throws "no such table: ti_pre_fact_anchor" if caller skipped snapshotFactAnchors — programmer error.
  db.exec(`
    DROP TABLE IF EXISTS ti_scope_gained;
    CREATE TEMP TABLE ti_scope_gained AS
      SELECT DISTINCT fa.anchor_id AS anchor_id
      FROM fact f JOIN fact_anchor fa ON fa.fact_id = f.id
      WHERE f.file_id IN (SELECT id FROM ti_scope_changed)
        AND NOT EXISTS (
          SELECT 1 FROM ti_pre_fact_anchor p
          WHERE p.file_id = f.file_id AND p.anchor_id = fa.anchor_id
        );
  `);

  const rows = db.prepare(`
    SELECT DISTINCT e.test_id AS tid FROM edge e
      JOIN file fi ON fi.path = e.source
      WHERE fi.id IN (SELECT id FROM ti_scope_changed)
    UNION
    SELECT t.test_id AS tid FROM test t
      WHERE t.file_id IN (SELECT id FROM ti_scope_changed)
    UNION
    SELECT DISTINCT e.test_id AS tid FROM edge e
      JOIN file fi ON fi.path = e.source
      WHERE fi.id IN (
        SELECT DISTINCT f.file_id FROM fact f
        JOIN fact_anchor fa ON fa.fact_id = f.id
        WHERE fa.anchor_id IN (SELECT anchor_id FROM ti_scope_gained)
      )
    UNION
    SELECT t.test_id AS tid FROM test t
      WHERE t.file_id IN (
        SELECT DISTINCT f.file_id FROM fact f
        JOIN fact_anchor fa ON fa.fact_id = f.id
        WHERE fa.anchor_id IN (SELECT anchor_id FROM ti_scope_gained)
      )
  `).all() as Array<{ tid: string }>;

  const testIds = new Set(rows.map((r) => r.tid));
  const totalTests = (db.prepare('SELECT COUNT(*) AS n FROM test').get() as { n: number }).n;
  if (totalTests > 0 && testIds.size / totalTests > FULL_FALLBACK_RATIO) {
    return { kind: 'full', reason: `candidates ${String(testIds.size)}/${String(totalTests)} exceed fallback ratio` };
  }
  return { kind: 'scoped', testIds };
}
