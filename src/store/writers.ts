import type Database from 'better-sqlite3';
import type { FactKind } from '../types.js';

export interface FileInsert {
  readonly path: string;
  readonly language: string;
  readonly contentHash: string;
  readonly extractedAt: string;
  readonly isTest: boolean;
  readonly framework: string | null;
  readonly frameworkClass: string | null;
}

export function upsertFile(db: Database.Database, file: FileInsert): number {
  const stmt = db.prepare(`
    INSERT INTO file (path, language, content_hash, extracted_at, is_test, framework, framework_class)
    VALUES (@path, @language, @content_hash, @extracted_at, @is_test, @framework, @framework_class)
    ON CONFLICT(path) DO UPDATE SET
      language = excluded.language,
      content_hash = excluded.content_hash,
      extracted_at = excluded.extracted_at,
      is_test = excluded.is_test,
      framework = excluded.framework,
      framework_class = excluded.framework_class
    RETURNING id
  `);
  const row = stmt.get({
    path: file.path,
    language: file.language,
    content_hash: file.contentHash,
    extracted_at: file.extractedAt,
    is_test: file.isTest ? 1 : 0,
    framework: file.framework,
    framework_class: file.frameworkClass,
  }) as { id: number };
  return row.id;
}

export interface FactInsert {
  readonly fileId: number;
  readonly kind: FactKind;
  readonly resolved: boolean;
  readonly startLine: number;
  readonly endLine: number;
  readonly payload: unknown;
}

export function insertFact(db: Database.Database, fact: FactInsert): number {
  const stmt = db.prepare(`
    INSERT INTO fact (file_id, kind, resolved, start_line, end_line, payload)
    VALUES (@file_id, @kind, @resolved, @start_line, @end_line, @payload)
  `);
  const r = stmt.run({
    file_id: fact.fileId,
    kind: fact.kind,
    resolved: fact.resolved ? 1 : 0,
    start_line: fact.startLine,
    end_line: fact.endLine,
    payload: JSON.stringify(fact.payload),
  });
  return Number(r.lastInsertRowid);
}

export interface AnchorInsert {
  readonly key: string;
  readonly type: string;
}

export function upsertAnchor(db: Database.Database, a: AnchorInsert): number {
  const stmt = db.prepare(`
    INSERT INTO anchor (key, type) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET type = excluded.type
    RETURNING id
  `);
  const row = stmt.get(a.key, a.type) as { id: number };
  return row.id;
}

export interface FactAnchorInsert {
  readonly factId: number;
  readonly anchorId: number;
  readonly role: string;
}

export function insertFactAnchor(db: Database.Database, fa: FactAnchorInsert): void {
  db.prepare(`
    INSERT OR IGNORE INTO fact_anchor (fact_id, anchor_id, role) VALUES (?, ?, ?)
  `).run(fa.factId, fa.anchorId, fa.role);
}

export interface TestInsert {
  readonly testId: string;
  readonly fileId: number;
  readonly framework: string;
  readonly frameworkClass: string;
  readonly factId: number;
}

