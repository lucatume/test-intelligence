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
}

export function insertEdge(db: Database.Database, e: EdgeInsert): void {
  db.prepare(`
    INSERT INTO edge (test_id, source, confidence, partial, evidence, derived_at)
    VALUES (@test_id, @source, @confidence, @partial, @evidence, @derived_at)
    ON CONFLICT(test_id, source) DO UPDATE SET
      confidence = excluded.confidence,
      partial = excluded.partial,
      evidence = excluded.evidence,
      derived_at = excluded.derived_at
  `).run({
    test_id: e.testId,
    source: e.source,
    confidence: e.confidence,
    partial: e.partial ? 1 : 0,
    evidence: JSON.stringify(e.evidence),
    derived_at: e.derivedAt,
  });
}

export interface EdgeProvenanceInsert {
  readonly testId: string;
  readonly source: string;
  readonly factId: number;
}

export function insertEdgeProvenance(db: Database.Database, p: EdgeProvenanceInsert): void {
  db.prepare(`
    INSERT OR IGNORE INTO edge_provenance (test_id, source, fact_id) VALUES (?, ?, ?)
  `).run(p.testId, p.source, p.factId);
}

export function clearEdgesForTest(db: Database.Database, testId: string): void {
  db.prepare('DELETE FROM edge WHERE test_id = ?').run(testId);
  db.prepare('DELETE FROM edge_provenance WHERE test_id = ?').run(testId);
}

export function clearAllEdges(db: Database.Database): void {
  db.prepare('DELETE FROM edge').run();
  db.prepare('DELETE FROM edge_provenance').run();
}
