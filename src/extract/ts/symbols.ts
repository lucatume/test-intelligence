import { relative, sep } from 'node:path';
import ts from 'typescript';
import type { Fact, FactLocation, SymbolDefPayload, SymbolUsePayload } from '../../facts/types.js';
import type { AnchorKey, FrameworkName } from '../../types.js';

interface SymbolEntry {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly exported: boolean;
}

export function extractSymbols(sf: ts.SourceFile, relPath: string): Fact[] {
  const entries = new Map<string, SymbolEntry>();
  const add = (name: string, node: ts.Node, exported: boolean): void => {
    const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    const prev = entries.get(name);
    entries.set(name, { name, start, end, exported: exported || (prev?.exported ?? false) });
  };

  for (const stmt of sf.statements) {
    const e = isExport(stmt);
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      add(stmt.name.text, stmt, e);
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      add(stmt.name.text, stmt, e);
      const className = stmt.name.text;
      for (const member of stmt.members) {
        if (
          (ts.isMethodDeclaration(member) ||
            ts.isGetAccessorDeclaration(member) ||
            ts.isSetAccessorDeclaration(member)) &&
          ts.isIdentifier(member.name)
        ) {
          add(`${className}#${member.name.text}`, member, false);
        }
      }
    } else if (ts.isInterfaceDeclaration(stmt)) {
      add(stmt.name.text, stmt, e);
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      add(stmt.name.text, stmt, e);
    } else if (ts.isEnumDeclaration(stmt)) {
      add(stmt.name.text, stmt, e);
    } else if (ts.isVariableStatement(stmt)) {
      const eVar = isExport(stmt);
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) add(d.name.text, stmt, eVar);
      }
    } else if (ts.isExportAssignment(stmt)) {
      add('default', stmt, true);
    } else if (ts.isFunctionDeclaration(stmt) && hasDefault(stmt) && !stmt.name) {
      add('default', stmt, true);
    } else if (ts.isClassDeclaration(stmt) && hasDefault(stmt) && !stmt.name) {
      add('default', stmt, true);
    }
  }
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const spec of stmt.exportClause.elements) {
        const exportedName = spec.name.text;
        const local = spec.propertyName?.text ?? exportedName;
        const existing = entries.get(local);
        if (existing) {
          entries.set(exportedName, { ...existing, name: exportedName, exported: true });
        } else {
          add(exportedName, spec, true);
        }
      }
    }
  }

  const facts: Fact[] = [];
  for (const [, e] of entries) {
    const payload: SymbolDefPayload = { kind: 'symbol-def', name: e.name, exported: e.exported };
    const location: FactLocation = {
      file: relPath as FactLocation['file'],
      startLine: e.start,
      endLine: e.end,
    };
    facts.push({
      kind: 'symbol-def',
      resolved: true,
      location,
      anchors: [{ key: `js-symbol:${relPath}:${e.name}` as AnchorKey, role: 'subject' }],
      payload,
    });
  }
  return facts;
}