export function insertTest(db: Database.Database, t: TestInsert): void {
  db.prepare(`
    INSERT OR REPLACE INTO test (test_id, file_id, framework, framework_class, fact_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(t.testId, t.fileId, t.framework, t.frameworkClass, t.factId);
}

export interface EdgeInsert {
  readonly testId: string;
  readonly source: string;
  readonly confidence: number;
  readonly partial: boolean;
  readonly evidence: unknown;
  readonly derivedAt: string;
  /** Flat list of fact_ids that contributed to this edge. v1 stored these
   *  in a separate edge_provenance table; v2 inlines them as JSON. */
  readonly provenance: readonly number[];
}

export function insertEdge(db: Database.Database, e: EdgeInsert): void {
  db.prepare(`
    INSERT INTO edge (test_id, source, confidence, partial, evidence, derived_at, provenance)
    VALUES (@test_id, @source, @confidence, @partial, @evidence, @derived_at, @provenance)
    ON CONFLICT(test_id, source) DO UPDATE SET
      confidence = excluded.confidence,
      partial = excluded.partial,
      evidence = excluded.evidence,
      derived_at = excluded.derived_at,
      provenance = excluded.provenance
  `).run({
    test_id: e.testId,
    source: e.source,
    confidence: e.confidence,
    partial: e.partial ? 1 : 0,
    evidence: JSON.stringify(e.evidence),
    derived_at: e.derivedAt,
    provenance: JSON.stringify(e.provenance),
  });
}

// MAX_VARIABLE_NUMBER on the bundled better-sqlite3 build is 32766. We stay
// well below it (28000) so that callers cannot blow the limit by accident.
// `edge` has 7 columns now → 4000 rows × 7 = 28000.
const EDGE_BULK_BATCH = 4000;
const EDGE_BULK_COLS = 7;

function buildPlaceholders(cols: number, rows: number): string {
  // Hand-rolled: `(?,?,?), (?,?,?), …` for `rows` groups of `cols` ?s.
  const oneRow = `(${'?,'.repeat(cols - 1)}?)`;
  return `${`${oneRow},`.repeat(rows - 1)}${oneRow}`;
}

/**
 * Bulk insert edges in chunks. Caller must ensure the table is empty (or
 * that no (test_id, source) duplicates exist within the input) — there is
 * no ON CONFLICT clause. Used from derive() after clearAllEdges().
 */
export function insertEdgesBulk(db: Database.Database, edges: readonly EdgeInsert[]): void {
  if (edges.length === 0) return;

  for (let offset = 0; offset < edges.length; offset += EDGE_BULK_BATCH) {
    const chunkLen = Math.min(EDGE_BULK_BATCH, edges.length - offset);
    const sql =
      `INSERT INTO edge (test_id, source, confidence, partial, evidence, derived_at, provenance) VALUES ${buildPlaceholders(EDGE_BULK_COLS, chunkLen)}`;
    const params: unknown[] = new Array<unknown>(chunkLen * EDGE_BULK_COLS);
    let p = 0;
    for (let i = 0; i < chunkLen; i++) {
      const e = edges[offset + i];
      if (e === undefined) continue; // unreachable — slice bounded by chunkLen
      params[p++] = e.testId;
      params[p++] = e.source;
      params[p++] = e.confidence;
      params[p++] = e.partial ? 1 : 0;
      params[p++] = JSON.stringify(e.evidence);
      params[p++] = e.derivedAt;
      params[p++] = JSON.stringify(e.provenance);
    }
    db.prepare(sql).run(...params);
  }
}

export function clearEdgesForTest(db: Database.Database, testId: string): void {
  db.prepare('DELETE FROM edge WHERE test_id = ?').run(testId);
}

export function clearAllEdges(db: Database.Database): void {
  db.prepare('DELETE FROM edge').run();
}

// SQLite's bound-parameter ceiling is 32766 (MAX_VARIABLE_NUMBER); chunk
// well under it so the statement cache stays small.
const EDGE_DELETE_CHUNK = 500;

export function deleteEdgesForTests(db: Database.Database, testIds: readonly string[]): void {
  for (let i = 0; i < testIds.length; i += EDGE_DELETE_CHUNK) {
    const chunk = testIds.slice(i, i + EDGE_DELETE_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    db.prepare(`DELETE FROM edge WHERE test_id IN (${placeholders})`).run(...chunk);
  }
}

/** Remove edges whose test vanished (deleted/renamed test file). The full
 *  derive path gets this for free from clearAllEdges; the scoped path must
 *  do it explicitly. */
export function purgeOrphanEdges(db: Database.Database): void {
  db.prepare('DELETE FROM edge WHERE test_id NOT IN (SELECT test_id FROM test)').run();
}

// Delete every fact row for one file. fact_anchor rows cascade via
// ON DELETE CASCADE; anchor rows are keyed on `key` and shared across files,
// so they are intentionally left in place. Used per file in runBuild so a
// re-build replaces a file's facts instead of appending to them.
export function clearFactsForFile(db: Database.Database, fileId: number): void {
  db.prepare('DELETE FROM fact WHERE file_id = ?').run(fileId);
}

export interface FileExtractState {
  readonly fileId: number;
  readonly contentHash: string;
  readonly factCount: number;
}

// Per-file state the incremental-skip check needs: the stored content hash
// and how many fact rows the file currently has. `null` when the path has no
// `file` row. The fact count is index-resolved via fact_file_idx.
export function readFileExtractState(
  db: Database.Database,
  path: string,
): FileExtractState | null {
  const row = db
    .prepare(
      `SELECT f.id AS id, f.content_hash AS content_hash,
              (SELECT COUNT(*) FROM fact WHERE file_id = f.id) AS fact_count
       FROM file f WHERE f.path = ?`,
    )
    .get(path) as { id: number; content_hash: string; fact_count: number } | undefined;
  if (row === undefined) return null;
  return { fileId: row.id, contentHash: row.content_hash, factCount: row.fact_count };
}

export interface FactUpdate {
  readonly factId: number;
  readonly resolved: boolean;
  readonly payload: unknown;
}

// Mutate an existing fact's resolved flag and payload in place. Used by the
// cross-file rest-endpoint resolver, which fills inherited properties after
// extraction and re-derives the fact's resolution state.
export function updateFactResolvedPayload(db: Database.Database, u: FactUpdate): void {
  db.prepare('UPDATE fact SET resolved = ?, payload = ? WHERE id = ?')
    .run(u.resolved ? 1 : 0, JSON.stringify(u.payload), u.factId);
}

export interface FactAnchorRepoint {
  readonly factId: number;
  readonly oldAnchorId: number;
  readonly newAnchorId: number;
  readonly role: string;
}

// Re-point a fact's anchor: drop the (factId, oldAnchorId, role) row and add
// (factId, newAnchorId, role). fact_anchor PK is (fact_id, anchor_id, role);
// INSERT OR IGNORE guards an already-present target row.
export function repointFactAnchor(db: Database.Database, r: FactAnchorRepoint): void {
  db.prepare('DELETE FROM fact_anchor WHERE fact_id = ? AND anchor_id = ? AND role = ?')
    .run(r.factId, r.oldAnchorId, r.role);
  db.prepare('INSERT OR IGNORE INTO fact_anchor (fact_id, anchor_id, role) VALUES (?, ?, ?)')
    .run(r.factId, r.newAnchorId, r.role);
}

// --- LLM-resolution pass cache (the `resolution` table) ------------------

export interface ResolutionRow {
  readonly exprHash: string;
  readonly pass: string;
  readonly resolvedValue: unknown;
  readonly classification: string;
  readonly citePath: string;
  readonly citeLine: number;
  readonly citeVerified: boolean;
  readonly importedAt: string;
}

// Insert-or-replace one resolution row, keyed on (expr_hash, pass).
export function upsertResolution(db: Database.Database, r: ResolutionRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO resolution
       (expr_hash, pass, resolved_value, classification,
        cite_path, cite_line, cite_verified, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.exprHash, r.pass, JSON.stringify(r.resolvedValue), r.classification,
    r.citePath, r.citeLine, r.citeVerified ? 1 : 0, r.importedAt,
  );
}

export function readResolution(
  db: Database.Database, exprHash: string, pass: string,
): ResolutionRow | null {
  const row = db.prepare(
    `SELECT expr_hash, pass, resolved_value, classification,
            cite_path, cite_line, cite_verified, imported_at
       FROM resolution WHERE expr_hash = ? AND pass = ?`,
  ).get(exprHash, pass) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    exprHash: row['expr_hash'] as string,
    pass: row['pass'] as string,
    resolvedValue: JSON.parse(row['resolved_value'] as string),
    classification: row['classification'] as string,
    citePath: row['cite_path'] as string,
    citeLine: row['cite_line'] as number,
    citeVerified: (row['cite_verified'] as number) === 1,
    importedAt: row['imported_at'] as string,
  };
}

export interface WrapperIndexRow {
  readonly wrapperName: string;
  readonly wraps: string;
  readonly defFile: string;
  readonly defStartLine: number;
  readonly defEndLine: number;
  readonly argSpecsJson: string;
  readonly source: 'auto' | 'config';
}

export function upsertWrapperIndexEntry(db: Database.Database, row: WrapperIndexRow): number {
  const info = db.prepare(`
    INSERT INTO wrapper_index (wrapper_name, wraps, def_file, def_start_line, def_end_line, arg_specs_json, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.wrapperName, row.wraps, row.defFile,
    row.defStartLine, row.defEndLine, row.argSpecsJson, row.source,
  );
  return Number(info.lastInsertRowid);
}

export function insertWrapperCallSite(
  db: Database.Database,
  args: { factId: number; wrapperId: number },
): void {
  db.prepare(`
    INSERT OR IGNORE INTO wrapper_call_site (fact_id, wrapper_id) VALUES (?, ?)
  `).run(args.factId, args.wrapperId);
}

// Delete every resolution row whose expr_hash is not in `liveHashes`. Returns
// the number of rows removed.
export function pruneStaleResolutions(
  db: Database.Database, liveHashes: ReadonlySet<string>,
): number {
  const all = db.prepare('SELECT expr_hash FROM resolution').all() as
    { expr_hash: string }[];
  const del = db.prepare('DELETE FROM resolution WHERE expr_hash = ?');
  let n = 0;
  for (const r of all) {
    if (!liveHashes.has(r.expr_hash)) { del.run(r.expr_hash); n++; }
  }
  return n;
}
