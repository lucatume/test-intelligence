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
