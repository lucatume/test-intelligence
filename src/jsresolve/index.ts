import { join } from 'node:path';
import ts from 'typescript';
import type Database from 'better-sqlite3';
import type { JsResolveOptions, JsResolveSummary } from './types.js';
import { buildResolutionProgram, type ResolutionProgram } from './program.js';
import { resolveExpression, type ResolvedValue } from './resolver.js';
import { buildLocalizedGlobals } from './localized-globals.js';
import { AXIOS_METHODS as AXIOS_METHOD_NAMES } from '../extract/declarative/wp-js-patterns.js';
import { ACTION_IN_URL } from '../extract/declarative/engine.js';
import { type Result, ok, err } from '../result.js';
import {
  upsertAnchor, insertFactAnchor, repointFactAnchor, updateFactResolvedPayload,
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

// Callee → REST method, a faithful re-encoding of the anchor templates in
// WP_JS_PATTERNS (src/extract/declarative/wp-js-patterns.ts): `apiFetch` and
// `fetch` both hardcode GET; `axios.<m>` carries the method in the method
// name. The per-file extractor renders the method into the anchor template at
// extraction time; here the old anchor is usually absent, so the method is
// recovered from the located call's callee instead. The axios method set is
// imported from the pattern module so a new axios method stays in sync.
const AXIOS_METHODS: ReadonlySet<string> = new Set(AXIOS_METHOD_NAMES);

export function restMethodForCall(call: ts.CallExpression): string {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
    const recv = callee.expression;
    const name = callee.name.text;
    if (ts.isIdentifier(recv) && recv.text === 'axios' && AXIOS_METHODS.has(name)) {
      return name.toUpperCase();
    }
  }
  // apiFetch(...) / fetch(...) — WP_JS_PATTERNS hardcodes GET for both.
  return 'GET';
}

// REST-path normalization: the caller-side counterpart of `parseRest` in
// src/anchors/parse.ts (the authoritative `rest:` anchor-key contract). It is
// not a copy of `parseRest` — in addition it strips a scheme+host prefix and a
// mid-string `/wp-json` segment, then forces a leading slash, collapses
// repeated slashes, and trims a trailing slash. This makes a caller key align
// with the PHP `rest-endpoint` listener key (`rest:GET /<namespace><route>`).
function normRestPath(raw: string): string {
  let p = raw.trim();
  p = p.replace(/^[a-z]+:\/\/[^/]+/, '');
  const i = p.indexOf('/wp-json');
  if (i !== -1) p = p.slice(i + '/wp-json'.length);
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/+/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

// Unwrap a ResolvedValue string-node or bare string to a plain string. Returns
// null for any other shape. Used by extractRestPath and extractAjaxAction to
// avoid repeating the same two-branch unwrap inline.
function asString(v: ResolvedValue | string): string | null {
  if (typeof v === 'string') return v;
  if (v.kind === 'string') return v.value;
  return null;
}

// Extract a string from a ResolvedValue for a rest-call-js fact.
// Drills the `path` property of an object if needed.
function extractRestPath(v: ResolvedValue): string | null {
  const direct = asString(v);
  if (direct !== null) return direct;
  if (v.kind === 'object') {
    const p = v.props['path'];
    if (p !== undefined) return asString(p);
  }
  return null;
}

// Extract a string from a ResolvedValue for an ajax-call-js fact.
// Handles: direct string (action arg), object with `action` prop, or object with `data.action`.
// When the resolved string looks like a URL, ACTION_IN_URL extracts the action
// token (e.g. "https://…?action=wc_x" → "wc_x"). A bare action token never
// contains "?action=" / "&action=", so this only fires for URL-shaped strings.
function extractAjaxAction(v: ResolvedValue): string | null {
  const direct = asString(v);
  if (direct !== null) {
    const m = ACTION_IN_URL.exec(direct);
    return m !== null && m[1] !== undefined ? m[1] : direct;
  }
  if (v.kind === 'object') {
    // Try `action` property directly (e.g. ajax.post(action, data))
    const action = v.props['action'];
    if (action !== undefined) {
      const s = asString(action);
      if (s !== null) return s;
    }
    // Try `data.action` nested (e.g. jQuery.ajax({ data: { action: '...' } }))
    const data = v.props['data'];
    if (data !== undefined && typeof data !== 'string' && data.kind === 'object') {
      const nestedAction = data.props['action'];
      if (nestedAction !== undefined) return asString(nestedAction);
    }
  }
  return null;
}

// Wrap the fallible program build in a Result. buildResolutionProgram is
// Task-5 code with a throwing signature; a build failure (bad tsconfig,
// unreadable seed) is an expected failure mode, not an invariant violation,
// so it is captured here rather than propagated as a throw.
function tryBuildResolutionProgram(
  seedAbsFiles: readonly string[],
  projectRoot: string,
): Result<ResolutionProgram, Error> {
  try {
    return ok(buildResolutionProgram(seedAbsFiles, projectRoot));
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
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

  const programResult = tryBuildResolutionProgram(seedAbsFiles, projectRoot);
  if (programResult.kind === 'err') {
    // Program build failed — degrade: leave all facts unresolved.
    return { examined: worklist.length, resolved: 0 };
  }
  const { program, checker } = programResult.value;

  // Step 3: build the localized-globals index.
  const localized = buildLocalizedGlobals(db);

  const oldAnchorStmt = db.prepare(
    `SELECT fa.anchor_id, a.key, fa.role FROM fact_anchor fa
       JOIN anchor a ON a.id = fa.anchor_id
      WHERE fa.fact_id = ? AND a.key LIKE '%{*}%'`,
  );

  let resolved = 0;

  for (const row of worklist) {
    // Plan-mandated non-fatal per-fact skip: a fact that throws during
    // resolution is skipped, not fatal — this is not a convention violation.
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
        // This is a heuristic — it does not consult the pattern that actually matched.
        // It works for the current WP_JS_PATTERNS set: url-first patterns ($.post, $.get)
        // keep the action in arg 0 (URL) or arg 1 (data object); action-first patterns
        // (wp.ajax.post) keep it in arg 0 as a bare string.
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

      // Build the resolved anchor key matching the PHP-listener keys
      // (`ajax-listener` → `ajax:<action>`, `rest-endpoint` → `rest:<M> <path>`).
      // The method cannot be read from a (usually absent) old anchor — derive
      // it from the located call's callee.
      let newKey: string;
      if (row.kind === 'rest-call-js') {
        newKey = `rest:${restMethodForCall(call)} ${normRestPath(resolvedStr)}`;
      } else {
        newKey = `ajax:${resolvedStr}`;
      }

      const newAnchorId = upsertAnchor(db, {
        key: newKey,
        type: row.kind === 'rest-call-js' ? 'rest' : 'ajax',
      });

      // The fact may or may not carry a `{*}` placeholder anchor. When it does
      // (template-literal / `+`-concat shapes) repoint it; when it does not —
      // the dominant case for an unresolvable identifier argument, which leaves
      // the fact with zero anchors — insert a fresh `target` link. The
      // ajax-call-js / rest-call-js patterns all declare role 'target'.
      const oldAnchors = oldAnchorStmt.all(row.id) as OldAnchorRow[];
      if (oldAnchors.length > 0) {
        for (const oa of oldAnchors) {
          repointFactAnchor(db, {
            factId: row.id,
            oldAnchorId: oa.anchor_id,
            newAnchorId,
            role: oa.role,
          });
        }
      } else {
        insertFactAnchor(db, { factId: row.id, anchorId: newAnchorId, role: 'target' });
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
        payload['method'] = restMethodForCall(call);
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