export function extractWpGlobalSymbols(
  sf: ts.SourceFile,
  relPath: string,
  framework?: FrameworkName | null,
): Fact[] {
  const emitted = new Map<string, Fact>();
  const directNamespaces = new Set<string>();
  const localMembers = new Map<string, Set<string>>();
  const collectNamespaces = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      const chain = wpChain(node);
      const parentExtendsChain = ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node;
      const assigned = ts.isBinaryExpression(node.parent) && node.parent.left === node
        && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
      if (chain?.length === 2 && !parentExtendsChain && !assigned) directNamespaces.add(chain.join('.'));
    }
    ts.forEachChild(node, collectNamespaces);
  };
  collectNamespaces(sf);
  const collectLocalMembers = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left)
    ) {
      const chain = localChain(node.left);
      if (chain !== null && chain.length > 1 && chain[0] !== 'wp' && chain[0] !== 'window') {
        const bucket = localMembers.get(chain[0] ?? '') ?? new Set<string>();
        bucket.add(chain.slice(1).join('.'));
        localMembers.set(chain[0] ?? '', bucket);
      }
    }
    ts.forEachChild(node, collectLocalMembers);
  };
  collectLocalMembers(sf);
  const emit = (kind: 'symbol-def' | 'symbol-use', name: string, node: ts.Node): void => {
    const role = kind === 'symbol-def' ? 'target' : 'subject';
    const key = kind === 'symbol-use' && framework != null
      ? `${kind}:${name}:${String(node.getStart(sf))}`
      : `${kind}:${name}`;
    if (emitted.has(key)) return;
    const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    emitted.set(key, {
      kind,
      resolved: true,
      location: { file: relPath as FactLocation['file'], startLine, endLine },
      anchors: [{ key: `js-global:${name}` as AnchorKey, role }],
      payload: kind === 'symbol-def'
        ? { kind, name, exported: true }
        : { kind, name },
    });
  };

  const walk = (node: ts.Node, functionDepth = 0): void => {
    const nextDepth = functionDepth + (ts.isFunctionLike(node) ? 1 : 0);
    if (ts.isPropertyAccessExpression(node)) {
      const chain = wpChain(node);
      const parentExtendsChain = ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node;
      if (chain !== null && !parentExtendsChain) {
        const assigned = ts.isBinaryExpression(node.parent)
          && node.parent.left === node
          && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
        const prefixes = chain.slice(1).map((_, i) => chain.slice(0, i + 2).join('.'));
        if (assigned && framework !== 'qunit' && functionDepth <= 1) {
          for (const name of prefixes) emit('symbol-def', name, node);
          const assignment = node.parent;
          const root = chain.join('.');
          if (ts.isObjectLiteralExpression(assignment.right)) {
            for (const property of assignment.right.properties) {
              if (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
                emit('symbol-def', `${root}.${property.name.text}`, property);
              }
            }
          } else if (ts.isIdentifier(assignment.right)) {
            for (const member of localMembers.get(assignment.right.text) ?? []) {
              emit('symbol-def', `${root}.${member}`, node);
            }
          }
        } else if (!assigned && (framework === undefined || framework === 'qunit')) {
          const root = chain.slice(0, 2).join('.');
          for (const name of prefixes.slice(Math.max(0, prefixes.length - 2))) {
            if (name !== root || chain.length === 2 || directNamespaces.has(root)) emit('symbol-use', name, node);
          }
        }
      }
    }
    ts.forEachChild(node, (child) => { walk(child, nextDepth); });
  };
  walk(sf);
  return [...emitted.values()];
}

function localChain(node: ts.PropertyAccessExpression): readonly string[] | null {
  const parts: string[] = [];
  let current: ts.Expression = node;
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text);
    current = current.expression;
  }
  if (!ts.isIdentifier(current)) return null;
  return [current.text, ...parts];
}

function wpChain(node: ts.PropertyAccessExpression): readonly string[] | null {
  const parts: string[] = [];
  let current: ts.Expression = node;
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text);
    current = current.expression;
  }
  if (ts.isIdentifier(current) && current.text === 'wp') return ['wp', ...parts];
  if (ts.isIdentifier(current) && current.text === 'window' && parts[0] === 'wp') return parts;
  return null;
}

interface ResolvedImport {
  readonly resolvedFile: string;
  readonly importedName: string;
}

