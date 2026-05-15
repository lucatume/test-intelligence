import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applyInitialSchema } from '../../src/store/migrations.js';
import { upsertFile, insertFact, upsertAnchor, insertFactAnchor } from '../../src/store/writers.js';
import {
  joinRestRoute,
  collapseRouteParams,
  resolveInheritedProps,
  resolveRestEndpoints,
} from '../../src/build/resolve-rest-endpoints.js';

describe('joinRestRoute', () => {
  it('joins namespace and route with single slashes', () => {
    expect(joinRestRoute('wp/v2', '/items')).toBe('/wp/v2/items');
  });
  it('strips trailing namespace and leading/trailing route slashes', () => {
    expect(joinRestRoute('wp/v2/', '/items/')).toBe('/wp/v2/items');
  });
  it('collapses slash runs from an empty route', () => {
    expect(joinRestRoute('wp/v2', '')).toBe('/wp/v2');
  });
});

describe('collapseRouteParams', () => {
  it('collapses a named regex param to {*}', () => {
    expect(collapseRouteParams('/wp/v2/comments/(?P<id>\\d+)')).toBe('/wp/v2/comments/{*}');
  });
  it('collapses a nested-group param', () => {
    expect(collapseRouteParams('/x/(?P<id>(\\d+))')).toBe('/x/{*}');
  });
  it('collapses a char-class param containing a paren', () => {
    expect(collapseRouteParams('/x/(?P<id>[\\d)]+)')).toBe('/x/{*}');
  });
  it('collapses the P-less named form', () => {
    expect(collapseRouteParams('/x/(?<slug>[a-z-]+)')).toBe('/x/{*}');
  });
  it('passes a literal route through unchanged', () => {
    expect(collapseRouteParams('/wp/v2/items')).toBe('/wp/v2/items');
  });
});

describe('resolveInheritedProps', () => {
  const propsByClass = new Map<string, Record<string, string>>([
    ['Leaf', {}],
    ['Mid', { rest_base: 'mid-base' }],
    ['Root', { namespace: 'wp/v2', rest_base: 'root-base' }],
  ]);
  const parentOf = new Map<string, string>([
    ['Leaf', 'Mid'],
    ['Mid', 'Root'],
  ]);

  it('resolves from the nearest ancestor that has each property', () => {
    const r = resolveInheritedProps('Leaf', ['namespace', 'rest_base'], propsByClass, parentOf);
    expect(r).toEqual({ namespace: 'wp/v2', rest_base: 'mid-base' });
  });

  it('returns null when a property is unresolvable up the whole chain', () => {
    const r = resolveInheritedProps('Leaf', ['namespace', 'missing'], propsByClass, parentOf);
    expect(r).toBeNull();
  });

  it('returns null on a cycle without resolving', () => {
    const cyclic = new Map<string, string>([['A', 'B'], ['B', 'A']]);
    const empty = new Map<string, Record<string, string>>([['A', {}], ['B', {}]]);
    expect(resolveInheritedProps('A', ['namespace'], empty, cyclic)).toBeNull();
  });

  it('resolves a property declared on the start class itself', () => {
    const r = resolveInheritedProps('Mid', ['rest_base'], propsByClass, parentOf);
    expect(r).toEqual({ rest_base: 'mid-base' });
  });
});

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  applyInitialSchema(db);
  return db;
}

const NOW = '2026-05-15T00:00:00.000Z';

