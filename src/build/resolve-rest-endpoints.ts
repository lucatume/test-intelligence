// Cross-file resolver for rest-endpoint facts whose namespace / route base is
// an inherited class property. Runs after extraction, before derive.
//
// The PHP worker extracts one file at a time, so a leaf REST controller whose
// $this->namespace is assigned in a parent class's constructor cannot be
// resolved per-file. After every file's facts are in the store, this pass
// walks the `extends` chain (carried by symbol-use facts tagged
// meta.rel='extends') and fills the inherited property from the nearest
// ancestor whose symbol-def carries it in meta.props.
//
// joinRestRoute / collapseRouteParams are a TS port of emitRestRouteFacts in
// vendor-php/bin/ti-php-extract.php — kept in parity by the fixture tests.

import type Database from 'better-sqlite3';
import { updateFactResolvedPayload, repointFactAnchor, upsertAnchor } from '../store/writers.js';

const MAX_INHERITANCE_DEPTH = 64;

/** Join a REST namespace and route exactly as the PHP worker does. */
export function joinRestRoute(namespace: string, route: string): string {
  const ns = namespace.replace(/\/+$/, '');
  const rt = route.replace(/^\/+/, '').replace(/\/+$/, '');
  const joined = '/' + ns + (rt === '' ? '' : '/' + rt);
  return joined.replace(/\/+/g, '/');
}

/** Collapse every PCRE named-group route param — (?P<n>…), (?<n>…) — to {*}.
 *  Brace-matched: tracks paren depth, treats [...] as a char-class span where
 *  ( and ) are literal. Port of the PHP collapseRouteParams scanner. */
export function collapseRouteParams(route: string): string {
  let out = '';
  let i = 0;
  const len = route.length;
  while (i < len) {
    const isNamed = route.startsWith('(?P<', i) || route.startsWith('(?<', i);
    if (!isNamed) {
      out += route.charAt(i);
      i++;
      continue;
    }
    let depth = 0;
    let inClass = false;
    while (i < len) {
      const ch = route.charAt(i);
      if (inClass) {
        if (ch === ']') inClass = false;
      } else if (ch === '[') {
        inClass = true;
      } else if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
        if (depth === 0) { i++; break; }
      }
      i++;
    }
    out += '{*}';
  }
  return out;
}

/** Walk the extends chain from `startClass` upward, resolving each name in
 *  `fields` to the value from the nearest class that declares it. Returns the
 *  full field→value map, or null if any field is unresolvable (chain exhausted,
 *  cycle, or depth cap). Nearest wins — matches PHP property shadowing. */
export function resolveInheritedProps(
  startClass: string,
  fields: readonly string[],
  propsByClass: ReadonlyMap<string, Record<string, string>>,
  parentOf: ReadonlyMap<string, string>,
): Record<string, string> | null {
  const out: Record<string, string> = {};
  const remaining = new Set(fields);
  const seen = new Set<string>();
  let cls: string | undefined = startClass;
  let depth = 0;
  while (cls !== undefined && remaining.size > 0 && depth < MAX_INHERITANCE_DEPTH) {
    if (seen.has(cls)) break; // cycle
    seen.add(cls);
    const props = propsByClass.get(cls);
    if (props !== undefined) {
      for (const field of [...remaining]) {
        const v = props[field];
        if (v !== undefined) {
          out[field] = v;
          remaining.delete(field);
        }
      }
    }
    cls = parentOf.get(cls);
    depth++;
  }
  return remaining.size === 0 ? out : null;
}

export interface ResolveRestSummary {
  /** rest-endpoint facts whose anchor was rewritten with the resolved namespace. */
  readonly resolved: number;
  /** annotated rest-endpoint facts examined. */
  readonly examined: number;
}

interface PayloadRow {
  readonly payload: string;
}

interface FilePayloadRow {
  readonly fileId: number;
  readonly payload: string;
}

interface IdPayloadRow {
  readonly id: number;
  readonly payload: string;
}

interface AnchorIdRow {
  readonly anchorId: number;
}

