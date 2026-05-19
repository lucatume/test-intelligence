import ts from 'typescript';

export type ResolvedValue =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'object'; readonly props: Readonly<Record<string, ResolvedValue | string>> }
  | { readonly kind: 'unresolved' };

export interface ResolveCtx {
  readonly depth: number;
  readonly projectRoot: string;
  // Optional localized-globals lookup, injected in Task 7. Unused here.
  readonly localized?: (objectName: string, file: string) => Readonly<Record<string, string>> | null;
}

const MAX_DEPTH = 12;

const UNRESOLVED: ResolvedValue = { kind: 'unresolved' };

// Resolve a JS/TS expression to a literal value using the TypeChecker for
// cross-file symbol resolution. Returns { kind: 'unresolved' } for anything
// dynamic — never a {*} skeleton, never a guess.
export function resolveExpression(
  node: ts.Expression,
  checker: ts.TypeChecker,
  ctx: ResolveCtx,
): ResolvedValue {
  return resolveNode(node, checker, ctx, new WeakMap<ts.Node, ResolvedValue>());
}

type Memo = WeakMap<ts.Node, ResolvedValue>;

function resolveNode(node: ts.Expression, checker: ts.TypeChecker, ctx: ResolveCtx, memo: Memo): ResolvedValue {
  // Depth check runs BEFORE the memo is consulted or written. This keeps the
  // memo sound despite MAX_DEPTH making a result technically depth-dependent:
  // a node's value is written to the memo only on a path that did not hit the
  // cap, so a cached value is always the full, depth-independent result and is
  // safe to reuse at any depth.
  if (ctx.depth > MAX_DEPTH) return UNRESOLVED;

  const cached = memo.get(node);
  if (cached !== undefined) return cached;
  // Guard against recursion cycles: a node currently being resolved maps to
  // 'unresolved' until its real value is computed.
  memo.set(node, UNRESOLVED);

  const value = computeNode(node, checker, ctx, memo);
  memo.set(node, value);
  return value;
}

function computeNode(node: ts.Expression, checker: ts.TypeChecker, ctx: ResolveCtx, memo: Memo): ResolvedValue {
  // String literal / no-substitution template.
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { kind: 'string', value: node.text };
  }

  // Wrappers that are runtime-inert.
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return resolveNode(node.expression, checker, descend(ctx), memo);
  }

  // Template literal with substitutions — fold every part.
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const part = resolveNode(span.expression, checker, descend(ctx), memo);
      if (part.kind !== 'string') return UNRESOLVED;
      out += part.value + span.literal.text;
    }
    return { kind: 'string', value: out };
  }

  // `+` concatenation — fold both sides; any unresolved part poisons the whole.
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveNode(node.left, checker, descend(ctx), memo);
    const right = resolveNode(node.right, checker, descend(ctx), memo);
    if (left.kind === 'string' && right.kind === 'string') {
      return { kind: 'string', value: left.value + right.value };
    }
    return UNRESOLVED;
  }

  // Object literal.
  if (ts.isObjectLiteralExpression(node)) {
    return resolveObjectLiteral(node, checker, ctx, memo);
  }

  // Identifier — follow its symbol to a declaration.
  if (ts.isIdentifier(node)) {
    return resolveIdentifier(node, checker, ctx, memo);
  }

  // Call expression — resolve the callee's return expression.
  if (ts.isCallExpression(node)) {
    return resolveCallReturn(node, checker, ctx, memo);
  }

  return UNRESOLVED;
}

function descend(ctx: ResolveCtx): ResolveCtx {
  return { ...ctx, depth: ctx.depth + 1 };
}

function resolveObjectLiteral(
  node: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
  ctx: ResolveCtx,
  memo: Memo,
): ResolvedValue {
  const props: Record<string, ResolvedValue | string> = {};
  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const name = propertyName(prop.name);
      if (name === null) continue;
      const value = resolveNode(prop.initializer, checker, descend(ctx), memo);
      props[name] = flatten(value);
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      const sym = checker.getShorthandAssignmentValueSymbol(prop);
      if (sym !== undefined) {
        const value = resolveSymbol(sym, checker, descend(ctx), memo);
        props[prop.name.text] = flatten(value);
      }
    }
  }
  return { kind: 'object', props };
}

// The `props` record stores a string directly when the property is a plain
// string, otherwise the nested ResolvedValue. The test reads `props['path']`
// expecting a string.
function flatten(v: ResolvedValue): ResolvedValue | string {
  return v.kind === 'string' ? v.value : v;
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return null;
}