// Emits `symbol-use` facts (role `target`) for call/new/JSX-component sites
// whose callee is an identifier resolvable to a `symbol-def` — either an
// import of a project file or a same-file top-level declaration. Unresolvable
// identifiers (globals, bare-package imports) produce no fact: there is no
// `symbol-def` to bridge to, so the fact would be pure noise.
export function extractSymbolUses(
  sf: ts.SourceFile,
  relPath: string,
  projectRoot: string,
  options: ts.CompilerOptions,
): Fact[] {
  const localNames = collectTopLevelNames(sf);
  const { names: importMap, namespaces: namespaceMap } = buildImportMap(sf, projectRoot, options);
  const classMethods = collectClassMethods(sf);
  const classStack: string[] = [];
  const emitted = new Map<string, { name: string; location: FactLocation }>();

  const recordUseAnchored = (anchorBody: string, name: string, node: ts.Node): void => {
    const key = `js-symbol:${anchorBody}`;
    if (emitted.has(key)) return;
    const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    emitted.set(key, {
      name,
      location: { file: relPath as FactLocation['file'], startLine: start, endLine: end },
    });
  };

  const recordUse = (name: string, node: ts.Node): void => {
    const imp = importMap.get(name);
    if (imp) {
      recordUseAnchored(`${imp.resolvedFile}:${imp.importedName}`, imp.importedName, node);
    } else if (localNames.has(name)) {
      recordUseAnchored(`${relPath}:${name}`, name, node);
    }
  };

  const tryNamespaceMember = (expr: ts.Expression, node: ts.Node): void => {
    if (!ts.isPropertyAccessExpression(expr)) return;
    if (!ts.isIdentifier(expr.expression)) return;
    const resolvedFile = namespaceMap.get(expr.expression.text);
    if (resolvedFile === undefined) return;
    const member = expr.name.text;
    recordUseAnchored(`${resolvedFile}:${member}`, member, node);
  };

  const walk = (n: ts.Node): void => {
    const className = ts.isClassDeclaration(n) && n.name ? n.name.text : undefined;
    if (className !== undefined) classStack.push(className);

    if (ts.isCallExpression(n)) {
      if (ts.isIdentifier(n.expression)) {
        recordUse(n.expression.text, n);
      } else if (
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const method = n.expression.name.text;
        const enclosing = classStack[classStack.length - 1];
        if (enclosing !== undefined && classMethods.get(enclosing)?.has(method)) {
          recordUseAnchored(`${relPath}:${enclosing}#${method}`, `${enclosing}#${method}`, n);
        }
      } else {
        tryNamespaceMember(n.expression, n);
      }
    } else if (ts.isNewExpression(n)) {
      if (ts.isIdentifier(n.expression)) {
        recordUse(n.expression.text, n);
      } else {
        tryNamespaceMember(n.expression, n);
      }
    } else if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      if (ts.isIdentifier(n.tagName)) {
        recordUse(n.tagName.text, n);
      } else if (ts.isPropertyAccessExpression(n.tagName)) {
        tryNamespaceMember(n.tagName, n);
      }
    }

    ts.forEachChild(n, walk);
    if (className !== undefined) classStack.pop();
  };
  walk(sf);

  const facts: Fact[] = [];
  for (const [key, { name, location }] of emitted) {
    const payload: SymbolUsePayload = { kind: 'symbol-use', name };
    facts.push({
      kind: 'symbol-use',
      resolved: true,
      location,
      anchors: [{ key: key as AnchorKey, role: 'target' }],
      payload,
    });
  }
  return facts;
}

function collectTopLevelNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) names.add(stmt.name.text);
    else if (ts.isClassDeclaration(stmt) && stmt.name) names.add(stmt.name.text);
    else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) names.add(d.name.text);
      }
    }
  }
  return names;
}

function collectClassMethods(sf: ts.SourceFile): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const walk = (n: ts.Node): void => {
    if (ts.isClassDeclaration(n) && n.name) {
      const names = new Set<string>();
      for (const member of n.members) {
        if (
          (ts.isMethodDeclaration(member) ||
            ts.isGetAccessorDeclaration(member) ||
            ts.isSetAccessorDeclaration(member)) &&
          ts.isIdentifier(member.name)
        ) {
          names.add(member.name.text);
        }
      }
      map.set(n.name.text, names);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return map;
}

function buildImportMap(
  sf: ts.SourceFile,
  projectRoot: string,
  options: ts.CompilerOptions,
): { names: Map<string, ResolvedImport>; namespaces: Map<string, string> } {
  const map = new Map<string, ResolvedImport>();
  const namespaces = new Map<string, string>();
  const host = ts.createCompilerHost(options, true);

  const resolveSpecifier = (specifier: string): string | undefined => {
    const resolved = ts.resolveModuleName(specifier, sf.fileName, options, host);
    if (!resolved.resolvedModule) return undefined;
    const rel = toPosix(relative(projectRoot, resolved.resolvedModule.resolvedFileName));
    if (rel.startsWith('..') || rel.startsWith('/')) return undefined;
    return rel;
  };

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const clause = stmt.importClause;
    if (!clause) continue;
    const resolvedFile = resolveSpecifier(stmt.moduleSpecifier.text);
    if (resolvedFile === undefined) continue;
    if (clause.name) {
      map.set(clause.name.text, { resolvedFile, importedName: 'default' });
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        const importedName = el.propertyName?.text ?? el.name.text;
        map.set(el.name.text, { resolvedFile, importedName });
      }
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      namespaces.set(clause.namedBindings.name.text, resolvedFile);
    }
  }
  return { names: map, namespaces };
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function isExport(n: ts.Node): boolean {
  return (
    ts.canHaveModifiers(n) &&
    !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function hasDefault(n: ts.Node): boolean {
  return (
    ts.canHaveModifiers(n) &&
    !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
  );
}
