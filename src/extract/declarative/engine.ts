import ts from 'typescript';
import type { Fact, FactAnchorRef, FactLocation, FactPayload } from '../../facts/types.js';
import type { AnchorKey } from '../../types.js';
import type { UserPattern } from './pattern.js';

interface MatchedCall {
  readonly node: ts.CallExpression | ts.NewExpression;
  readonly name: string;
  readonly receiver: string | null;
}

export function runDeclarativePatterns(
  sf: ts.SourceFile,
  relPath: string,
  patterns: readonly UserPattern[],
): Fact[] {
  if (patterns.length === 0) return [];
  const tsPatterns = patterns.filter((p) => p.match.lang !== 'php');
  if (tsPatterns.length === 0) return [];

  const facts: Fact[] = [];
  const inits = buildLiteralInitMap(sf);

  const walk = (n: ts.Node): void => {
    const matched = matchNode(n);
    if (matched !== null) {
      for (const p of tsPatterns) {
        if (!matchesPattern(matched, p)) continue;
        const fact = applyPattern(matched, p, sf, relPath, inits);
        if (fact !== null) facts.push(fact);
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return facts;
}

type LiteralInitMap = ReadonlyMap<string, ts.Expression>;

function isLiteralInitializer(n: ts.Expression): boolean {
  return (
    ts.isObjectLiteralExpression(n) ||
    ts.isStringLiteral(n) ||
    ts.isNoSubstitutionTemplateLiteral(n) ||
    ts.isTemplateExpression(n) ||
    ts.isNumericLiteral(n) ||
    n.kind === ts.SyntaxKind.TrueKeyword ||
    n.kind === ts.SyntaxKind.FalseKeyword
  );
}

function buildLiteralInitMap(sf: ts.SourceFile): LiteralInitMap {
  const map = new Map<string, ts.Expression>();
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer !== undefined &&
      isLiteralInitializer(n.initializer)
    ) {
      // Last-writer-wins: a later declaration overwrites an earlier one.
      map.set(n.name.text, n.initializer);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return map;
}

// Resolves a bare identifier to its same-file literal initializer (depth-1: if
// the initializer is itself an identifier, it is not chased further).
function resolveExpression(n: ts.Expression, inits: LiteralInitMap): ts.Expression {
  if (ts.isIdentifier(n)) {
    const init = inits.get(n.text);
    if (init !== undefined && !ts.isIdentifier(init)) return init;
  }
  return n;
}

function matchNode(n: ts.Node): MatchedCall | null {
  if (ts.isCallExpression(n)) {
    if (ts.isIdentifier(n.expression)) {
      return { node: n, name: n.expression.text, receiver: null };
    }
    if (ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.name)) {
      const inner = n.expression.expression;
      let recv: string | null = null;
      if (ts.isIdentifier(inner)) {
        recv = inner.text;
      } else if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.name)) {
        // Two-segment chain: wp.hooks.addAction → receiver is 'hooks'
        recv = inner.name.text;
      }
      return { node: n, name: n.expression.name.text, receiver: recv };
    }
    return null;
  }
  if (ts.isNewExpression(n) && ts.isIdentifier(n.expression)) {
    return { node: n, name: n.expression.text, receiver: null };
  }
  return null;
}

function matchesPattern(m: MatchedCall, p: UserPattern): boolean {
  if (m.name !== p.match.name) return false;
  switch (p.match.nodeKind) {
    case 'function-call':
      return ts.isCallExpression(m.node) && m.receiver === null;
    case 'method-call':
      if (!ts.isCallExpression(m.node) || m.receiver === null) return false;
      return p.match.receiver === undefined ? true : m.receiver === p.match.receiver;
    case 'static-call':
      if (!ts.isCallExpression(m.node) || m.receiver === null) return false;
      return p.match.receiver === undefined ? true : m.receiver === p.match.receiver;
    case 'new-expression':
      return ts.isNewExpression(m.node);
    case 'jsx-element':
      return false;
  }
}

const ACTION_IN_URL = /[?&]action=([A-Za-z0-9_-]+)/;

// Pulls an `action=<token>` substring out of a bound `url` skeleton into
// `fields.action`. Used by patterns whose AJAX action lives in the request URL.
function extractActionFromUrl(fields: Record<string, unknown>): void {
  const url = fields['url'];
  if (typeof url !== 'string') return;
  const m = ACTION_IN_URL.exec(url);
  if (m !== null && m[1] !== undefined && !m[1].includes('{*}')) {
    fields['action'] = m[1];
  }
}

const PAGE_SLUG_IN_URL = /[?&]page=([A-Za-z0-9_-]+)/;

// Pulls the WordPress admin-page slug out of a `page.goto`/`page.route` URL
// (program Phase 5). Returns true when an `admin.php?page=<slug>` slug was
// found and the admin-page-nav fact should be emitted; false otherwise (a
// wp-admin URL with no page= slug, e.g. edit.php, is not an admin-page nav).
function adminPageSlugFromUrl(fields: Record<string, unknown>): boolean {
  const url = fields['url'];
  if (typeof url !== 'string') return false;
  if (!url.includes('admin.php')) return false;
  const m = PAGE_SLUG_IN_URL.exec(url);
  if (m === null || m[1] === undefined) return false;
  fields['slug'] = m[1];
  return true;
}