describe('resolveRestEndpoints', () => {
  it('fills an inherited namespace and re-points the anchor', () => {
    const db = freshDb();
    const parentFile = upsertFile(db, { path: 'parent.php', language: 'php', contentHash: 'h1', extractedAt: NOW, isTest: false, framework: null, frameworkClass: null });
    insertFact(db, { fileId: parentFile, kind: 'symbol-def', resolved: true, startLine: 1, endLine: 1, payload: { kind: 'symbol-def', name: 'Parent_Ctl', exported: true, meta: { props: { namespace: 'wp/v2' } } } });

    const childFile = upsertFile(db, { path: 'child.php', language: 'php', contentHash: 'h2', extractedAt: NOW, isTest: false, framework: null, frameworkClass: null });
    insertFact(db, { fileId: childFile, kind: 'symbol-def', resolved: true, startLine: 1, endLine: 1, payload: { kind: 'symbol-def', name: 'Child_Ctl', exported: true } });
    const extUseId = insertFact(db, { fileId: childFile, kind: 'symbol-use', resolved: true, startLine: 1, endLine: 1, payload: { kind: 'symbol-use', name: 'Parent_Ctl', meta: { rel: 'extends' } } });
    const parentAnchor = upsertAnchor(db, { key: 'php-symbol:Parent_Ctl', type: 'php-symbol' });
    insertFactAnchor(db, { factId: extUseId, anchorId: parentAnchor, role: 'subject' });

    const restId = insertFact(db, { fileId: childFile, kind: 'rest-endpoint', resolved: false, startLine: 2, endLine: 2, payload: { kind: 'rest-endpoint', method: 'GET', route: '/items', namespace: '{*}', unresolved: { class: 'Child_Ctl', fields: ['namespace'] } } });
    const skelAnchor = upsertAnchor(db, { key: 'rest:GET /{*}/items', type: 'rest' });
    insertFactAnchor(db, { factId: restId, anchorId: skelAnchor, role: 'subject' });

    const summary = resolveRestEndpoints(db);
    expect(summary.resolved).toBe(1);

    const fact = db.prepare('SELECT resolved, payload FROM fact WHERE id = ?').get(restId) as { resolved: number; payload: string };
    expect(fact.resolved).toBe(1);
    const payload = JSON.parse(fact.payload) as { namespace: string; unresolved?: unknown; resolvedFrom?: string };
    expect(payload.namespace).toBe('wp/v2');
    expect(payload.unresolved).toBeUndefined();
    expect(payload.resolvedFrom).toBe('Parent_Ctl');

    const anchorRow = db.prepare('SELECT a.key FROM fact_anchor fa JOIN anchor a ON a.id = fa.anchor_id WHERE fa.fact_id = ?').get(restId) as { key: string };
    expect(anchorRow.key).toBe('rest:GET /wp/v2/items');
  });

  it('leaves a fact unresolved when no ancestor has the property', () => {
    const db = freshDb();
    const f = upsertFile(db, { path: 'lone.php', language: 'php', contentHash: 'h', extractedAt: NOW, isTest: false, framework: null, frameworkClass: null });
    insertFact(db, { fileId: f, kind: 'symbol-def', resolved: true, startLine: 1, endLine: 1, payload: { kind: 'symbol-def', name: 'Lone_Ctl', exported: true } });
    const restId = insertFact(db, { fileId: f, kind: 'rest-endpoint', resolved: false, startLine: 2, endLine: 2, payload: { kind: 'rest-endpoint', method: 'GET', route: '/items', namespace: '{*}', unresolved: { class: 'Lone_Ctl', fields: ['namespace'] } } });
    const a = upsertAnchor(db, { key: 'rest:GET /{*}/items', type: 'rest' });
    insertFactAnchor(db, { factId: restId, anchorId: a, role: 'subject' });
    const summary = resolveRestEndpoints(db);
    expect(summary.resolved).toBe(0);
    const fact = db.prepare('SELECT resolved FROM fact WHERE id = ?').get(restId) as { resolved: number };
    expect(fact.resolved).toBe(0);
  });

  it('walks a multi-level chain, nearest ancestor wins', () => {
    const db = freshDb();
    // Root declares namespace='wp/v2'; Leaf extends Mid extends Root.
    const rootF = upsertFile(db, { path: 'root.php', language: 'php', contentHash: 'r', extractedAt: NOW, isTest: false, framework: null, frameworkClass: null });
    insertFact(db, { fileId: rootF, kind: 'symbol-def', resolved: true, startLine: 1, endLine: 1, payload: { kind: 'symbol-def', name: 'Root', exported: true, meta: { props: { namespace: 'wp/v2' } } } });
    const midF = upsertFile(db, { path: 'mid.php', language: 'php', contentHash: 'm', extractedAt: NOW, isTest: false, framework: null, frameworkClass: null });
    insertFact(db, { fileId: midF, kind: 'symbol-def', resolved: true, startLine: 1, endLine: 1, payload: { kind: 'symbol-def', name: 'Mid', exported: true } });
    const midUse = insertFact(db, { fileId: midF, kind: 'symbol-use', resolved: true, startLine: 1, endLine: 1, payload: { kind: 'symbol-use', name: 'Root', meta: { rel: 'extends' } } });
    insertFactAnchor(db, { factId: midUse, anchorId: upsertAnchor(db, { key: 'php-symbol:Root', type: 'php-symbol' }), role: 'subject' });
    const leafF = upsertFile(db, { path: 'leaf.php', language: 'php', contentHash: 'l', extractedAt: NOW, isTest: false, framework: null, frameworkClass: null });
    insertFact(db, { fileId: leafF, kind: 'symbol-def', resolved: true, startLine: 1, endLine: 1, payload: { kind: 'symbol-def', name: 'Leaf', exported: true } });
    const leafUse = insertFact(db, { fileId: leafF, kind: 'symbol-use', resolved: true, startLine: 1, endLine: 1, payload: { kind: 'symbol-use', name: 'Mid', meta: { rel: 'extends' } } });
    insertFactAnchor(db, { factId: leafUse, anchorId: upsertAnchor(db, { key: 'php-symbol:Mid', type: 'php-symbol' }), role: 'subject' });
    const restId = insertFact(db, { fileId: leafF, kind: 'rest-endpoint', resolved: false, startLine: 2, endLine: 2, payload: { kind: 'rest-endpoint', method: 'GET', route: '/x', namespace: '{*}', unresolved: { class: 'Leaf', fields: ['namespace'] } } });
    insertFactAnchor(db, { factId: restId, anchorId: upsertAnchor(db, { key: 'rest:GET /{*}/x', type: 'rest' }), role: 'subject' });

    const summary = resolveRestEndpoints(db);
    expect(summary.resolved).toBe(1);
    const anchorRow = db.prepare('SELECT a.key FROM fact_anchor fa JOIN anchor a ON a.id = fa.anchor_id WHERE fa.fact_id = ?').get(restId) as { key: string };
    expect(anchorRow.key).toBe('rest:GET /wp/v2/x');
  });
});
