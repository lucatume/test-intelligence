import ts from 'typescript';
import type { Fact, FactLocation, SymbolDefPayload } from '../../facts/types.js';
import type { AnchorKey } from '../../types.js';

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
