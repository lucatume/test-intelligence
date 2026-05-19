import { join } from 'node:path';
import ts from 'typescript';
import type Database from 'better-sqlite3';
import type { JsResolveOptions, JsResolveSummary } from './types.js';
import { buildResolutionProgram } from './program.js';
import { resolveExpression, type ResolvedValue } from './resolver.js';
import { buildLocalizedGlobals } from './localized-globals.js';
import {
  upsertAnchor, repointFactAnchor, updateFactResolvedPayload,
} from '../store/writers.js';

interface WorklistRow {
  readonly id: number;
  readonly kind: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly path: string;
  readonly payload: string;
}

interface OldAnchorRow {
  readonly anchor_id: number;
  readonly key: string;
  readonly role: string;
}

// Find the CallExpression whose start line equals targetLine in the source file.
function findCallAtLine(sf: ts.SourceFile, targetLine: number): ts.CallExpression | null {
  let found: ts.CallExpression | null = null;
  const walk = (n: ts.Node): void => {
    if (found !== null) return;
    if (ts.isCallExpression(n)) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      if (line === targetLine) {
        found = n;
        return;
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return found;
}

// Extract a string from a ResolvedValue for a rest-call-js fact.
// Drills the `path` property of an object if needed.
function extractRestPath(v: ResolvedValue): string | null {
  if (v.kind === 'string') return v.value;
  if (v.kind === 'object') {
    const p = v.props['path'];
    if (typeof p === 'string') return p;
    if (p !== undefined && typeof p === 'object' && p.kind === 'string') return p.value;
  }
  return null;
}

// Extract a string from a ResolvedValue for an ajax-call-js fact.
// Handles: direct string (action arg), object with `action` prop, or object with `data.action`.
function extractAjaxAction(v: ResolvedValue): string | null {
  if (v.kind === 'string') return v.value;
  if (v.kind === 'object') {
    // Try `action` property directly (e.g. ajax.post(action, data))
    const action = v.props['action'];
    if (typeof action === 'string') return action;
    if (action !== undefined && typeof action === 'object' && action.kind === 'string') return action.value;
    // Try `data.action` nested (e.g. jQuery.ajax({ data: { action: '...' } }))
    const data = v.props['data'];
    if (data !== undefined && typeof data !== 'string' && data.kind === 'object') {
      const nestedAction = data.props['action'];
      if (typeof nestedAction === 'string') return nestedAction;
      if (nestedAction !== undefined && typeof nestedAction === 'object' && nestedAction.kind === 'string') return nestedAction.value;
    }
  }
  return null;
}

// Post-extraction, pre-derive cross-file pass: resolve unresolved
// ajax-call-js / rest-call-js caller arguments interprocedurally and flip
// the facts to resolved.
export function runJsResolve(db: Database.Database, opts: JsResolveOptions): JsResolveSummary {
  const { projectRoot } = opts;

  // Step 1: load the worklist.
  const worklist = db.prepare(
    `SELECT f.id, f.kind, f.start_line, f.end_line, fl.path, f.payload
       FROM fact f JOIN file fl ON f.file_id = fl.id
      WHERE f.kind IN ('ajax-call-js', 'rest-call-js') AND f.resolved = 0`,
  ).all() as WorklistRow[];

  if (worklist.length === 0) return { examined: 0, resolved: 0 };

  // Step 2: build the ts.Program over the distinct seed files.
  const seedAbsFiles = [...new Set(worklist.map((r) => join(projectRoot, r.path)))];

  let program: ts.Program;
  let checker: ts.TypeChecker;
  try {
    const rp = buildResolutionProgram(seedAbsFiles, projectRoot);
    program = rp.program;
    checker = rp.checker;
  } catch {
    // Program build failed — leave all facts unresolved.
    return { examined: worklist.length, resolved: 0 };
  }

  // Step 3: build the localized-globals index.
  const localized = buildLocalizedGlobals(db);

  const oldAnchorStmt = db.prepare(
    `SELECT fa.anchor_id, a.key, fa.role FROM fact_anchor fa
       JOIN anchor a ON a.id = fa.anchor_id
      WHERE fa.fact_id = ? AND a.key LIKE '%{*}%'`,
  );

  let resolved = 0;

  for (const row of worklist) {
    try {
      const absPath = join(projectRoot, row.path);
      const sf = program.getSourceFile(absPath);
      if (sf === undefined) continue;

      const call = findCallAtLine(sf, row.start_line);
      if (call === null || call.arguments.length === 0) continue;

      // Resolve argument 0. For ajax patterns that bind data at arg 1 we fall
      // back to arg 1 when arg 0 resolution yields nothing useful.
      const arg0 = call.arguments[0];
      if (arg0 === undefined) continue;

      const v = resolveExpression(arg0, checker, {
        depth: 0,
        projectRoot,
        localized: localized.lookup.bind(localized),
      });

      let resolvedStr: string | null = null;
      if (row.kind === 'rest-call-js') {
        resolvedStr = extractRestPath(v);
      } else {
        // ajax-call-js: try arg 0 first, then arg 1 (data arg in jQuery.post, $.get, etc.)
        resolvedStr = extractAjaxAction(v);
        if (resolvedStr === null) {
          const arg1 = call.arguments[1];
          if (arg1 !== undefined) {
            const v1 = resolveExpression(arg1, checker, {
              depth: 0,
              projectRoot,
              localized: localized.lookup.bind(localized),
            });
            resolvedStr = extractAjaxAction(v1);
          }
        }
      }

      // Only resolve when the result is a clean literal with no dynamic part.
      if (resolvedStr === null || resolvedStr.includes('{*}')) continue;

      // Find the placeholder anchor(s) for this fact.
      const oldAnchors = oldAnchorStmt.all(row.id) as OldAnchorRow[];
      if (oldAnchors.length === 0) continue;

      // Build the new anchor key by replacing `{*}` in the old key.
      // For rest-call-js the old key is e.g. `rest:GET {*}` or `rest:GET /{*}`.
      // For ajax-call-js the old key is `ajax:{*}`.
      const oldAnchor = oldAnchors[0];
      if (oldAnchor === undefined) continue;

      let newKey: string;
      if (row.kind === 'rest-call-js') {
        // Extract the method from the old key prefix (e.g. `rest:GET ` before `{*}`).
        const prefixMatch = /^(rest:[A-Z]+ )/.exec(oldAnchor.key);
        const prefix = prefixMatch?.[1] ?? 'rest:GET ';
        newKey = prefix + resolvedStr;
      } else {
        newKey = `ajax:${resolvedStr}`;
      }

      const newAnchorId = upsertAnchor(db, {
        key: newKey,
        type: row.kind === 'rest-call-js' ? 'rest' : 'ajax',
      });

      for (const oa of oldAnchors) {
        repointFactAnchor(db, {
          factId: row.id,
          oldAnchorId: oa.anchor_id,
          newAnchorId,
          role: oa.role,
        });
      }

      // Build the updated payload: fill the route/action field, remove unresolved block,
      // stamp meta.resolvedBy.
      let payload: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(row.payload);
        payload = typeof parsed === 'object' && parsed !== null
          ? { ...(parsed as Record<string, unknown>) }
          : {};
      } catch {
        payload = {};
      }

      if (row.kind === 'rest-call-js') {
        payload['route'] = resolvedStr;
      } else {
        payload['action'] = resolvedStr;
      }
      delete payload['unresolved'];
      const priorMeta = typeof payload['meta'] === 'object' && payload['meta'] !== null
        ? payload['meta'] as Record<string, unknown>
        : {};
      payload['meta'] = { ...priorMeta, resolvedBy: 'js-interprocedural' };

      updateFactResolvedPayload(db, { factId: row.id, resolved: true, payload });
      resolved++;
    } catch {
      // A fact that throws during resolution is skipped, not fatal.
    }
  }

  return { examined: worklist.length, resolved };
}