// Resolve every annotated rest-endpoint fact in the store. Mutates fact rows
// and fact_anchor rows in place. Caller is responsible for the transaction.
export function resolveRestEndpoints(db: Database.Database): ResolveRestSummary {
  // 1. Class property maps from symbol-def meta.props.
  const propsByClass = new Map<string, Record<string, string>>();
  for (const r of db.prepare(`SELECT payload FROM fact WHERE kind = 'symbol-def'`).all() as PayloadRow[]) {
    const p = safeParse(r.payload);
    const name = p?.['name'];
    if (typeof name !== 'string' || name.includes('::')) continue;
    const meta = p?.['meta'];
    const props = isRecord(meta) ? meta['props'] : undefined;
    if (isRecord(props)) {
      const filtered: Record<string, string> = {};
      for (const [key, val] of Object.entries(props)) if (typeof val === 'string') filtered[key] = val;
      propsByClass.set(name, filtered);
    } else if (!propsByClass.has(name)) {
      propsByClass.set(name, {});
    }
  }

  // 2. extends graph from symbol-use facts tagged meta.rel='extends'. The child
  //    class is the unique class symbol-def in the same file; WP controllers
  //    are one class per file. When a file declares several classes the pairing
  //    is ambiguous — skip it (leave the fact unresolved) rather than guess.
  const classesByFile = new Map<number, string[]>();
  for (const r of db.prepare(`SELECT file_id AS fileId, payload FROM fact WHERE kind = 'symbol-def'`).all() as FilePayloadRow[]) {
    const p = safeParse(r.payload);
    const name = p?.['name'];
    if (typeof name === 'string' && !name.includes('::')) {
      const list = classesByFile.get(r.fileId) ?? [];
      list.push(name);
      classesByFile.set(r.fileId, list);
    }
  }
  const parentOf = new Map<string, string>();
  for (const r of db.prepare(`SELECT file_id AS fileId, payload FROM fact WHERE kind = 'symbol-use'`).all() as FilePayloadRow[]) {
    const p = safeParse(r.payload);
    const meta = p?.['meta'];
    if (!isRecord(meta) || meta['rel'] !== 'extends') continue;
    const parent = p?.['name'];
    if (typeof parent !== 'string') continue;
    const classes = classesByFile.get(r.fileId) ?? [];
    if (classes.length === 1 && classes[0] !== undefined) {
      parentOf.set(classes[0], parent);
    }
  }

  // 3. Resolve each annotated rest-endpoint fact.
  let resolved = 0;
  let examined = 0;
  for (const r of db.prepare(`SELECT id, payload FROM fact WHERE kind = 'rest-endpoint' AND resolved = 0`).all() as IdPayloadRow[]) {
    const p = safeParse(r.payload);
    if (p === null) continue;
    const unresolved = p['unresolved'];
    if (!isRecord(unresolved)) continue;
    const cls = unresolved['class'];
    const fields = unresolved['fields'];
    if (typeof cls !== 'string' || !Array.isArray(fields)) continue;
    examined++;

    const fieldNames = fields.filter((f): f is string => typeof f === 'string');
    const route = typeof p['route'] === 'string' ? p['route'] : '';
    const method = typeof p['method'] === 'string' ? p['method'] : 'GET';

    // Scope: only the namespace-only, literal-route case is fully resolvable.
    // A route base that is itself a $this->prop miss leaves a {*} in the route
    // that the resolver cannot reconstruct (it does not know which concat slot
    // the property filled) — that is the out-of-scope ctor-argument follow-up.
    const namespaceOnly = fieldNames.length === 1 && fieldNames[0] === 'namespace' && !route.includes('{*}');
    if (!namespaceOnly) continue;

    const filled = resolveInheritedProps(cls, ['namespace'], propsByClass, parentOf);
    if (filled === null) continue;
    const newNamespace = filled['namespace'];
    if (newNamespace === undefined) continue;

    const joined = joinRestRoute(newNamespace, route);
    const anchorBody = collapseRouteParams(joined);
    const routeParam = anchorBody.includes('{*}');
    const newKey = `rest:${method} ${anchorBody}`;
    const resolvedFrom = findOwner(cls, 'namespace', propsByClass, parentOf);

    const newPayload: Record<string, unknown> = { ...p, namespace: newNamespace };
    delete newPayload['unresolved'];
    if (resolvedFrom !== null) newPayload['resolvedFrom'] = resolvedFrom;
    if (routeParam) newPayload['routeParam'] = true;
    else delete newPayload['routeParam'];

    updateFactResolvedPayload(db, { factId: r.id, resolved: !routeParam, payload: newPayload });

    const oldAnchors = db.prepare(`SELECT anchor_id AS anchorId FROM fact_anchor WHERE fact_id = ? AND role = 'subject'`).all(r.id) as AnchorIdRow[];
    const newAnchorId = upsertAnchor(db, { key: newKey, type: 'rest' });
    for (const oa of oldAnchors) {
      repointFactAnchor(db, { factId: r.id, oldAnchorId: oa.anchorId, newAnchorId, role: 'subject' });
    }
    resolved++;
  }

  return { resolved, examined };
}

/** The nearest class up the chain (incl. start) that declares `field`. */
function findOwner(
  startClass: string,
  field: string,
  propsByClass: ReadonlyMap<string, Record<string, string>>,
  parentOf: ReadonlyMap<string, string>,
): string | null {
  const seen = new Set<string>();
  let cls: string | undefined = startClass;
  let depth = 0;
  while (cls !== undefined && depth < MAX_INHERITANCE_DEPTH) {
    if (seen.has(cls)) return null;
    seen.add(cls);
    if (propsByClass.get(cls)?.[field] !== undefined) return cls;
    cls = parentOf.get(cls);
    depth++;
  }
  return null;
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(s);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
