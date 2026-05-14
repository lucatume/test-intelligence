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

  const walk = (n: ts.Node): void => {
    const matched = matchNode(n);
    if (matched !== null) {
      for (const p of tsPatterns) {
        if (!matchesPattern(matched, p)) continue;
        facts.push(applyPattern(matched, p, sf, relPath));
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return facts;
}

function matchNode(n: ts.Node): MatchedCall | null {
  if (ts.isCallExpression(n)) {
    if (ts.isIdentifier(n.expression)) {
      return { node: n, name: n.expression.text, receiver: null };
    }
    if (ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.name)) {
      const recv = ts.isIdentifier(n.expression.expression) ? n.expression.expression.text : null;
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

function applyPattern(m: MatchedCall, p: UserPattern, sf: ts.SourceFile, relPath: string): Fact {
  const startLine = sf.getLineAndCharacterOfPosition(m.node.getStart(sf)).line + 1;
  const endLine = sf.getLineAndCharacterOfPosition(m.node.getEnd()).line + 1;

  const fields: Record<string, unknown> = { kind: p.emit };
  let resolved = true;
  const argNodes: readonly ts.Expression[] = m.node.arguments ?? [];

  for (const [fieldName, binding] of Object.entries(p.bind)) {
    const argNode = argNodes[binding.arg];
    const value = argNode !== undefined ? readLiteral(argNode, binding.type) : (binding.default ?? null);
    if (value === null && binding.optional !== true) resolved = false;
    if (value !== null) fields[fieldName] = value;
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

function readLiteral(n: ts.Expression, type: string): unknown {
  if (type === 'string') {
    if (ts.isStringLiteral(n)) return n.text;
    if (ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isTemplateExpression(n)) return templateLiteralSkeleton(n);
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
      const val = prop.initializer;
      if (ts.isStringLiteral(val) || ts.isNoSubstitutionTemplateLiteral(val)) {
        out[prop.name.text] = val.text;
      } else if (ts.isTemplateExpression(val)) {
        out[prop.name.text] = templateLiteralSkeleton(val);
      } else if (ts.isNumericLiteral(val)) {
        out[prop.name.text] = Number(val.text);
      } else if (val.kind === ts.SyntaxKind.TrueKeyword || val.kind === ts.SyntaxKind.FalseKeyword) {
        out[prop.name.text] = val.kind === ts.SyntaxKind.TrueKeyword;
      } else if (ts.isObjectLiteralExpression(val)) {
        out[prop.name.text] = readLiteral(val, 'object');
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
