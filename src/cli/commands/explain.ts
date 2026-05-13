import type { Io } from '../io.js';
import { openStore } from '../../store/open.js';

interface RawEdge {
  test_id: string;
  source: string;
  confidence: number;
  partial: number;
}

interface ProvenanceRow {
  test_id: string;
  source: string;
  fact_id: number;
  fact_kind: string;
  fact_resolved: number;
  fact_start_line: number;
  file_path: string;
  payload: string;
}

export interface ExplainCommandArgs {
  readonly projectRoot: string;
  readonly io: Io;
  readonly target: string;
  readonly format: 'args' | 'json';
}

export function explainCommand(args: ExplainCommandArgs): number {
  const s = openStore(args.projectRoot);
  if (s.kind === 'err') {
    args.io.stderr.write(`ti: ${s.error.message}\n`);
    return 1;
  }
  try {
    const isTestId = args.target.includes(':');
    const edgesStmt = isTestId
      ? s.value.db.prepare('SELECT test_id, source, confidence, partial FROM edge WHERE test_id = ? ORDER BY source')
      : s.value.db.prepare('SELECT test_id, source, confidence, partial FROM edge WHERE source = ? ORDER BY test_id');
    const rows = edgesStmt.all(args.target) as RawEdge[];

    if (rows.length === 0) {
      args.io.stderr.write(`ti: no edges found for ${args.target}\n`);
      return 0;
    }

    const provenanceStmt = s.value.db.prepare(`
      SELECT ep.test_id, ep.source, ep.fact_id,
             f.kind AS fact_kind, f.resolved AS fact_resolved,
             f.start_line AS fact_start_line, fl.path AS file_path, f.payload AS payload
      FROM edge_provenance ep
      JOIN fact f ON f.id = ep.fact_id
      JOIN file fl ON fl.id = f.file_id
      WHERE ${isTestId ? 'ep.test_id = ?' : 'ep.source = ?'}
      ORDER BY ep.test_id, ep.source, ep.fact_id
    `);
    const provenance = provenanceStmt.all(args.target) as ProvenanceRow[];

    const provByEdge = new Map<string, ProvenanceRow[]>();
    for (const p of provenance) {
      const key = `${p.test_id}|${p.source}`;
      const arr = provByEdge.get(key);
      if (arr) arr.push(p);
      else provByEdge.set(key, [p]);
    }

    if (args.format === 'json') {
      const out = {
        target: args.target,
        edges: rows.map((e) => ({
          testId: e.test_id,
          source: e.source,
          confidence: e.confidence,
          partial: e.partial !== 0,
          evidence: (provByEdge.get(`${e.test_id}|${e.source}`) ?? []).map((p) => ({
            factId: p.fact_id,
            factKind: p.fact_kind,
            filePath: p.file_path,
            startLine: p.fact_start_line,
            resolved: p.fact_resolved !== 0,
            payload: tryParse(p.payload),
          })),
        })),
      };
      args.io.stdout.write(JSON.stringify(out) + '\n');
      return 0;
    }

    for (const e of rows) {
      args.io.stdout.write(
        `${e.test_id} <- ${e.source}  confidence=${e.confidence.toFixed(2)}${e.partial !== 0 ? ' (partial)' : ''}\n`,
      );
      const ev = provByEdge.get(`${e.test_id}|${e.source}`) ?? [];
      for (const p of ev) {
        const payload = compact(tryParse(p.payload));
        args.io.stdout.write(`    ${p.file_path}:${String(p.fact_start_line)} ${p.fact_kind} ${payload}\n`);
      }
    }
    return 0;
  } finally {
    s.value.close();
  }
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function compact(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}
