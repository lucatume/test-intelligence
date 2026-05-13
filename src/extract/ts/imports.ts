import { relative, sep } from 'node:path';
import ts from 'typescript';
import type { Fact, FactLocation, ImportEdgePayload } from '../../facts/types.js';
import type { AnchorKey } from '../../types.js';

interface SpecifierRef {
  readonly specifier: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly pos: number;
}

export function extractImports(
  sf: ts.SourceFile,
  relPath: string,
  projectRoot: string,
  options: ts.CompilerOptions,
): Fact[] {
  const out: Fact[] = [];
  const host = ts.createCompilerHost(options, true);
  const seen = new Set<string>();

  collectSpecifiers(sf, (ref) => {
    const key = `${ref.specifier}@${String(ref.pos)}`;
    if (seen.has(key)) return;
    seen.add(key);

    const resolved = ts.resolveModuleName(ref.specifier, sf.fileName, options, host);
    let resolvedRel: string | undefined;
    if (resolved.resolvedModule) {
      const abs = resolved.resolvedModule.resolvedFileName;
      const rel = toPosix(relative(projectRoot, abs));
      if (!rel.startsWith('..') && !rel.startsWith('/')) resolvedRel = rel;
    }

    const anchorBody = resolvedRel ?? ref.specifier;
    const payload: ImportEdgePayload = {
      kind: 'import-edge',
      specifier: ref.specifier,
      resolved: resolvedRel !== undefined,
      ...(resolvedRel !== undefined ? { resolvedPath: resolvedRel } : {}),
    };

    const location: FactLocation = {
      file: relPath as FactLocation['file'],
      startLine: ref.startLine,
      endLine: ref.endLine,
    };

    out.push({
      kind: 'import-edge',
      resolved: resolvedRel !== undefined,
      location,
      anchors: [{ key: `js-module:${anchorBody}` as AnchorKey, role: 'module' }],
      payload,
    });
  });
  return out;
}

function collectSpecifiers(sf: ts.SourceFile, visit: (r: SpecifierRef) => void): void {
  const walk = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      visit(refFor(n.moduleSpecifier, sf));
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      visit(refFor(n.moduleSpecifier, sf));
    } else if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const arg = n.arguments[0];
      if (arg && ts.isStringLiteral(arg)) visit(refFor(arg, sf));
    } else if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'require'
    ) {
      const arg = n.arguments[0];
      if (arg && ts.isStringLiteral(arg)) visit(refFor(arg, sf));
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
}

function refFor(node: ts.StringLiteral, sf: ts.SourceFile): SpecifierRef {
  const pos = node.getStart(sf);
  const start = sf.getLineAndCharacterOfPosition(pos).line + 1;
  const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return { specifier: node.text, startLine: start, endLine: end, pos };
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}
