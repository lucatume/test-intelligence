import type { Io } from '../io.js';
import { openStore } from '../../store/open.js';

interface RawEdge {
  test_id: string;
  source: string;
  confidence: number;
  partial: number;
  evidence: string;
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
      ? s.value.db.prepare('SELECT test_id, source, confidence, partial, evidence FROM edge WHERE test_id = ? ORDER BY source')
      : s.value.db.prepare('SELECT test_id, source, confidence, partial, evidence FROM edge WHERE source = ? ORDER BY test_id');
    const rows = edgesStmt.all(args.target) as RawEdge[];

    if (rows.length === 0) {
      args.io.stderr.write(`ti: no edges found for ${args.target}\n`);
      return 0;
    }

    // v2: provenance fact ids live as a JSON array on edge.provenance.
    // json_each lets us JOIN against fact + file in a single query so the
    // output shape matches the v1 edge_provenance-based command exactly.
    const provenanceStmt = s.value.db.prepare(`
      SELECT e.test_id AS test_id, e.source AS source,
             je.value AS fact_id,
             f.kind AS fact_kind, f.resolved AS fact_resolved,
             f.start_line AS fact_start_line,
             fl.path AS file_path, f.payload AS payload
      FROM edge e
      JOIN json_each(e.provenance) je
      JOIN fact f ON f.id = je.value
      JOIN file fl ON fl.id = f.file_id
      WHERE ${isTestId ? 'e.test_id = ?' : 'e.source = ?'}
      ORDER BY e.test_id, e.source, je.value
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
          evidenceKinds: evidenceKindsOf(e.evidence),
          evidence: (provByEdge.get(`${e.test_id}|${e.source}`) ?? []).map((p) => {
            const payload = tryParse(p.payload);
            const resolvedBy = resolvedByOf(payload);
            return {
              factId: p.fact_id,
              factKind: p.fact_kind,
              filePath: p.file_path,
              startLine: p.fact_start_line,
              resolved: p.fact_resolved !== 0,
              ...(resolvedBy !== null ? { resolvedBy } : {}),
              payload,
            };
          }),
        })),
      };
      args.io.stdout.write(JSON.stringify(out) + '\n');
      return 0;
    }

    for (const e of rows) {
      const kinds = evidenceKindsOf(e.evidence);
      args.io.stdout.write(
        `${e.test_id} <- ${e.source}  confidence=${e.confidence.toFixed(2)}${e.partial !== 0 ? ' (partial)' : ''}${kinds.length > 0 ? ` evidence=${kinds.join(',')}` : ''}\n`,
      );
      const ev = provByEdge.get(`${e.test_id}|${e.source}`) ?? [];
      for (const p of ev) {
        const parsed = tryParse(p.payload);
        const resolvedBy = resolvedByOf(parsed);
        const tag = resolvedBy !== null ? ` [resolvedBy=${resolvedBy}]` : '';
        args.io.stdout.write(
          `    ${p.file_path}:${String(p.fact_start_line)} ${p.fact_kind}${tag} ${compact(parsed)}\n`,
        );
      }
    }
    return 0;
  } finally {
    s.value.close();
  }
}

function evidenceKindsOf(raw: string): string[] {
  const parsed = tryParse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const kind = (item as Record<string, unknown>)['kind'];
    return typeof kind === 'string' ? [kind] : [];
  });
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

// Surface `payload.meta.resolvedBy` (e.g. 'llm-pass') so an LLM-resolved fact
// is distinguishable from an extractor-resolved one. Extractor facts carry no
// `meta.resolvedBy` — the field is simply omitted for them.
function resolvedByOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const meta = (payload as Record<string, unknown>)['meta'];
  if (typeof meta !== 'object' || meta === null) return null;
  const rb = (meta as Record<string, unknown>)['resolvedBy'];
  return typeof rb === 'string' ? rb : null;
}
