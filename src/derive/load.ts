import type Database from 'better-sqlite3';
import type { AnchorKey, FactKind, FrameworkName } from '../types.js';
import type { AnchorRole } from '../facts/types.js';
import type { FactAnchorLink, FactRow, FileRow, Graph, TestRow } from './types.js';

export function loadGraph(db: Database.Database): Graph {
  const fileRows = db.prepare(`
    SELECT id, path, language, content_hash, is_test, framework, framework_class
    FROM file
  `).all() as Array<{
    id: number;
    path: string;
    language: string;
    content_hash: string;
    is_test: number;
    framework: string | null;
    framework_class: string | null;
  }>;

  const files = new Map<number, FileRow>();
  for (const r of fileRows) {
    files.set(r.id, {
      id: r.id,
      path: r.path,
      language: r.language,
      // Matches the discover walker's default vendor glob (**/vendor/**) —
      // monorepos place vendor/ under every package, not just at the root.
      vendor: /(?:^|\/)vendor\//.test(r.path),
      framework: r.framework as FrameworkName | null,
      frameworkClass:
        r.framework_class === 'unit' || r.framework_class === 'e2e' ? r.framework_class : null,
    });
  }

  const factRows = db.prepare(`
    SELECT id, file_id, kind, resolved, start_line, end_line, payload
    FROM fact
  `).all() as Array<{
    id: number;
    file_id: number;
    kind: string;
    resolved: number;
    start_line: number;
    end_line: number;
    payload: string;
  }>;

  const facts = new Map<number, FactRow>();
  const factsByFile = new Map<number, FactRow[]>();
  for (const r of factRows) {
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(r.payload);
      payload = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      payload = {};
    }
    const fact: FactRow = {
      id: r.id,
      fileId: r.file_id,
      kind: r.kind as FactKind,
      resolved: r.resolved !== 0,
      startLine: r.start_line,
      endLine: r.end_line,
      payload,
    };
    facts.set(r.id, fact);
    const bucket = factsByFile.get(r.file_id);
    if (bucket) bucket.push(fact);
    else factsByFile.set(r.file_id, [fact]);
  }

  const linkRows = db.prepare(`
    SELECT fa.fact_id AS fact_id, a.key AS key, fa.role AS role
    FROM fact_anchor fa
    JOIN anchor a ON a.id = fa.anchor_id
  `).all() as Array<{ fact_id: number; key: string; role: string }>;

  const anchorLinks: FactAnchorLink[] = linkRows.map((r) => ({
    factId: r.fact_id,
    anchorKey: r.key as AnchorKey,
    role: r.role as AnchorRole,
  }));

  const testRows = db.prepare(`
    SELECT test_id, file_id, framework, framework_class, fact_id FROM test
  `).all() as Array<{
    test_id: string;
    file_id: number;
    framework: string;
    framework_class: string;
    fact_id: number;
  }>;

  const tests: TestRow[] = testRows.map((r) => ({
    testId: r.test_id,
    fileId: r.file_id,
    framework: r.framework as FrameworkName,
    frameworkClass: r.framework_class === 'e2e' ? 'e2e' : 'unit',
    factId: r.fact_id,
  }));

  return { files, facts, factsByFile, anchorLinks, tests };
}