function applyPattern(
  m: MatchedCall,
  p: UserPattern,
  sf: ts.SourceFile,
  relPath: string,
  inits: LiteralInitMap,
): Fact | null {
  const startLine = sf.getLineAndCharacterOfPosition(m.node.getStart(sf)).line + 1;
  const endLine = sf.getLineAndCharacterOfPosition(m.node.getEnd()).line + 1;

  const fields: Record<string, unknown> = { kind: p.emit };
  let resolved = true;
  const argNodes: readonly ts.Expression[] = m.node.arguments ?? [];

  for (const [fieldName, binding] of Object.entries(p.bind)) {
    const rawArg = argNodes[binding.arg];
    const argNode = rawArg !== undefined ? resolveExpression(rawArg, inits) : undefined;
    const value = argNode !== undefined ? readLiteral(argNode, binding.type, inits) : (binding.default ?? null);
    if (value === null && binding.optional !== true) resolved = false;
    if (value !== null) fields[fieldName] = value;
  }
  if (p.transform === 'ajax-action-from-url') {
    extractActionFromUrl(fields);
    // The URL skeleton has served its purpose; drop it so its residual {*}
    // does not flag the fact unresolved and so the payload stays clean.
    if (typeof fields['action'] === 'string') delete fields['url'];
  }
  if (p.transform === 'admin-page-slug-from-url') {
    // method is the navigation call name: 'goto' or 'route'.
    fields['method'] = m.name;
    // No page= slug → not an admin-page navigation; suppress the fact.
    if (!adminPageSlugFromUrl(fields)) return null;
  }
  if (resolved && containsWildcard(fields)) resolved = false;

  const anchors: FactAnchorRef[] = [];
  if (p.anchor !== undefined) {
    const key = renderTemplate(p.anchor.template, fields);
    if (key !== null) anchors.push({ key: key as AnchorKey, role: p.anchor.role });
    else resolved = false;
  }

  const location: FactLocation = {
    file: relPath as FactLocation['file'],
    startLine,
    endLine,
  };

  return {
    kind: p.emit,
    resolved,
    location,
    anchors,
    payload: fields as unknown as FactPayload,
  };
}

function templateLiteralSkeleton(n: ts.TemplateExpression): string {
  let out = n.head.text;
  for (const span of n.templateSpans) {
    out += '{*}';
    out += span.literal.text;
  }
  return out;
}

function containsWildcard(v: unknown): boolean {
  if (typeof v === 'string') return v.includes('{*}');
  if (v !== null && typeof v === 'object') {
    const rec = v as Record<string, unknown>;
    for (const k of Object.keys(rec)) {
      if (containsWildcard(rec[k])) return true;
    }
  }
  return false;
}

// Folds a `+` chain over string operands into a {*}-skeleton, preserving the
// literal segments. Returns null only when the chain has no string literal.
function foldConcat(n: ts.Expression): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return templateLiteralSkeleton(n);
  if (ts.isParenthesizedExpression(n)) return foldConcat(n.expression);
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldConcat(n.left);
    const right = foldConcat(n.right);
    if (left === null && right === null) return null;
    return (left ?? '{*}') + (right ?? '{*}');
  }
  return '{*}';
}

function readLiteral(n: ts.Expression, type: string, inits: LiteralInitMap): unknown {
  if (type === 'string') {
    if (ts.isStringLiteral(n)) return n.text;
    if (ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isTemplateExpression(n)) return templateLiteralSkeleton(n);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return foldConcat(n);
    }
    return null;
  }
  if (type === 'int' && ts.isNumericLiteral(n)) return Number(n.text);
  if (type === 'bool' && (n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword)) {
    return n.kind === ts.SyntaxKind.TrueKeyword;
  }
  if (type === 'object' && ts.isObjectLiteralExpression(n)) {
    const out: Record<string, unknown> = {};
    for (const prop of n.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
      const val = resolveExpression(prop.initializer, inits);
      if (ts.isStringLiteral(val) || ts.isNoSubstitutionTemplateLiteral(val)) {
        out[prop.name.text] = val.text;
      } else if (ts.isTemplateExpression(val)) {
        out[prop.name.text] = templateLiteralSkeleton(val);
      } else if (ts.isNumericLiteral(val)) {
        out[prop.name.text] = Number(val.text);
      } else if (val.kind === ts.SyntaxKind.TrueKeyword || val.kind === ts.SyntaxKind.FalseKeyword) {
        out[prop.name.text] = val.kind === ts.SyntaxKind.TrueKeyword;
      } else if (ts.isObjectLiteralExpression(val)) {
        out[prop.name.text] = readLiteral(val, 'object', inits);
      }
    }
    return out;
  }
  if (type === 'array' && ts.isArrayLiteralExpression(n)) return [];
  return null;
}

function renderTemplate(tpl: string, fields: Record<string, unknown>): string | null {
  const state = { ok: true };
  const out = tpl.replace(/\{([^}]+)\}/g, (_match: string, name: string): string => {
    const path = name.split('.');
    let cur: unknown = fields;
    for (const segment of path) {
      if (cur === null || typeof cur !== 'object') { state.ok = false; return ''; }
      cur = (cur as Record<string, unknown>)[segment];
    }
    if (cur === undefined || cur === null) { state.ok = false; return ''; }
    if (typeof cur === 'string') return cur;
    if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
    state.ok = false;
    return '';
  });
  return state.ok ? out : null;
}
