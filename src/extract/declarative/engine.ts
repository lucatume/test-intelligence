import ts from 'typescript';
import type { Fact, FactAnchorRef, FactLocation, FactPayload, UnresolvedExpr } from '../../facts/types.js';
import type { AnchorKey } from '../../types.js';
import type { UserPattern } from './pattern.js';
import { exprHash } from './exprHash.js';

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

// Strips runtime-inert wrappers — `as const` / `as T`, `satisfies`, grouping
// parentheses, the non-null `!` — to expose the underlying expression. `as
// const` on a string constant is idiomatic modern TS; without this its
// initializer is an `AsExpression`, not a `StringLiteral`, and the constant
// never enters the resolution map.
function unwrap(n: ts.Expression): ts.Expression {
  if (
    ts.isAsExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isParenthesizedExpression(n) ||
    ts.isNonNullExpression(n)
  ) {
    return unwrap(n.expression);
  }
  return n;
}

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
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) {
      const init = unwrap(n.initializer);
      if (isLiteralInitializer(init)) {
        // Last-writer-wins: a later declaration overwrites an earlier one.
        map.set(n.name.text, init);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return map;
}

// Resolves a bare identifier to its same-file literal initializer (depth-1: if
// the initializer is itself an identifier, it is not chased further).
function resolveExpression(n: ts.Expression, inits: LiteralInitMap): ts.Expression {
  const u = unwrap(n);
  if (ts.isIdentifier(u)) {
    const init = inits.get(u.text);
    if (init !== undefined && !ts.isIdentifier(init)) return init;
  }
  return u;
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

// Enclosing function / class::method of a node, or '(file)' for file scope.
// Closures/arrow functions resolve to the nearest named enclosing scope —
// mirroring the PHP worker — so the scope string is edit-stable.
function enclosingScope(n: ts.Node): string {
  let fnName: string | null = null;
  // `ts.Node.parent` is typed non-optional but is undefined at the SourceFile
  // root; cast through `unknown` so the loop terminates without a type clash.
  let cur = n.parent as ts.Node | undefined;
  while (cur !== undefined) {
    if (ts.isFunctionDeclaration(cur) && cur.name !== undefined && fnName === null) {
      fnName = cur.name.text;
    } else if (
      ts.isMethodDeclaration(cur) &&
      ts.isIdentifier(cur.name) &&
      fnName === null
    ) {
      fnName = cur.name.text;
    } else if (ts.isClassDeclaration(cur) && cur.name !== undefined) {
      return fnName !== null ? cur.name.text + '::' + fnName : cur.name.text;
    }
    cur = cur.parent;
  }
  return fnName ?? '(file)';
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

export const ACTION_IN_URL = /[?&]action=([A-Za-z0-9_-]+)/;

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

const REST_URL_RE = /(?:^|\b)wp-json(\/[^?#]*)/;
const NORMALISED_REST_RE = /^\/[A-Za-z0-9_-]+\/v\d+(?:\/|$)/;

/**
 * Strip the `./`, leading `/`, scheme + host, the `/wp-json/` prefix, and any
 * `?query`/`#fragment` from a Playwright `request.<method>(url)` value, leaving
 * the namespaced REST path that matches PHP-side `register_rest_route` anchors.
 *
 * Returns null when the URL is empty or has no `/wp-json/` segment AND does not
 * already look like a namespaced REST path — in which case it is not a REST
 * call and the fact should be dropped.
 */
function restUrlNormalise(url: string): string | null {
  if (url === '') return null;
  const m = REST_URL_RE.exec(url);
  if (m !== null && m[1] !== undefined) {
    const path = m[1];
    const qIdx = path.indexOf('?');
    const hIdx = path.indexOf('#');
    const end = [qIdx, hIdx].filter((i) => i >= 0).reduce((a, b) => Math.min(a, b), path.length);
    const stripped = path.slice(0, end);
    return stripped === '' ? null : stripped;
  }
  // Already-normalised case: `/wc/v3/customers`. The regex above only matches
  // strings that contain `wp-json`; a bare namespaced REST path passes through
  // unchanged. URLs like `/wp-admin/admin.php` do not match the namespace
  // shape and stay rejected.
  if (NORMALISED_REST_RE.test(url)) {
    const qIdx = url.indexOf('?');
    const hIdx = url.indexOf('#');
    const end = [qIdx, hIdx].filter((i) => i >= 0).reduce((a, b) => Math.min(a, b), url.length);
    return url.slice(0, end);
  }
  return null;
}

// Test-only export — never call this from production code.
export const __testRestUrlNormalise = restUrlNormalise;

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

const CORE_ADMIN_PAGES: ReadonlySet<string> = new Set([
  'index.php',
  'edit.php',
  'edit-tags.php',
  'post.php',
  'post-new.php',
  'upload.php',
  'media-new.php',
  'themes.php',
  'theme-editor.php',
  'plugins.php',
  'plugin-editor.php',
  'users.php',
  'user-new.php',
  'profile.php',
  'tools.php',
  'options-general.php',
  'options-writing.php',
  'options-reading.php',
  'options-discussion.php',
  'options-media.php',
  'options-permalink.php',
  'admin.php',
]);

function adminPageSlugFromUrlOrSlug(value: string): string | null {
  if (value === '') return null;
  // Strip a leading `/wp-admin/` or `./wp-admin/` prefix.
  const trimmed = value.replace(/^\.?\/?wp-admin\//, '');
  // 1) `admin.php?page=<slug>` → <slug>.
  if (trimmed.startsWith('admin.php')) {
    const m = /[?&]page=([A-Za-z0-9_-]+)/.exec(trimmed);
    if (m !== null && m[1] !== undefined) return m[1];
    // bare 'admin.php' with no page= is ambiguous — suppress.
    return null;
  }
  // 2) A core wp-admin page name with or without trailing query.
  const head = trimmed.split('?', 1)[0] ?? trimmed;
  if (CORE_ADMIN_PAGES.has(head)) return head;
  return null;
}

// Test-only export.
export const __testAdminPageSlugFromUrlOrSlug = adminPageSlugFromUrlOrSlug;

function applyPattern(
  m: MatchedCall,
  p: UserPattern,
  sf: ts.SourceFile,
  relPath: string,
  inits: LiteralInitMap,
): Fact | null {
  const startLine = sf.getLineAndCharacterOfPosition(m.node.getStart(sf)).line + 1;
  const endLine = sf.getLineAndCharacterOfPosition(m.node.getEnd()).line + 1;
  const scope = enclosingScope(m.node);

  const fields: Record<string, unknown> = { kind: p.emit };
  let resolved = true;
  const argNodes: readonly ts.Expression[] = m.node.arguments ?? [];
  const failed: { field: string; node: ts.Expression | undefined }[] = [];

  for (const [fieldName, binding] of Object.entries(p.bind)) {
    const rawArg = argNodes[binding.arg];
    const argNode = rawArg !== undefined ? resolveExpression(rawArg, inits) : undefined;
    const value = argNode !== undefined ? readLiteral(argNode, binding.type, inits) : (binding.default ?? null);
    const isWildcard = typeof value === 'string' && value.includes('{*}');
    if ((value === null || isWildcard) && binding.optional !== true) {
      resolved = false;
      failed.push({ field: fieldName, node: rawArg });
    }
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
  if (p.transform === 'rest-url-normalise') {
    const url = fields['url'];
    if (typeof url !== 'string') return null;
    const normalised = restUrlNormalise(url);
    if (normalised === null) return null;
    fields['url'] = normalised;
  }
  if (p.transform === 'admin-page-slug-from-url-or-slug') {
    fields['method'] = m.name;
    const raw = fields['adminPath'] ?? fields['url'];
    if (typeof raw !== 'string') return null;
    const slug = adminPageSlugFromUrlOrSlug(raw);
    if (slug === null) return null;
    fields['slug'] = slug;
  }
  if (resolved && containsWildcard(fields)) resolved = false;

  const anchors: FactAnchorRef[] = [];
  if (p.anchor !== undefined) {
    const key = renderTemplate(p.anchor.template, fields);
    if (key !== null) anchors.push({ key: key as AnchorKey, role: p.anchor.role });
    else resolved = false;
  }

  // Phase 0: stamp the partial-fact resolution context onto an unresolved fact.
  // Captures the un-skeletonized argument source text per failing field, the
  // enclosing scope, and a stable content hash. Additive metadata only.
  if (!resolved && failed.length > 0) {
    const unresolvedFields: UnresolvedExpr[] = failed.map((f) => ({
      field: f.field,
      expression: f.node !== undefined ? f.node.getText(sf) : '',
    }));
    fields['unresolved'] = {
      scope,
      fields: unresolvedFields,
      exprHash: exprHash(scope, unresolvedFields),
    };
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
function foldConcat(expr: ts.Expression): string | null {
  const n = unwrap(expr);
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return templateLiteralSkeleton(n);
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
  const out = tpl.replace(/\{([^}]+)\}/g, (match: string, name: string): string => {
    // `{*}` is the wildcard sentinel used elsewhere in the engine; leave it as
    // a literal so anchor templates can embed it (e.g., `rest:DELETE /wp/v2/posts/{*}`).
    if (name === '*') return match;
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