function resolveIdentifier(
  node: ts.Identifier,
  checker: ts.TypeChecker,
  ctx: ResolveCtx,
  memo: Memo,
): ResolvedValue {
  const sym = checker.getSymbolAtLocation(node);
  if (sym === undefined) return UNRESOLVED;
  return resolveSymbol(sym, checker, descend(ctx), memo);
}

function resolveSymbol(
  sym: ts.Symbol,
  checker: ts.TypeChecker,
  ctx: ResolveCtx,
  memo: Memo,
): ResolvedValue {
  if (ctx.depth > MAX_DEPTH) return UNRESOLVED;

  // Follow import / re-export aliases cross-file.
  let resolved = sym;
  if ((sym.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      resolved = checker.getAliasedSymbol(sym);
    } catch {
      resolved = sym;
    }
  }

  const decls = resolved.declarations;
  if (decls === undefined || decls.length === 0) return UNRESOLVED;

  // A symbol with multiple declarations resolves only when they agree: if two
  // declarations resolve to differing values the symbol is ambiguous →
  // unresolved (mirrors the every-return-path rule in resolveCallReturn). The
  // common single-declaration case (a `const` / import) is unaffected.
  let result: ResolvedValue = UNRESOLVED;
  for (const decl of decls) {
    const value = resolveDeclaration(decl, checker, ctx, memo);
    if (value.kind === 'unresolved') continue;
    if (result.kind === 'unresolved') {
      result = value;
    } else if (!sameValue(result, value)) {
      return UNRESOLVED;
    }
  }
  return result;
}

function resolveDeclaration(
  decl: ts.Declaration,
  checker: ts.TypeChecker,
  ctx: ResolveCtx,
  memo: Memo,
): ResolvedValue {
  // const x = <expr>
  if (ts.isVariableDeclaration(decl) && decl.initializer !== undefined) {
    return resolveNode(decl.initializer, checker, descend(ctx), memo);
  }
  // { key: <expr> }
  if (ts.isPropertyAssignment(decl)) {
    return resolveNode(decl.initializer, checker, descend(ctx), memo);
  }
  // export { x as y }
  if (ts.isExportSpecifier(decl)) {
    const target = checker.getExportSpecifierLocalTargetSymbol(decl);
    if (target !== undefined) return resolveSymbol(target, checker, descend(ctx), memo);
  }
  // import { x } from '...'
  if (ts.isImportSpecifier(decl)) {
    const sym = checker.getSymbolAtLocation(decl.name);
    if (sym !== undefined && (sym.flags & ts.SymbolFlags.Alias) !== 0) {
      try {
        return resolveSymbol(checker.getAliasedSymbol(sym), checker, descend(ctx), memo);
      } catch {
        return UNRESOLVED;
      }
    }
  }
  // function-parameter — bind from the unique call site.
  if (ts.isParameter(decl) && ts.isIdentifier(decl.name)) {
    return resolveParameter(decl, checker, ctx, memo);
  }
  return UNRESOLVED;
}

// A parameter resolves from same-file call sites only when the enclosing
// function is *module-private* — not exported and never used as a value — so
// the resolver can prove it has seen every call site. If exactly one such call
// site passes a resolvable argument in the matching slot, the parameter binds
// to it; more than one distinct call site is ambiguous → unresolved.
function resolveParameter(
  param: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
  ctx: ResolveCtx,
  memo: Memo,
): ResolvedValue {
  // A default value is used only when there is no overriding call argument;
  // call-site binding takes precedence, so try that first.
  const fn = param.parent;
  if (
    !ts.isFunctionDeclaration(fn) &&
    !ts.isFunctionExpression(fn) &&
    !ts.isArrowFunction(fn) &&
    !ts.isMethodDeclaration(fn)
  ) {
    return resolveParamDefault(param, checker, ctx, memo);
  }

  const index = fn.parameters.indexOf(param);
  if (index < 0) return resolveParamDefault(param, checker, ctx, memo);

  const fnSym = fn.name !== undefined ? checker.getSymbolAtLocation(fn.name) : undefined;
  if (fnSym === undefined) return resolveParamDefault(param, checker, ctx, memo);

  // Unsound for non-module-private functions: an exported function (or one
  // whose name escapes as a value) can be called from modules absent from the
  // scoped program, so a same-file call-site scan is not exhaustive. Without a
  // provably complete scan, a parameter must not bind.
  if (!isModulePrivateFunction(fn, fnSym, checker)) {
    return resolveParamDefault(param, checker, ctx, memo);
  }

  const argNodes = collectCallArguments(fnSym, fn, index, checker);
  if (argNodes.length === 1 && argNodes[0] !== undefined) {
    return resolveNode(argNodes[0], checker, descend(ctx), memo);
  }
  return resolveParamDefault(param, checker, ctx, memo);
}

