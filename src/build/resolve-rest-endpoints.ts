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
import {
  insertFact,
  insertFactAnchor,
  updateFactResolvedPayload,
  repointFactAnchor,
  upsertAnchor,
} from '../store/writers.js';

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
  /** inherited endpoint facts materialized on routing-property overrides. */
  readonly materialized: number;
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

interface ClassDef {
  readonly fileId: number;
  readonly startLine: number;
  readonly endLine: number;
}

interface ClassDefRow extends FilePayloadRow {
  readonly startLine: number;
  readonly endLine: number;
}

interface RestEndpointRow extends ClassDefRow {
  readonly resolved: number;
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
  const classDefByName = new Map<string, ClassDef>();
  for (const r of db.prepare(`
    SELECT file_id AS fileId, start_line AS startLine, end_line AS endLine, payload
    FROM fact WHERE kind = 'symbol-def'
  `).all() as ClassDefRow[]) {
    const p = safeParse(r.payload);
    const name = p?.['name'];
    if (typeof name === 'string' && !name.includes('::')) {
      const list = classesByFile.get(r.fileId) ?? [];
      list.push(name);
      classesByFile.set(r.fileId, list);
      classDefByName.set(name, {
        fileId: r.fileId,
        startLine: r.startLine,
        endLine: r.endLine,
      });
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
    const scope = unresolved['scope'];
    const fields = unresolved['fields'];
    if (typeof scope !== 'string' || !Array.isArray(fields)) continue;
    examined++;

    // The shared UnresolvedBlock's `scope` is `Class\Fqn::method` for a method
    // body; the inherited-property index is keyed by class FQN — strip a
    // trailing `::method`.
    const cls = scope.includes('::') ? scope.slice(0, scope.lastIndexOf('::')) : scope;
    // `fields` is now an array of { field, expression } — pull the field names.
    const fieldNames = fields
      .map((f) => (isRecord(f) ? f['field'] : undefined))
      .filter((f): f is string => typeof f === 'string');
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

  const materialized = materializeInheritedEndpoints(
    db,
    propsByClass,
    parentOf,
    classesByFile,
    classDefByName,
  );

  return { resolved, examined, materialized };
}

function materializeInheritedEndpoints(
  db: Database.Database,
  propsByClass: ReadonlyMap<string, Record<string, string>>,
  parentOf: ReadonlyMap<string, string>,
  classesByFile: ReadonlyMap<number, readonly string[]>,
  classDefByName: ReadonlyMap<string, ClassDef>,
): number {
  const endpointsByClass = new Map<string, RestEndpointRow[]>();
  for (const row of db.prepare(`
    SELECT file_id AS fileId, resolved, start_line AS startLine,
           end_line AS endLine, payload
    FROM fact WHERE kind = 'rest-endpoint'
  `).all() as RestEndpointRow[]) {
    const classes = classesByFile.get(row.fileId) ?? [];
    const owner = classes.length === 1 ? classes[0] : undefined;
    if (owner === undefined) continue;
    const endpoints = endpointsByClass.get(owner) ?? [];
    endpoints.push(row);
    endpointsByClass.set(owner, endpoints);
  }

  let materialized = 0;
  for (const [cls, directProps] of propsByClass) {
    if (
      (directProps['namespace'] === undefined && directProps['rest_base'] === undefined)
    ) continue;

    const inherited = findInheritedEndpoints(cls, parentOf, endpointsByClass);
    const classDef = classDefByName.get(cls);
    if (inherited === null || classDef === undefined) continue;

    const namespace = resolveInheritedProps(cls, ['namespace'], propsByClass, parentOf)?.['namespace'];
    if (namespace === undefined) continue;
    const childBase = resolveInheritedProps(cls, ['rest_base'], propsByClass, parentOf)?.['rest_base'];
    const parentBase = resolveInheritedProps(
      inherited.owner,
      ['rest_base'],
      propsByClass,
      parentOf,
    )?.['rest_base'];

    for (const endpoint of inherited.endpoints) {
      const payload = safeParse(endpoint.payload);
      if (payload?.['unresolved'] !== undefined) continue;
      const method = payload?.['method'];
      const oldNamespace = payload?.['namespace'];
      const oldRoute = payload?.['route'];
      if (
        typeof method !== 'string' ||
        typeof oldNamespace !== 'string' ||
        typeof oldRoute !== 'string'
      ) continue;

      let route = oldRoute;
      if (childBase !== undefined && parentBase !== undefined && childBase !== parentBase) {
        const rebased = rebaseRestRoute(route, parentBase, childBase);
        if (rebased === null) continue;
        route = rebased;
      }
      if (namespace === oldNamespace && route === oldRoute) continue;

      const anchorBody = collapseRouteParams(joinRestRoute(namespace, route));
      const routeParam = anchorBody.includes('{*}');
      const nextPayload: Record<string, unknown> = {
        ...payload,
        namespace,
        route,
        inheritedFrom: inherited.owner,
      };
      if (routeParam) nextPayload['routeParam'] = true;
      else delete nextPayload['routeParam'];

      const factId = insertFact(db, {
        fileId: classDef.fileId,
        kind: 'rest-endpoint',
        resolved: !routeParam,
        startLine: classDef.startLine,
        endLine: classDef.endLine,
        payload: nextPayload,
      });
      const anchorId = upsertAnchor(db, {
        key: `rest:${method} ${anchorBody}`,
        type: 'rest',
      });
      insertFactAnchor(db, { factId, anchorId, role: 'subject' });
      materialized++;
    }
  }
  return materialized;
}

function findInheritedEndpoints(
  cls: string,
  parentOf: ReadonlyMap<string, string>,
  endpointsByClass: ReadonlyMap<string, readonly RestEndpointRow[]>,
): { owner: string; endpoints: readonly RestEndpointRow[] } | null {
  const seen = new Set<string>();
  let parent = parentOf.get(cls);
  let depth = 0;
  while (parent !== undefined && depth < MAX_INHERITANCE_DEPTH) {
    if (seen.has(parent)) return null;
    seen.add(parent);
    const endpoints = endpointsByClass.get(parent);
    if (endpoints !== undefined) return { owner: parent, endpoints };
    parent = parentOf.get(parent);
    depth++;
  }
  return null;
}

function rebaseRestRoute(route: string, oldBase: string, newBase: string): string | null {
  const oldPrefix = `/${oldBase.replace(/^\/+|\/+$/g, '')}`;
  if (route !== oldPrefix && !route.startsWith(`${oldPrefix}/`)) return null;
  const newPrefix = `/${newBase.replace(/^\/+|\/+$/g, '')}`;
  return newPrefix + route.slice(oldPrefix.length);
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