// A function is module-private when its call sites can be fully enumerated
// within its own source file: it carries no `export` modifier (an
// `export default` counts as exported) and its name is never referenced as a
// value — i.e. every identifier resolving to its symbol appears only as the
// callee of a CallExpression. If the name escapes (passed as a callback,
// assigned, returned, …) the function may be called from anywhere and the
// same-file scan is incomplete.
function isModulePrivateFunction(
  fn: ts.SignatureDeclaration,
  fnSym: ts.Symbol,
  checker: ts.TypeChecker,
): boolean {
  const modifiers = ts.canHaveModifiers(fn) ? ts.getModifiers(fn) : undefined;
  if (modifiers !== undefined) {
    for (const mod of modifiers) {
      if (mod.kind === ts.SyntaxKind.ExportKeyword || mod.kind === ts.SyntaxKind.DefaultKeyword) {
        return false;
      }
    }
  }

  let escapes = false;
  const sf = fn.getSourceFile();
  const visit = (n: ts.Node): void => {
    if (escapes) return;
    if (ts.isIdentifier(n) && checker.getSymbolAtLocation(n) === fnSym) {
      const parent = n.parent;
      const isCallee = ts.isCallExpression(parent) && parent.expression === n;
      const isOwnName = parent === fn;
      if (!isCallee && !isOwnName) {
        escapes = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return !escapes;
}

function resolveParamDefault(
  param: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
  ctx: ResolveCtx,
  memo: Memo,
): ResolvedValue {
  if (param.initializer !== undefined) {
    return resolveNode(param.initializer, checker, descend(ctx), memo);
  }
  return UNRESOLVED;
}

// Collect the argument expression in slot `index` from every call of `fn`.
// Only the function's own source file is scanned. The caller has already
// proven `fn` is module-private (see `isModulePrivateFunction`), so the home
// file holds every call site and this scan is exhaustive.
function collectCallArguments(
  fnSym: ts.Symbol,
  fn: ts.SignatureDeclaration,
  index: number,
  checker: ts.TypeChecker,
): ts.Expression[] {
  const out: ts.Expression[] = [];
  const sf = fn.getSourceFile();
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const calleeSym = checker.getSymbolAtLocation(n.expression);
      if (calleeSym === fnSym) {
        const arg = n.arguments[index];
        if (arg !== undefined) out.push(arg);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function resolveCallReturn(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  ctx: ResolveCtx,
  memo: Memo,
): ResolvedValue {
  let sig: ts.Signature | undefined;
  try {
    sig = checker.getResolvedSignature(node);
  } catch {
    return UNRESOLVED;
  }
  if (sig === undefined) return UNRESOLVED;

  const decl = sig.declaration;
  if (
    decl === undefined ||
    (!ts.isFunctionDeclaration(decl) &&
      !ts.isFunctionExpression(decl) &&
      !ts.isArrowFunction(decl) &&
      !ts.isMethodDeclaration(decl))
  ) {
    return UNRESOLVED;
  }

  const body = decl.body;
  if (body === undefined) return UNRESOLVED;

  // Arrow function with a concise (expression) body.
  if (!ts.isBlock(body)) {
    return resolveNode(body, checker, descend(ctx), memo);
  }

  const returns: ts.Expression[] = [];
  collectReturnExpressions(body, returns);
  if (returns.length === 0) return UNRESOLVED;

  const values = returns.map((r) => resolveNode(r, checker, descend(ctx), memo));
  // Every return path must resolve to the same value.
  const first = values[0];
  if (first === undefined || first.kind === 'unresolved') return UNRESOLVED;
  for (const v of values) {
    if (!sameValue(v, first)) return UNRESOLVED;
  }
  return first;
}

function collectReturnExpressions(node: ts.Node, out: ts.Expression[]): void {
  if (ts.isReturnStatement(node)) {
    if (node.expression !== undefined) out.push(node.expression);
    return;
  }
  // Do not descend into nested function scopes — their returns are not ours.
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  ) {
    return;
  }
  ts.forEachChild(node, (child) => {
    collectReturnExpressions(child, out);
  });
}

function sameValue(a: ResolvedValue, b: ResolvedValue): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'string' && b.kind === 'string') return a.value === b.value;
  if (a.kind === 'object' && b.kind === 'object') {
    const ak = Object.keys(a.props);
    const bk = Object.keys(b.props);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      const av = a.props[k];
      const bv = b.props[k];
      if (typeof av === 'string' || typeof bv === 'string') {
        if (av !== bv) return false;
      } else if (av === undefined || bv === undefined || !sameValue(av, bv)) {
        return false;
      }
    }
    return true;
  }
  return a.kind === 'unresolved' && b.kind === 'unresolved';
}
